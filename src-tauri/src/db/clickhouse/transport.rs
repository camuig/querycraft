//! Thin HTTP transport for the ClickHouse HTTP interface: builds the request
//! URL, sends the SQL as the request body, and turns a non-200 response into
//! an `AppError::Database` (ClickHouse puts `Code: NN. DB::Exception: ...` in the body).

use std::time::Duration;

use reqwest::{Client, Response, Url};

use crate::error::{AppError, AppResult};

/// Result of a single HTTP request to the ClickHouse HTTP interface.
pub(crate) struct HttpResult {
    /// Response body; empty for a statement without a result set.
    pub body: String,
    /// `written_rows` from the `X-ClickHouse-Summary` response header, when present.
    pub written_rows: Option<u64>,
}

/// Sends `sql` as the body of a `POST /` request, with `params` added to the
/// query string alongside the output-format settings every request needs.
///
/// `response_timeout` bounds how long to wait for the whole response. It is set
/// for the driver's metadata requests (server version, schema) so a
/// misconfigured endpoint — one that accepts a TCP connection but never speaks
/// HTTP, e.g. the native-protocol port 9000 given instead of the HTTP port 8123
/// — fails with an error instead of hanging the connection forever. It is left
/// `None` for a console statement, whose runtime is unbounded by design.
pub(crate) async fn request(
    client: &Client,
    base_url: &str,
    user: &str,
    password: &str,
    sql: &str,
    params: &[(&str, String)],
    response_timeout: Option<Duration>,
) -> AppResult<HttpResult> {
    let url = build_url(base_url, params)?;
    let mut builder = client
        .post(url)
        .header("X-ClickHouse-User", user)
        .header("X-ClickHouse-Key", password)
        .body(sql.to_string());
    if let Some(timeout) = response_timeout {
        builder = builder.timeout(timeout);
    }
    let response = builder.send().await?;

    let status = response.status();
    let written_rows = response
        .headers()
        .get("X-ClickHouse-Summary")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_written_rows);
    let body = read_body(response).await?;

    if !status.is_success() {
        return Err(AppError::Database(body.trim().to_string()));
    }

    Ok(HttpResult { body, written_rows })
}

/// Appends the fixed output-format settings and the caller's `params` to `base_url`'s query string.
fn build_url(base_url: &str, params: &[(&str, String)]) -> AppResult<Url> {
    let mut url =
        Url::parse(base_url).map_err(|e| AppError::Database(format!("invalid ClickHouse URL {base_url:?}: {e}")))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("default_format", "JSONCompactEachRowWithNamesAndTypes");
        pairs.append_pair("output_format_json_quote_64bit_integers", "0");
        pairs.append_pair("output_format_json_quote_denormals", "1");
        // Otherwise an exception is wrapped into the output format (`[]\n[]\n["Code: ..."]`).
        pairs.append_pair("http_write_exception_in_output_format", "0");
        for (key, value) in params {
            pairs.append_pair(key, value);
        }
    }
    Ok(url)
}

/// Reads the response body chunk by chunk so a large result set is copied
/// into memory once, instead of being buffered a second time by `Response::text()`.
async fn read_body(mut response: Response) -> AppResult<String> {
    let mut buf = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Extracts `written_rows` from the JSON value of an `X-ClickHouse-Summary`
/// header, e.g. `{"read_rows":"1","written_rows":"3",...}` (numbers are reported as strings).
pub(crate) fn parse_written_rows(summary_header: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(summary_header).ok()?;
    value.get("written_rows")?.as_str()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::{build_url, parse_written_rows};

    #[test]
    fn build_url_sets_plain_text_exceptions_and_keeps_params() {
        let url = build_url("http://localhost:8123/", &[("database", "shop".to_string())]).unwrap();
        let query = url.query().unwrap();
        assert!(query.contains("default_format=JSONCompactEachRowWithNamesAndTypes"));
        assert!(query.contains("http_write_exception_in_output_format=0"));
        assert!(query.contains("database=shop"));
    }

    #[test]
    fn parse_written_rows_reads_the_field() {
        let header = r#"{"read_rows":"1","read_bytes":"8","written_rows":"3","written_bytes":"24"}"#;
        assert_eq!(parse_written_rows(header), Some(3));
    }

    #[test]
    fn parse_written_rows_missing_field() {
        assert_eq!(parse_written_rows(r#"{"read_rows":"1"}"#), None);
    }

    #[test]
    fn parse_written_rows_invalid_json_is_ignored() {
        assert_eq!(parse_written_rows("not json"), None);
    }
}
