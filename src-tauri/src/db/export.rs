//! Writers for exporting a result set to a file (CSV, JSON, Excel). CSV and
//! JSON match the clipboard formatters in `src/lib/format.ts`. Writers run on
//! the backend so that a complete result never has to cross the IPC boundary.

use std::fs::File;
use std::io::{BufWriter, Write};

use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::{CellValue, ColumnMeta};

/// Rows an Excel worksheet can hold, minus the header row.
pub const EXCEL_MAX_DATA_ROWS: usize = 1_048_575;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Xlsx,
}

impl ExportFormat {
    /// Checks limits that would otherwise surface as an obscure writer error.
    pub fn check_capacity(self, rows: usize) -> AppResult<()> {
        if self == ExportFormat::Xlsx && rows > EXCEL_MAX_DATA_ROWS {
            return Err(AppError::Other(format!(
                "An Excel sheet holds at most {EXCEL_MAX_DATA_ROWS} rows, the result has {rows}; export CSV or JSON instead"
            )));
        }
        Ok(())
    }
}

/// Rows already held by the frontend (the grid's contents), written as they are.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsExportRequest {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    pub format: ExportFormat,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub rows: usize,
}

pub fn export_rows(request: RowsExportRequest) -> AppResult<ExportSummary> {
    write_file(&request.path, request.format, &request.columns, &request.rows)?;
    Ok(ExportSummary {
        rows: request.rows.len(),
    })
}

/// Writes the rows to a new file at `path` (an existing file is replaced).
pub fn write_file(path: &str, format: ExportFormat, columns: &[ColumnMeta], rows: &[Vec<CellValue>]) -> AppResult<()> {
    format.check_capacity(rows.len())?;
    let mut out = BufWriter::new(File::create(path)?);
    write_rows(&mut out, format, columns, rows)?;
    out.into_inner().map_err(|e| e.into_error())?;
    Ok(())
}

pub fn write_rows<W: Write + Send>(
    out: &mut W,
    format: ExportFormat,
    columns: &[ColumnMeta],
    rows: &[Vec<CellValue>],
) -> std::io::Result<()> {
    match format {
        ExportFormat::Csv => write_csv(out, columns, rows),
        ExportFormat::Json => write_json(out, columns, rows),
        ExportFormat::Xlsx => write_xlsx(out, columns, rows),
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

/// Excel: one worksheet with a bold, frozen header row; numbers and booleans keep their type,
/// null is an empty cell, everything else is text.
fn write_xlsx<W: Write + Send>(out: &mut W, columns: &[ColumnMeta], rows: &[Vec<CellValue>]) -> std::io::Result<()> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let header = Format::new().set_bold();
    let xlsx_err = |e: rust_xlsxwriter::XlsxError| std::io::Error::other(e.to_string());
    for (c, column) in columns.iter().enumerate() {
        sheet
            .write_string_with_format(0, c as u16, &column.name, &header)
            .map_err(xlsx_err)?;
    }
    sheet.set_freeze_panes(1, 0).map_err(xlsx_err)?;
    for (r, row) in rows.iter().enumerate() {
        let r = r as u32 + 1;
        for (c, value) in row.iter().enumerate() {
            let c = c as u16;
            match value {
                CellValue::Null => continue,
                CellValue::Bool(b) => sheet.write_boolean(r, c, *b),
                CellValue::Number(n) => match n.as_f64() {
                    Some(f) => sheet.write_number(r, c, f),
                    None => sheet.write_string(r, c, n.to_string()),
                },
                CellValue::String(s) => sheet.write_string(r, c, s),
                other => sheet.write_string(r, c, other.to_string()),
            }
            .map_err(xlsx_err)?;
        }
    }
    workbook.save_to_writer(out).map_err(xlsx_err)
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
    fn xlsx_is_a_zip_package_with_one_sheet() {
        let rows = vec![
            vec![json!(1), json!("a")],
            vec![json!(2.5), CellValue::Null],
            vec![json!(true), json!("b")],
        ];
        let mut out = Vec::new();
        write_rows(&mut out, ExportFormat::Xlsx, &columns(), &rows).unwrap();
        assert_eq!(&out[..2], b"PK");
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("xl/worksheets/sheet1.xml"));
        assert!(!text.contains("sheet2.xml"));
    }

    #[test]
    fn excel_capacity_is_checked_up_front() {
        assert!(ExportFormat::Xlsx.check_capacity(EXCEL_MAX_DATA_ROWS).is_ok());
        let err = ExportFormat::Xlsx.check_capacity(EXCEL_MAX_DATA_ROWS + 1).unwrap_err();
        assert!(err.to_string().contains("export CSV or JSON instead"));
        assert!(ExportFormat::Csv.check_capacity(usize::MAX).is_ok());
    }

    #[test]
    fn json_pads_short_rows_with_null() {
        let rows = vec![vec![json!(1)]];
        assert!(render(ExportFormat::Json, &rows).contains("\"name, full\": null"));
    }
}
