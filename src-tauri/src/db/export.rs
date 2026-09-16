//! Writers for exporting a result set to a file. The output matches the
//! frontend formatters in `src/lib/format.ts`, which handle the rows shown in
//! the grid; these run on the backend so that a complete result never has to
//! cross the IPC boundary.

use std::io::Write;

use serde::Deserialize;

use super::{CellValue, ColumnMeta};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

pub fn write_rows(
    out: &mut impl Write,
    format: ExportFormat,
    columns: &[ColumnMeta],
    rows: &[Vec<CellValue>],
) -> std::io::Result<()> {
    match format {
        ExportFormat::Csv => write_csv(out, columns, rows),
        ExportFormat::Json => write_json(out, columns, rows),
    }
}

/// A CSV field: null is empty, values containing `,`, `"`, `\n` or `\r` are quoted with inner quotes doubled.
fn csv_field(v: &CellValue) -> String {
    let s = match v {
        CellValue::Null => return String::new(),
        CellValue::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// CSV: a header row with the column names, `,` delimiter, `\n` between rows, no trailing newline.
fn write_csv(out: &mut impl Write, columns: &[ColumnMeta], rows: &[Vec<CellValue>]) -> std::io::Result<()> {
    let header: Vec<String> = columns
        .iter()
        .map(|c| csv_field(&CellValue::String(c.name.clone())))
        .collect();
    out.write_all(header.join(",").as_bytes())?;
    for row in rows {
        out.write_all(b"\n")?;
        let fields: Vec<String> = row.iter().map(csv_field).collect();
        out.write_all(fields.join(",").as_bytes())?;
    }
    Ok(())
}

/// JSON: an array of `{column: value}` objects indented with two spaces.
fn write_json(out: &mut impl Write, columns: &[ColumnMeta], rows: &[Vec<CellValue>]) -> std::io::Result<()> {
    let objects: Vec<serde_json::Map<String, CellValue>> = rows
        .iter()
        .map(|row| {
            columns
                .iter()
                .enumerate()
                .map(|(i, c)| (c.name.clone(), row.get(i).cloned().unwrap_or(CellValue::Null)))
                .collect()
        })
        .collect();
    serde_json::to_writer_pretty(out, &objects).map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn columns() -> Vec<ColumnMeta> {
        vec![
            ColumnMeta::simple("id", "INT", false),
            ColumnMeta::simple("name, full", "VARCHAR", true),
        ]
    }

    fn render(format: ExportFormat, rows: &[Vec<CellValue>]) -> String {
        let mut out = Vec::new();
        write_rows(&mut out, format, &columns(), rows).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn csv_quotes_like_the_frontend() {
        let rows = vec![
            vec![json!(1), json!("plain")],
            vec![json!(2), json!("say \"hi\", now\nplease")],
            vec![json!(3.5), CellValue::Null],
            vec![json!(true), json!("")],
        ];
        assert_eq!(
            render(ExportFormat::Csv, &rows),
            "id,\"name, full\"\n1,plain\n2,\"say \"\"hi\"\", now\nplease\"\n3.5,\ntrue,"
        );
    }

    #[test]
    fn csv_with_no_rows_is_just_the_header() {
        assert_eq!(render(ExportFormat::Csv, &[]), "id,\"name, full\"");
    }

    #[test]
    fn json_is_an_indented_array_of_objects() {
        let rows = vec![vec![json!(1), json!("a")], vec![json!(2), CellValue::Null]];
        assert_eq!(
            render(ExportFormat::Json, &rows),
            "[\n  {\n    \"id\": 1,\n    \"name, full\": \"a\"\n  },\n  {\n    \"id\": 2,\n    \"name, full\": null\n  }\n]"
        );
        assert_eq!(render(ExportFormat::Json, &[]), "[]");
    }

    #[test]
    fn json_pads_short_rows_with_null() {
        let rows = vec![vec![json!(1)]];
        assert!(render(ExportFormat::Json, &rows).contains("\"name, full\": null"));
    }
}
