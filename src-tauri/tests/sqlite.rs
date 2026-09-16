//! Integration tests for the SQLite backend. Unlike `live_mysql.rs` these need
//! no external service — every test opens its own temporary database file.
//! Run with: cargo test --test sqlite

use std::path::PathBuf;

use query_craft_lib::connections::{Credentials, StoredConnectionView};
use query_craft_lib::db::execute::{self, ExecuteRequest, ExportRequest};
use query_craft_lib::db::export::ExportFormat;
use query_craft_lib::db::{ConnectionManager, DbKind, ParamStatement, StatementResultKind, TableKind};
use query_craft_lib::history::History;
use serde_json::{json, Value};

/// A fresh, uniquely named database file under the system temp directory.
fn temp_db_path(test: &str) -> PathBuf {
    std::env::temp_dir().join(format!("querycraft-test-{test}-{}.sqlite", uuid::Uuid::new_v4()))
}

async fn setup(test: &str) -> (ConnectionManager, History, PathBuf) {
    let path = temp_db_path(test);
    let view = StoredConnectionView {
        kind: DbKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: false,
        ssl_verify: true,
        ssl_ca_path: None,
        path: Some(path.to_string_lossy().into_owned()),
        ssh: None,
    };
    let manager = ConnectionManager::new();
    manager
        .connect("c1", &view, Credentials::default())
        .await
        .expect("connect");
    let history = History::at_path(std::env::temp_dir().join(format!("querycraft-test-{test}-history.json")));
    (manager, history, path)
}

fn cleanup(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

fn req(sql: &str, session: &str, max_rows: u32) -> ExecuteRequest {
    ExecuteRequest {
        connection_id: "c1".into(),
        session_id: session.into(),
        query_id: uuid::Uuid::new_v4().to_string(),
        sql: sql.into(),
        max_rows,
        database: None,
        stop_on_error: true,
    }
}

#[tokio::test]
async fn ddl_and_insert_report_affected_rows_and_last_insert_id() {
    let (m, h, path) = setup("ddl-insert").await;

    let r = execute::execute(
        &m,
        &h,
        req("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", "s1", 100),
    )
    .await
    .unwrap();
    assert_eq!(r.len(), 1);
    assert!(matches!(r[0].kind, StatementResultKind::Affected));
    assert_eq!(r[0].affected_rows, 0);
    assert_eq!(r[0].last_insert_id, None);

    let r = execute::execute(&m, &h, req("INSERT INTO t (name) VALUES ('a')", "s1", 100))
        .await
        .unwrap();
    assert_eq!(r[0].affected_rows, 1);
    assert_eq!(r[0].last_insert_id, Some(1));

    let r = execute::execute(&m, &h, req("INSERT INTO t (name) VALUES ('b')", "s1", 100))
        .await
        .unwrap();
    assert_eq!(r[0].last_insert_id, Some(2));

    // UPDATE is not an INSERT: no last_insert_id even though rows changed.
    let r = execute::execute(&m, &h, req("UPDATE t SET name = 'c' WHERE id = 1", "s1", 100))
        .await
        .unwrap();
    assert_eq!(r[0].affected_rows, 1);
    assert_eq!(r[0].last_insert_id, None);

    cleanup(&path);
}

#[tokio::test]
async fn types_are_converted_by_storage_class() {
    let (m, h, path) = setup("types").await;

    execute::execute(
        &m,
        &h,
        req(
            "CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n INTEGER)",
            "s1",
            100,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &h,
        req(
            "INSERT INTO t (i, r, s, b, n) VALUES (9007199254740993, 1.5, 'hello', X'DEADBEEF', NULL)",
            "s1",
            100,
        ),
    )
    .await
    .unwrap();

    let r = execute::execute(&m, &h, req("SELECT * FROM t", "s1", 100))
        .await
        .unwrap();
    let res = &r[0];
    assert!(matches!(res.kind, StatementResultKind::Rows));
    let row = &res.rows[0];
    assert_eq!(row[0], json!("9007199254740993")); // beyond 2^53 -> string
    assert_eq!(row[1], json!(1.5));
    assert_eq!(row[2], json!("hello"));
    assert_eq!(row[3], json!("0xDEADBEEF"));
    assert_eq!(row[4], Value::Null);

    assert_eq!(res.columns[0].type_name, "INTEGER");
    assert_eq!(res.columns[1].type_name, "REAL");
    assert_eq!(res.columns[2].type_name, "TEXT");
    assert_eq!(res.columns[3].type_name, "BLOB");
    assert!(res.columns[3].binary);
    assert!(!res.columns[0].binary);
    // Column `n` only ever held NULL, but its declared type is still known.
    assert_eq!(res.columns[4].type_name, "INTEGER");

    cleanup(&path);
}

#[tokio::test]
async fn multiple_statements_truncation_and_errors() {
    let (m, h, path) = setup("multi").await;

    execute::execute(&m, &h, req("CREATE TABLE big (id INTEGER PRIMARY KEY)", "s2", 100))
        .await
        .unwrap();
    let inserts: Vec<String> = (1..=10).map(|i| format!("INSERT INTO big (id) VALUES ({i})")).collect();
    execute::execute(&m, &h, req(&inserts.join("; "), "s2", 100))
        .await
        .unwrap();

    let sql = "SELECT id FROM big ORDER BY id; SELECT * FROM nope; SELECT 1";
    let mut r = req(sql, "s2", 5);
    r.stop_on_error = false;
    let r = execute::execute(&m, &h, r).await.unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[0].rows.len(), 5);
    assert!(r[0].truncated);
    assert!(matches!(r[1].kind, StatementResultKind::Error));
    assert!(r[1].error.is_some());
    assert_eq!(r[2].rows[0][0], json!(1));

    // stop_on_error stops the batch at the first failing statement.
    let r = execute::execute(&m, &h, req("SELECT * FROM nope; SELECT 1", "s2", 100))
        .await
        .unwrap();
    assert_eq!(r.len(), 1);
    assert!(matches!(r[0].kind, StatementResultKind::Error));

    cleanup(&path);
}

#[tokio::test]
async fn apply_changes_commits_and_rolls_back() {
    let (m, h, path) = setup("apply").await;

    execute::execute(
        &m,
        &h,
        req(
            "CREATE TABLE t_apply (id INTEGER PRIMARY KEY, s TEXT, n INTEGER)",
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
                sql: "INSERT INTO t_apply (id, s, n) VALUES (?, ?, ?)".into(),
                params: vec![json!(1), json!("a"), Value::Null],
            },
            ParamStatement {
                sql: "INSERT INTO t_apply (id, s) VALUES (?, ?)".into(),
                params: vec![json!(2), json!("b")],
            },
            ParamStatement {
                sql: "UPDATE t_apply SET n = ? WHERE id = ?".into(),
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
                sql: "DELETE FROM t_apply WHERE id = ?".into(),
                params: vec![json!(2)],
            },
            ParamStatement {
                sql: "INSERT INTO t_apply (id) VALUES (?)".into(),
                params: vec![json!(1)], // duplicate PK -> fails
            },
        ],
    )
    .await;
    assert!(bad.is_err());

    // The failing batch rolled back entirely: row 2 is still there.
    let r = execute::execute(&m, &h, req("SELECT id, s, n FROM t_apply ORDER BY id", "s3", 10))
        .await
        .unwrap();
    assert_eq!(
        r[0].rows,
        vec![
            vec![json!(1), json!("a"), json!(7)],
            vec![json!(2), json!("b"), Value::Null]
        ]
    );

    cleanup(&path);
}

#[tokio::test]
async fn schema_queries() {
    let (m, _h, path) = setup("schema").await;

    let driver = m.driver("c1").unwrap();
    let dbs = driver.list_databases().await.unwrap();
    assert!(dbs.contains(&"main".to_string()));

    execute::execute(
        &m,
        &_h,
        req(
            "CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT)",
            "s4",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &_h,
        req(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT, \
             FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE)",
            "s4",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &_h,
        req(
            "CREATE INDEX idx_orders_customer_status ON orders (customer_id, status)",
            "s4",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &_h,
        req("CREATE VIEW active_customers AS SELECT * FROM customers", "s4", 10),
    )
    .await
    .unwrap();

    let tables = driver.list_tables("main").await.unwrap();
    let view = tables.iter().find(|t| t.name == "active_customers").unwrap();
    assert!(matches!(view.kind, TableKind::View));
    let customers = tables.iter().find(|t| t.name == "customers").unwrap();
    assert!(matches!(customers.kind, TableKind::Table));

    let cols = driver.list_columns("main", "customers").await.unwrap();
    let id_col = cols.iter().find(|c| c.name == "id").unwrap();
    assert_eq!(id_col.key, "PRI");
    let email_col = cols.iter().find(|c| c.name == "email").unwrap();
    assert_eq!(email_col.key, "UNI");
    assert_eq!(email_col.data_type, "text");

    let idx = driver.list_indexes("main", "orders").await.unwrap();
    let composite = idx.iter().find(|i| i.name == "idx_orders_customer_status").unwrap();
    assert_eq!(composite.columns, vec!["customer_id", "status"]);
    assert!(!composite.unique);

    let fks = driver.list_foreign_keys("main", "orders").await.unwrap();
    assert_eq!(fks.len(), 1);
    assert_eq!(fks[0].columns, vec!["customer_id"]);
    assert_eq!(fks[0].ref_table, "customers");
    assert_eq!(fks[0].ref_columns, vec!["id"]);
    assert_eq!(fks[0].on_delete, "CASCADE");

    let ddl = driver.table_ddl("main", "customers").await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE customers"), "{ddl}");
    let vddl = driver.table_ddl("main", "active_customers").await.unwrap();
    assert!(vddl.contains("VIEW"), "{vddl}");

    cleanup(&path);
}

#[tokio::test]
async fn cancel_interrupts_running_query() {
    let (m, h, path) = setup("cancel").await;

    let mut r = req(
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
        "s5",
        10,
    );
    r.query_id = "q-cancel".into();
    let start = std::time::Instant::now();
    let exec = execute::execute(&m, &h, r);
    let cancel = async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        m.cancel_query("c1", "q-cancel").await
    };
    let (res, cancel_res) = tokio::join!(exec, cancel);
    cancel_res.expect("cancel");
    let res = res.unwrap();
    assert!(start.elapsed().as_secs() < 5, "the query was not interrupted");
    assert!(matches!(res[0].kind, StatementResultKind::Error), "{:?}", res[0]);

    // The session keeps working after the cancellation.
    let r = execute::execute(&m, &h, req("SELECT 1", "s5", 10)).await.unwrap();
    assert_eq!(r[0].rows[0][0], json!(1));

    cleanup(&path);
}

#[tokio::test]
async fn expression_columns_fall_back_to_storage_class_and_memory_is_shared() {
    let m = ConnectionManager::new();
    let view = StoredConnectionView {
        kind: DbKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        ssl: false,
        ssl_verify: true,
        ssl_ca_path: None,
        path: Some(":memory:".into()),
        ssh: None,
    };
    m.connect("mem", &view, Credentials::default()).await.expect("connect");
    let h = History::at_path(std::env::temp_dir().join("querycraft-sqlite-mem-history.json"));
    let mk = |sql: &str, session: &str| ExecuteRequest {
        connection_id: "mem".into(),
        session_id: session.into(),
        query_id: uuid::Uuid::new_v4().to_string(),
        sql: sql.into(),
        max_rows: 100,
        database: None,
        stop_on_error: true,
    };

    // A table created in one tab is visible from another one.
    execute::execute(
        &m,
        &h,
        mk("CREATE TABLE shared (v TEXT); INSERT INTO shared VALUES ('x')", "a"),
    )
    .await
    .unwrap();
    let r = execute::execute(&m, &h, mk("SELECT v, length(v) AS n, NULL AS z FROM shared", "b"))
        .await
        .unwrap();
    assert_eq!(r[0].rows[0][0], json!("x"));
    assert_eq!(r[0].columns[0].type_name, "TEXT"); // declared
    assert_eq!(r[0].columns[1].type_name, "INTEGER"); // expression: storage class of the value
    assert_eq!(r[0].columns[2].type_name, "NULL"); // expression that only produced NULL
}

#[tokio::test]
async fn export_writes_every_row_regardless_of_the_grid_limit() {
    let (m, h, path) = setup("export").await;
    execute::execute(
        &m,
        &h,
        req(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); \
             WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1200) \
             INSERT INTO t (id, name) SELECT n, 'row ' || n FROM seq",
            "s1",
            500,
        ),
    )
    .await
    .expect("setup");

    let shown = execute::execute(&m, &h, req("SELECT id, name FROM t ORDER BY id", "s1", 500))
        .await
        .expect("select");
    assert_eq!(shown[0].rows.len(), 500);
    assert!(shown[0].truncated);

    let out = std::env::temp_dir().join(format!("querycraft-test-export-{}.csv", uuid::Uuid::new_v4()));
    let summary = execute::export(
        &m,
        ExportRequest {
            connection_id: "c1".into(),
            session_id: "s1".into(),
            query_id: uuid::Uuid::new_v4().to_string(),
            sql: shown[0].sql.clone(),
            database: None,
            format: ExportFormat::Csv,
            path: out.to_string_lossy().into_owned(),
        },
    )
    .await
    .expect("export");
    assert_eq!(summary.rows, 1200);

    let text = std::fs::read_to_string(&out).expect("read export");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 1201);
    assert_eq!(lines[0], "id,name");
    assert_eq!(lines[1], "1,row 1");
    assert_eq!(lines[1200], "1200,row 1200");

    let no_rows = execute::export(
        &m,
        ExportRequest {
            connection_id: "c1".into(),
            session_id: "s1".into(),
            query_id: uuid::Uuid::new_v4().to_string(),
            sql: "DELETE FROM t WHERE id = 1".into(),
            database: None,
            format: ExportFormat::Json,
            path: out.to_string_lossy().into_owned(),
        },
    )
    .await;
    assert!(no_rows.unwrap_err().to_string().contains("no rows"));

    let _ = std::fs::remove_file(&out);
    cleanup(&path);
}
