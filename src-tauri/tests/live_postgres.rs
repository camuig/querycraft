//! Integration tests against a live PostgreSQL server. Run with:
//! QUERYCRAFT_TEST_PG_DSN="127.0.0.1:33071:postgres:secret" cargo test --test live_postgres -- --test-threads=1
//! Without the environment variable the tests are skipped.
//!
//! Every test works inside its own dedicated schema (`qc_test`) so the
//! suite can run against a shared database without clashing with other
//! backends' fixtures.

use query_craft_lib::connections::{Credentials, StoredConnectionView};
use query_craft_lib::db::execute::{self, ExecuteRequest};
use query_craft_lib::db::{ConnectionManager, DbKind, ParamStatement, StatementResultKind, TableKind};
use query_craft_lib::history::History;
use serde_json::{json, Value};

fn dsn() -> Option<(StoredConnectionView, String)> {
    let raw = std::env::var("QUERYCRAFT_TEST_PG_DSN").ok()?;
    let parts: Vec<&str> = raw.split(':').collect();
    assert_eq!(parts.len(), 4, "DSN: host:port:user:password");
    Some((
        StoredConnectionView {
            kind: DbKind::Postgres,
            host: parts[0].to_string(),
            port: parts[1].parse().unwrap(),
            user: parts[2].to_string(),
            database: Some("shop".to_string()),
            ssl: false,
            ssl_verify: true,
            ssl_ca_path: None,
            path: None,
            ssh: None,
        },
        parts[3].to_string(),
    ))
}

async fn setup() -> Option<(ConnectionManager, History)> {
    let (view, pass) = dsn()?;
    let manager = ConnectionManager::new();
    manager
        .connect("c1", &view, Credentials::password(Some(pass)))
        .await
        .expect("connect");
    let history = History::at_path(std::env::temp_dir().join("querycraft-test-history-pg.json"));

    // A fresh `qc_test` schema for every test run.
    execute::execute(
        &manager,
        &history,
        req("DROP SCHEMA IF EXISTS qc_test CASCADE", "setup", 10),
    )
    .await
    .expect("drop schema");
    execute::execute(&manager, &history, req("CREATE SCHEMA qc_test", "setup", 10))
        .await
        .expect("create schema");

    Some((manager, history))
}

fn req(sql: &str, session: &str, max_rows: u32) -> ExecuteRequest {
    ExecuteRequest {
        connection_id: "c1".into(),
        session_id: session.into(),
        query_id: uuid::Uuid::new_v4().to_string(),
        sql: sql.into(),
        max_rows,
        database: Some("qc_test".into()),
        stop_on_error: true,
    }
}

#[tokio::test]
async fn types_are_converted_by_column_type() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req(
            "CREATE TABLE t_types ( \
                 id INT PRIMARY KEY, \
                 big BIGINT, \
                 amount NUMERIC(10,2), \
                 active BOOLEAN, \
                 born DATE, \
                 seen TIMESTAMPTZ, \
                 payload BYTEA, \
                 attrs JSON, \
                 token UUID, \
                 tags TEXT[] \
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
        req(
            "INSERT INTO t_types VALUES ( \
                 1, 9007199254740993, 100.50, true, '1990-05-01', \
                 '2024-01-02 03:04:05+00', '\\xdeadbeef', '{\"vip\": true}', \
                 '550e8400-e29b-41d4-a716-446655440000', ARRAY['a','b'] \
             )",
            "s1",
            10,
        ),
    )
    .await
    .unwrap();

    let r = execute::execute(&m, &h, req("SELECT * FROM t_types", "s1", 10))
        .await
        .unwrap();
    let res = &r[0];
    assert!(matches!(res.kind, StatementResultKind::Rows));
    let row = &res.rows[0];
    assert_eq!(row[0], json!(1));
    assert_eq!(row[1], json!("9007199254740993")); // BIGINT beyond 2^53 -> string
    assert_eq!(row[2], json!("100.50")); // NUMERIC -> string
    assert_eq!(row[3], json!(true));
    assert_eq!(row[4], json!("1990-05-01"));
    assert!(row[5].as_str().unwrap().starts_with("2024-01-02"));
    assert_eq!(row[6], json!("0xDEADBEEF"));
    assert!(res.columns[6].binary);
    assert_eq!(row[7], json!("{\"vip\": true}"));
    assert_eq!(row[8], json!("550e8400-e29b-41d4-a716-446655440000"));
    assert_eq!(row[9], json!("{a,b}")); // text[] -> its text representation
}

#[tokio::test]
async fn multiple_statements_truncation_and_errors() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req("CREATE TABLE t_big AS SELECT generate_series(1, 200) AS id", "s2", 10),
    )
    .await
    .unwrap();

    let sql = "SELECT id FROM t_big ORDER BY id; UPDATE t_big SET id = id WHERE id < 5; SELECT * FROM nope; SELECT 1";
    let mut r = req(sql, "s2", 100);
    r.stop_on_error = false;
    let r = execute::execute(&m, &h, r).await.unwrap();
    assert_eq!(r.len(), 4);
    assert_eq!(r[0].rows.len(), 100);
    assert!(r[0].truncated);
    assert!(matches!(r[1].kind, StatementResultKind::Affected));
    assert_eq!(r[1].affected_rows, 4);
    assert!(matches!(r[2].kind, StatementResultKind::Error));
    assert!(r[2].error.as_ref().unwrap().contains("nope"), "{:?}", r[2].error);
    assert_eq!(r[3].rows[0][0], json!(1));

    // stop_on_error
    let r = execute::execute(&m, &h, req("SELECT * FROM nope; SELECT 1", "s2", 100))
        .await
        .unwrap();
    assert_eq!(r.len(), 1);
}

#[tokio::test]
async fn apply_changes_commits_and_rolls_back() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req(
            "CREATE TABLE t_apply (id INT PRIMARY KEY, s VARCHAR(10), n INT NULL)",
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
                sql: "INSERT INTO qc_test.t_apply (id, s, n) VALUES (?, ?, ?)".into(),
                params: vec![json!(1), json!("a"), Value::Null],
            },
            ParamStatement {
                sql: "INSERT INTO qc_test.t_apply (id, s) VALUES (?, ?)".into(),
                params: vec![json!(2), json!("ü")],
            },
            ParamStatement {
                sql: "UPDATE qc_test.t_apply SET n = ? WHERE id = ?".into(),
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
                sql: "DELETE FROM qc_test.t_apply WHERE id = ?".into(),
                params: vec![json!(2)],
            },
            ParamStatement {
                sql: "INSERT INTO qc_test.t_apply (id) VALUES (?)".into(),
                params: vec![json!(1)], // duplicate PK
            },
        ],
    )
    .await;
    assert!(bad.is_err());

    let r = execute::execute(&m, &h, req("SELECT id, s, n FROM t_apply ORDER BY id", "s3", 10))
        .await
        .unwrap();
    assert_eq!(
        r[0].rows,
        vec![
            vec![json!(1), json!("a"), json!(7)],
            vec![json!(2), json!("ü"), Value::Null]
        ]
    );
}

#[tokio::test]
async fn cancel_kills_running_query() {
    let Some((m, h)) = setup().await else { return };
    let mut r = req("SELECT pg_sleep(10)", "s4", 10);
    r.query_id = "pg-cancel".into();
    let start = std::time::Instant::now();
    let exec = execute::execute(&m, &h, r);
    let cancel = async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        m.cancel_query("c1", "pg-cancel").await
    };
    let (res, cancel_res) = tokio::join!(exec, cancel);
    cancel_res.expect("cancel");
    let res = res.unwrap();
    assert!(start.elapsed().as_secs() < 5, "the query was not cancelled");
    assert!(matches!(res[0].kind, StatementResultKind::Error), "{:?}", res[0]);

    // the session keeps working after the cancellation
    let r = execute::execute(&m, &h, req("SELECT 5", "s4", 10)).await.unwrap();
    assert_eq!(r[0].rows[0][0], json!(5));
}

#[tokio::test]
async fn schema_queries() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req(
            "CREATE TABLE customers ( \
                 id SERIAL PRIMARY KEY, \
                 email VARCHAR(255) UNIQUE NOT NULL, \
                 name VARCHAR(255) NOT NULL \
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
        req(
            "CREATE TABLE orders ( \
                 id SERIAL PRIMARY KEY, \
                 customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, \
                 status VARCHAR(20) NOT NULL \
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
        req(
            "CREATE INDEX idx_orders_customer_status ON orders (customer_id, status)",
            "s5",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &h,
        req("CREATE VIEW active_orders AS SELECT * FROM orders", "s5", 10),
    )
    .await
    .unwrap();

    let driver = m.driver("c1").unwrap();
    let schemas = driver.list_databases().await.unwrap();
    assert!(schemas.contains(&"qc_test".to_string()));

    let tables = driver.list_tables("qc_test").await.unwrap();
    let view = tables.iter().find(|t| t.name == "active_orders").unwrap();
    assert!(matches!(view.kind, TableKind::View));
    let customers = tables.iter().find(|t| t.name == "customers").unwrap();
    assert!(matches!(customers.kind, TableKind::Table));

    let cols = driver.list_columns("qc_test", "customers").await.unwrap();
    let id_col = cols.iter().find(|c| c.name == "id").unwrap();
    assert_eq!(id_col.key, "PRI");
    let email_col = cols.iter().find(|c| c.name == "email").unwrap();
    assert_eq!(email_col.key, "UNI");

    let idx = driver.list_indexes("qc_test", "orders").await.unwrap();
    let composite = idx.iter().find(|i| i.name == "idx_orders_customer_status").unwrap();
    assert_eq!(composite.columns, vec!["customer_id", "status"]);

    let fks = driver.list_foreign_keys("qc_test", "orders").await.unwrap();
    assert_eq!(fks.len(), 1);
    assert_eq!(fks[0].ref_table, "customers");
    assert_eq!(fks[0].on_delete, "CASCADE");

    let ddl = driver.table_ddl("qc_test", "customers").await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE \"qc_test\".\"customers\""), "{ddl}");
    let vddl = driver.table_ddl("qc_test", "active_orders").await.unwrap();
    assert!(vddl.starts_with("CREATE VIEW \"qc_test\".\"active_orders\""), "{vddl}");
}
