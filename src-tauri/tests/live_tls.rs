//! TLS integration tests against live servers that present a self-signed
//! certificate. Every engine is checked twice: with certificate verification
//! off the connection must succeed and actually be encrypted, with
//! verification on the self-signed certificate must be rejected.
//!
//! With the CA file of `scripts/tls-servers.sh` (`$TMPDIR/querycraft-tls/ca.crt`)
//! full verification must succeed for the servers that present that certificate.
//!
//! Run with (the ports match docker-compose.yml plus a ClickHouse HTTPS port):
//! QUERYCRAFT_TEST_TLS="1" cargo test --test live_tls
//! Individual engines can be overridden with `QUERYCRAFT_TEST_TLS_<ENGINE>`
//! = `host:port:user:password` (MYSQL, MARIADB, PG, CH). Without
//! `QUERYCRAFT_TEST_TLS` the tests are skipped.

use query_craft_lib::connections::{Credentials, StoredConnectionView};
use query_craft_lib::db::execute::{self, ExecuteRequest};
use query_craft_lib::db::{ConnectionManager, DbKind};
use query_craft_lib::history::History;
use serde_json::json;

fn view(kind: DbKind, env_name: &str, default: &str) -> Option<StoredConnectionView> {
    std::env::var("QUERYCRAFT_TEST_TLS").ok()?;
    let raw = std::env::var(env_name).unwrap_or_else(|_| default.to_string());
    let parts: Vec<&str> = raw.split(':').collect();
    assert_eq!(parts.len(), 4, "{env_name}: host:port:user:password");
    Some(StoredConnectionView {
        kind,
        host: parts[0].to_string(),
        port: parts[1].parse().unwrap(),
        user: parts[2].to_string(),
        database: Some("shop".into()),
        ssl: true,
        ssl_verify: false,
        ssl_ca_path: None,
        path: None,
        ssh: None,
    })
}

fn password(env_name: &str, default: &str) -> String {
    let raw = std::env::var(env_name).unwrap_or_else(|_| default.to_string());
    raw.rsplit(':').next().unwrap().to_string()
}

fn req(sql: &str) -> ExecuteRequest {
    ExecuteRequest {
        connection_id: "tls".into(),
        session_id: "s".into(),
        query_id: uuid::Uuid::new_v4().to_string(),
        sql: sql.into(),
        max_rows: 10,
        database: None,
        stop_on_error: true,
    }
}

/// The CA that signed the certificates of the servers from `scripts/tls-servers.sh`.
fn test_ca() -> Option<String> {
    let ca = std::env::temp_dir().join("querycraft-tls").join("ca.crt");
    ca.exists().then(|| ca.to_string_lossy().into_owned())
}

/// Connects with verification off, runs `probe_sql` on a session and returns
/// the first row; then asserts that verification on rejects the certificate
/// and, when `with_ca` and the test CA file exists, that the CA makes it pass.
async fn check(view: StoredConnectionView, pass: String, probe_sql: &str) -> Vec<serde_json::Value> {
    check_with_ca(view, pass, probe_sql, true).await
}

async fn check_with_ca(
    view: StoredConnectionView,
    pass: String,
    probe_sql: &str,
    with_ca: bool,
) -> Vec<serde_json::Value> {
    let manager = ConnectionManager::new();
    let info = manager
        .connect("tls", &view, Credentials::password(Some(pass.clone())))
        .await
        .expect("tls connect");
    assert!(!info.server_version.is_empty());
    let history = History::at_path(std::env::temp_dir().join("querycraft-tls-history.json"));
    let results = execute::execute(&manager, &history, req(probe_sql)).await.unwrap();
    assert!(results[0].error.is_none(), "{:?}", results[0].error);
    let row = results[0].rows[0].clone();
    manager.disconnect("tls").await.unwrap();

    let strict = StoredConnectionView {
        ssl_verify: true,
        ..view
    };
    let err = ConnectionManager::test_connection(&strict, Credentials::password(Some(pass.clone())))
        .await
        .expect_err("a self-signed certificate must fail verification");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("certificate") || msg.contains("tls") || msg.contains("ssl") || msg.contains("verify"),
        "unexpected error: {msg}"
    );

    if let (true, Some(ca)) = (with_ca, test_ca()) {
        let trusted = StoredConnectionView {
            ssl_ca_path: Some(ca),
            ..strict
        };
        ConnectionManager::test_connection(&trusted, Credentials::password(Some(pass)))
            .await
            .expect("verification with the CA certificate");
    }
    row
}

#[tokio::test]
async fn mysql_tls() {
    let Some(v) = view(
        DbKind::Mysql,
        "QUERYCRAFT_TEST_TLS_MYSQL",
        "127.0.0.1:33070:root:secret",
    ) else {
        return;
    };
    // The MySQL container presents its own auto-generated certificate, not the test CA's.
    let cipher = check_with_ca(
        v,
        password("QUERYCRAFT_TEST_TLS_MYSQL", "127.0.0.1:33070:root:secret"),
        "SELECT VARIABLE_VALUE FROM performance_schema.session_status WHERE VARIABLE_NAME = 'Ssl_cipher'",
        false,
    )
    .await;
    assert_ne!(cipher[0], json!(""), "session is not encrypted");
}

#[tokio::test]
async fn mariadb_tls() {
    let Some(v) = view(
        DbKind::Mariadb,
        "QUERYCRAFT_TEST_TLS_MARIADB",
        "127.0.0.1:33073:root:secret",
    ) else {
        return;
    };
    // MariaDB has no performance_schema by default; SHOW STATUS returns (name, value).
    let status = check(
        v,
        password("QUERYCRAFT_TEST_TLS_MARIADB", "127.0.0.1:33073:root:secret"),
        "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
    )
    .await;
    assert_ne!(status[1], json!(""), "session is not encrypted");
}

#[tokio::test]
async fn postgres_tls() {
    let Some(v) = view(
        DbKind::Postgres,
        "QUERYCRAFT_TEST_TLS_PG",
        "127.0.0.1:33071:postgres:secret",
    ) else {
        return;
    };
    let ssl = check(
        v,
        password("QUERYCRAFT_TEST_TLS_PG", "127.0.0.1:33071:postgres:secret"),
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
    )
    .await;
    assert_eq!(ssl[0], json!(true), "session is not encrypted");
}

#[tokio::test]
async fn clickhouse_tls() {
    let Some(v) = view(
        DbKind::Clickhouse,
        "QUERYCRAFT_TEST_TLS_CH",
        "127.0.0.1:33074:default:secret",
    ) else {
        return;
    };
    let secure = check(
        v,
        password("QUERYCRAFT_TEST_TLS_CH", "127.0.0.1:33074:default:secret"),
        // No per-connection TLS flag is exposed for the current query; the HTTPS port
        // itself proves encryption, so probe that the session works and reports HTTP.
        "SELECT interface FROM system.processes WHERE query_id = queryID()",
    )
    .await;
    assert_eq!(secure[0], json!(2), "query did not arrive over the HTTP(S) interface");
}
