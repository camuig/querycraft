//! Integration tests against a live SQL Server. Run with:
//! QUERYCRAFT_TEST_MSSQL_DSN="127.0.0.1:33078:sa:Secret_123" cargo test --test live_mssql -- --test-threads=1
//! Without the environment variable the tests are skipped.
//!
//! The image ships no sample database: `setup()` creates a fresh `qc_test`
//! database, a `sales` schema and a few tables every run. `CREATE
//! DATABASE`/`CREATE SCHEMA` must be the only statement in their batch, so
//! the "master" step (creating/dropping the database) uses its own session
//! with no database override, while everything else runs against `qc_test`.

use query_craft_lib::connections::{Credentials, StoredConnectionView};
use query_craft_lib::db::execute::{self, ExecuteRequest};
use query_craft_lib::db::{ConnectionManager, DbKind, ParamStatement, StatementResultKind, TableKind};
use query_craft_lib::history::History;
use serde_json::{json, Value};

fn dsn() -> Option<(StoredConnectionView, String)> {
    let raw = std::env::var("QUERYCRAFT_TEST_MSSQL_DSN").ok()?;
    let parts: Vec<&str> = raw.split(':').collect();
    assert_eq!(parts.len(), 4, "DSN: host:port:user:password");
    Some((
        StoredConnectionView {
            kind: DbKind::Mssql,
            host: parts[0].to_string(),
            port: parts[1].parse().unwrap(),
            user: parts[2].to_string(),
            database: None,
            ssl: false,
            // The container's self-signed cert has a validity period macOS's
            // TLS stack rejects outright; SQL Server always encrypts the
            // login step regardless of `ssl`, so verification must be off
            // for a local/dev instance exactly like SSMS's "Trust server
            // certificate" checkbox.
            ssl_verify: false,
            ssl_ca_path: None,
            path: None,
            ssh: None,
        },
        parts[3].to_string(),
    ))
}

fn req(sql: &str, session: &str, max_rows: u32, database: Option<&str>) -> ExecuteRequest {
    ExecuteRequest {
        connection_id: "c1".into(),
        session_id: session.into(),
        query_id: uuid::Uuid::new_v4().to_string(),
        sql: sql.into(),
        max_rows,
        database: database.map(|d| d.to_string()),
        stop_on_error: true,
    }
}

/// A request against the `qc_test` database (every test but the initial
/// database creation runs here).
fn qc(sql: &str, session: &str, max_rows: u32) -> ExecuteRequest {
    req(sql, session, max_rows, Some("qc_test"))
}

/// Panics if any statement in the batch came back as an error — `execute()`
/// only errors on infrastructure failures (no session, ...), a failing SQL
/// statement is just a `StatementResultKind::Error` entry, so callers that
/// need the statement itself to have succeeded must check this explicitly.
fn assert_ok(results: &[query_craft_lib::db::StatementResult], context: &str) {
    for r in results {
        assert!(
            !matches!(r.kind, StatementResultKind::Error),
            "{context}: {:?}",
            r.error
        );
    }
}

async fn setup() -> Option<(ConnectionManager, History)> {
    let (view, pass) = dsn()?;
    let manager = ConnectionManager::new();
    manager
        .connect("c1", &view, Credentials::password(Some(pass)))
        .await
        .expect("connect");
    let history = History::at_path(std::env::temp_dir().join("querycraft-test-history-mssql.json"));

    // A fresh `qc_test` database for every test run. `ALTER`/`CREATE`/`DROP
    // DATABASE` must each be the only statement in their batch and cannot
    // target a database the current session is connected to, so this runs
    // with no database override. The splitter that turns console input into
    // statements has no notion of `BEGIN`/`END` nesting, so a single
    // `IF ... BEGIN ... END` statement with semicolons inside it gets cut
    // into invalid fragments — everything here is its own plain statement instead.
    // The `ALTER`/`DROP IF EXISTS` step is best-effort: on a genuinely fresh
    // instance `qc_test` doesn't exist yet and both legitimately fail.
    let _ = execute::execute(
        &manager,
        &history,
        req(
            "ALTER DATABASE qc_test SET SINGLE_USER WITH ROLLBACK IMMEDIATE",
            "setup-master",
            10,
            None,
        ),
    )
    .await;
    let _ = execute::execute(
        &manager,
        &history,
        req("DROP DATABASE IF EXISTS qc_test", "setup-master", 10, None),
    )
    .await;

    let r = execute::execute(
        &manager,
        &history,
        req("CREATE DATABASE qc_test", "setup-master", 10, None),
    )
    .await
    .expect("create database");
    assert_ok(&r, "create database");

    let r = execute::execute(&manager, &history, qc("CREATE SCHEMA sales", "setup", 10))
        .await
        .expect("create schema");
    assert_ok(&r, "create schema");

    Some((manager, history))
}

#[tokio::test]
async fn connects_and_reports_version() {
    let Some((m, _h)) = setup().await else { return };
    let driver = m.driver("c1").unwrap();
    let info = driver.server_info().await.unwrap();
    assert!(!info.server_version.is_empty(), "{info:?}");
    assert!(info.connection_id.is_some());
}

#[tokio::test]
async fn types_are_converted_correctly() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        qc(
            "CREATE TABLE t_types ( \
                 id INT PRIMARY KEY, \
                 name NVARCHAR(100), \
                 amount DECIMAL(10,2), \
                 active BIT, \
                 seen DATETIME2, \
                 token UNIQUEIDENTIFIER, \
                 payload VARBINARY(50) \
             )",
            "s1",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &h,
        qc(
            "INSERT INTO t_types VALUES ( \
                 1, N'café', 100.50, 1, '2024-01-02T03:04:05.1230000', \
                 '550E8400-E29B-41D4-A716-446655440000', 0xDEADBEEF \
             )",
            "s1",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(&m, &h, qc("INSERT INTO t_types (id, name) VALUES (2, NULL)", "s1", 10))
        .await
        .unwrap();

    let r = execute::execute(&m, &h, qc("SELECT * FROM t_types ORDER BY id", "s1", 10))
        .await
        .unwrap();
    let res = &r[0];
    assert!(matches!(res.kind, StatementResultKind::Rows), "{res:?}");
    let row = &res.rows[0];
    assert_eq!(row[0], json!(1));
    assert_eq!(row[1], json!("café"));
    assert_eq!(row[2], json!("100.50")); // DECIMAL -> string
    assert_eq!(row[3], json!(true)); // BIT -> bool
    assert!(
        row[4].as_str().unwrap().starts_with("2024-01-02 03:04:05"),
        "{:?}",
        row[4]
    );
    assert_eq!(row[5], json!("550e8400-e29b-41d4-a716-446655440000"));
    assert_eq!(row[6], json!("0xDEADBEEF"));
    assert!(res.columns[6].binary);

    let null_row = &res.rows[1];
    assert_eq!(null_row[1], Value::Null);
}

#[tokio::test]
async fn multiple_statements_truncation_and_errors() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        qc(
            "CREATE TABLE t_big (id INT PRIMARY KEY); \
             ;WITH nums AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM nums WHERE n < 200) \
             INSERT INTO t_big SELECT n FROM nums OPTION (MAXRECURSION 200)",
            "s2",
            10,
        ),
    )
    .await
    .unwrap();

    let sql = "SELECT id FROM t_big ORDER BY id; UPDATE t_big SET id = id WHERE id < 5; SELECT * FROM nope; SELECT 1";
    let mut r = qc(sql, "s2", 100);
    r.stop_on_error = false;
    let r = execute::execute(&m, &h, r).await.unwrap();
    assert_eq!(r.len(), 4, "{r:?}");
    assert_eq!(r[0].rows.len(), 100);
    assert!(r[0].truncated);
    assert!(matches!(r[1].kind, StatementResultKind::Affected), "{:?}", r[1]);
    assert_eq!(r[1].affected_rows, 4);
    assert!(matches!(r[2].kind, StatementResultKind::Error), "{:?}", r[2]);
    assert!(r[2].error.as_ref().unwrap().contains("nope"), "{:?}", r[2].error);
    assert_eq!(r[3].rows[0][0], json!(1));

    // stop_on_error
    let r = execute::execute(&m, &h, qc("SELECT * FROM nope; SELECT 1", "s2", 100))
        .await
        .unwrap();
    assert_eq!(r.len(), 1);

    // Two SELECTs sent as one console submission — execute::execute splits
    // them at the top level, so this exercises two result sets.
    let r = execute::execute(&m, &h, qc("SELECT 10 AS a; SELECT 20 AS b", "s2", 10))
        .await
        .unwrap();
    assert_eq!(r.len(), 2);
    assert_eq!(r[0].rows[0][0], json!(10));
    assert_eq!(r[1].rows[0][0], json!(20));
}

#[tokio::test]
async fn apply_changes_commits_and_rolls_back() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        qc(
            "CREATE TABLE t_apply (id INT PRIMARY KEY, s NVARCHAR(20), n INT NULL)",
            "s3",
            10,
        ),
    )
    .await
    .unwrap();

    let ok = execute::apply_changes(
        &m,
        "c1",
        "s3",
        vec![
            ParamStatement {
                sql: "INSERT INTO qc_test.dbo.t_apply (id, s, n) VALUES (?, ?, ?)".into(),
                params: vec![json!(1), json!("a"), Value::Null],
            },
            ParamStatement {
                sql: "INSERT INTO qc_test.dbo.t_apply (id, s) VALUES (?, ?)".into(),
                params: vec![json!(2), json!("café")],
            },
            ParamStatement {
                sql: "UPDATE qc_test.dbo.t_apply SET n = ? WHERE id = ?".into(),
                params: vec![json!(7), json!(1)],
            },
        ],
    )
    .await
    .unwrap();
    assert_eq!(ok.affected_rows, 3);

    let bad = execute::apply_changes(
        &m,
        "c1",
        "s3",
        vec![
            ParamStatement {
                sql: "DELETE FROM qc_test.dbo.t_apply WHERE id = ?".into(),
                params: vec![json!(2)],
            },
            ParamStatement {
                sql: "INSERT INTO qc_test.dbo.t_apply (id) VALUES (?)".into(),
                params: vec![json!(1)], // duplicate PK
            },
        ],
    )
    .await;
    assert!(bad.is_err());

    let r = execute::execute(&m, &h, qc("SELECT id, s, n FROM t_apply ORDER BY id", "s3", 10))
        .await
        .unwrap();
    assert_eq!(
        r[0].rows,
        vec![
            vec![json!(1), json!("a"), json!(7)],
            vec![json!(2), json!("café"), Value::Null]
        ]
    );
}

#[tokio::test]
async fn schema_queries() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        qc(
            "CREATE TABLE dbo.customers ( \
                 id INT PRIMARY KEY, \
                 email NVARCHAR(255) UNIQUE NOT NULL, \
                 name NVARCHAR(255) NOT NULL \
             )",
            "s5",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &h,
        qc(
            "CREATE TABLE sales.invoice ( \
                 id INT PRIMARY KEY, \
                 customer_id INT NOT NULL REFERENCES dbo.customers(id), \
                 status NVARCHAR(20) NOT NULL \
             )",
            "s5",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &h,
        qc(
            "CREATE INDEX idx_invoice_customer_status ON sales.invoice (customer_id, status)",
            "s5",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &h,
        qc(
            "CREATE VIEW dbo.active_customers AS SELECT * FROM dbo.customers",
            "s5",
            10,
        ),
    )
    .await
    .unwrap();

    let driver = m.driver("c1").unwrap();
    let databases = driver.list_databases().await.unwrap();
    assert!(databases.contains(&"qc_test".to_string()), "{databases:?}");

    let tables = driver.list_tables("qc_test").await.unwrap();
    let view = tables.iter().find(|t| t.name == "dbo.active_customers").unwrap();
    assert!(matches!(view.kind, TableKind::View));
    let customers = tables.iter().find(|t| t.name == "dbo.customers").unwrap();
    assert!(matches!(customers.kind, TableKind::Table));
    assert!(tables.iter().any(|t| t.name == "sales.invoice"), "{tables:?}");

    let cols = driver.list_columns("qc_test", "dbo.customers").await.unwrap();
    let id_col = cols.iter().find(|c| c.name == "id").unwrap();
    assert_eq!(id_col.key, "PRI");
    let email_col = cols.iter().find(|c| c.name == "email").unwrap();
    assert_eq!(email_col.key, "UNI");

    let invoice_cols = driver.list_columns("qc_test", "sales.invoice").await.unwrap();
    let invoice_id = invoice_cols.iter().find(|c| c.name == "id").unwrap();
    assert_eq!(invoice_id.key, "PRI");

    let idx = driver.list_indexes("qc_test", "sales.invoice").await.unwrap();
    let composite = idx.iter().find(|i| i.name == "idx_invoice_customer_status").unwrap();
    assert_eq!(composite.columns, vec!["customer_id", "status"]);

    let fks = driver.list_foreign_keys("qc_test", "sales.invoice").await.unwrap();
    assert_eq!(fks.len(), 1, "{fks:?}");
    assert_eq!(fks[0].ref_table, "dbo.customers");

    let ddl = driver.table_ddl("qc_test", "dbo.customers").await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE [dbo].[customers]"), "{ddl}");
    let vddl = driver.table_ddl("qc_test", "dbo.active_customers").await.unwrap();
    assert!(vddl.to_uppercase().contains("CREATE VIEW"), "{vddl}");
}
