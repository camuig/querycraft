//! Integration tests against a live ClickHouse server. Run with:
//! QUERYCRAFT_TEST_CH_DSN="127.0.0.1:33072:default:secret" cargo test --test live_clickhouse -- --test-threads=1
//! Without the environment variable the tests are skipped.

use query_craft_lib::connections::StoredConnectionView;
use query_craft_lib::db::execute::{self, ExecuteRequest};
use query_craft_lib::db::{ConnectionManager, DbKind, ParamStatement, StatementResultKind, TableKind};
use query_craft_lib::history::History;
use serde_json::{json, Value};

fn dsn() -> Option<(StoredConnectionView, String)> {
    let raw = std::env::var("QUERYCRAFT_TEST_CH_DSN").ok()?;
    let parts: Vec<&str> = raw.split(':').collect();
    assert_eq!(parts.len(), 4, "DSN: host:port:user:password");
    Some((
        StoredConnectionView {
            kind: DbKind::Clickhouse,
            host: parts[0].to_string(),
            port: parts[1].parse().unwrap(),
            user: parts[2].to_string(),
            database: None,
            ssl: false,
            ssl_verify: true,
            path: None,
        },
        parts[3].to_string(),
    ))
}

async fn setup() -> Option<(ConnectionManager, History)> {
    let (view, pass) = dsn()?;
    let manager = ConnectionManager::new();
    manager.connect("c1", &view, Some(pass)).await.expect("connect");
    let history = History::at_path(std::env::temp_dir().join("querycraft-test-history-ch.json"));
    Some((manager, history))
}

fn req(sql: &str, session: &str, max_rows: u32) -> ExecuteRequest {
    ExecuteRequest {
        connection_id: "c1".into(),
        session_id: session.into(),
        query_id: uuid::Uuid::new_v4().to_string(),
        sql: sql.into(),
        max_rows,
        database: Some("shop".into()),
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
            "DROP TABLE IF EXISTS ch_types; \
             CREATE TABLE ch_types (id UInt64, n_int Int32, n_float Float64, s Nullable(String), \
             dt DateTime, arr Array(UInt8), amount Decimal(10,2)) ENGINE = MergeTree ORDER BY id",
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
            "INSERT INTO ch_types VALUES \
             (9007199254740993, -42, 3.5, NULL, '2024-01-02 03:04:05', [1,2,3], 123.45)",
            "s1",
            10,
        ),
    )
    .await
    .unwrap();

    let r = execute::execute(&m, &h, req("SELECT * FROM ch_types", "s1", 10))
        .await
        .unwrap();
    assert_eq!(r.len(), 1);
    let res = &r[0];
    assert!(matches!(res.kind, StatementResultKind::Rows));
    let row = &res.rows[0];
    assert_eq!(row[0], json!("9007199254740993")); // UInt64 beyond 2^53 -> string
    assert_eq!(row[1], json!(-42));
    assert_eq!(row[2], json!(3.5));
    assert_eq!(row[3], Value::Null);
    assert!(row[4].as_str().unwrap().starts_with("2024-01-02"), "{:?}", row[4]);
    assert_eq!(row[5], json!("[1,2,3]")); // Array(UInt8) -> JSON text
    assert_eq!(row[6], json!("123.45")); // Decimal -> string

    assert_eq!(res.columns[0].type_name, "UInt64");
    assert!(res.columns[0].unsigned);
    assert!(res.columns[3].nullable);
}

#[tokio::test]
async fn insert_reports_affected_rows() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req(
            "DROP TABLE IF EXISTS ch_insert; CREATE TABLE ch_insert (id UInt32) ENGINE = MergeTree ORDER BY id",
            "s2",
            10,
        ),
    )
    .await
    .unwrap();

    let r = execute::execute(
        &m,
        &h,
        req("INSERT INTO ch_insert SELECT number FROM numbers(5)", "s2", 10),
    )
    .await
    .unwrap();
    assert_eq!(r.len(), 1);
    assert!(matches!(r[0].kind, StatementResultKind::Affected));
    assert_eq!(r[0].affected_rows, 5);
}

#[tokio::test]
async fn multiple_statements_truncation_and_errors() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req(
            "DROP TABLE IF EXISTS ch_big; CREATE TABLE ch_big (id UInt32) ENGINE = MergeTree ORDER BY id",
            "s3",
            10,
        ),
    )
    .await
    .unwrap();
    execute::execute(
        &m,
        &h,
        req("INSERT INTO ch_big SELECT number FROM numbers(200)", "s3", 10),
    )
    .await
    .unwrap();

    let sql = "SELECT id FROM ch_big ORDER BY id; SELECT * FROM ch_nope; SELECT 1";
    let mut r = req(sql, "s3", 100);
    r.stop_on_error = false;
    let r = execute::execute(&m, &h, r).await.unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[0].rows.len(), 100);
    assert!(r[0].truncated);
    assert!(matches!(r[1].kind, StatementResultKind::Error));
    assert_eq!(r[2].rows[0][0], json!(1));

    // stop_on_error
    let r = execute::execute(&m, &h, req("SELECT * FROM ch_nope; SELECT 1", "s3", 100))
        .await
        .unwrap();
    assert_eq!(r.len(), 1);
}

#[tokio::test]
async fn session_use_sets_database_for_later_statements() {
    let Some((m, h)) = setup().await else { return };

    let mut use_req = req("USE shop", "s4", 10);
    use_req.database = None;
    execute::execute(&m, &h, use_req).await.unwrap();

    let mut select_req = req("SELECT 1 FROM system.one", "s4", 10);
    select_req.database = None;
    let r = execute::execute(&m, &h, select_req).await.unwrap();
    assert!(matches!(r[0].kind, StatementResultKind::Rows));
    assert_eq!(r[0].rows[0][0], json!(1));

    // a fresh session without the USE never ran against it sees no default database
    let mut other_req = req("SELECT 1 FROM system.one", "s5", 10);
    other_req.database = None;
    let r = execute::execute(&m, &h, other_req).await.unwrap();
    assert!(matches!(r[0].kind, StatementResultKind::Rows));
}

#[tokio::test]
async fn cancel_kills_running_query() {
    let Some((m, h)) = setup().await else { return };
    // No max_execution_time set on purpose — cancellation, not a timeout, must stop this.
    let mut r = req(
        "SELECT sleepEachRow(1) FROM numbers(60) SETTINGS max_block_size = 1",
        "s6",
        10,
    );
    r.query_id = "ch-cancel".into();
    let start = std::time::Instant::now();
    let exec = execute::execute(&m, &h, r);
    let cancel = async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        m.cancel_query("c1", "ch-cancel").await
    };
    let (res, cancel_res) = tokio::join!(exec, cancel);
    cancel_res.expect("cancel");
    let res = res.unwrap();
    assert!(start.elapsed().as_secs() < 30, "the query was not cancelled");
    assert!(matches!(res[0].kind, StatementResultKind::Error), "{:?}", res[0]);

    // the session keeps working after the cancellation
    let r = execute::execute(&m, &h, req("SELECT 5", "s6", 10)).await.unwrap();
    assert_eq!(r[0].rows[0][0], json!(5));
}

#[tokio::test]
async fn schema_queries() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req(
            "DROP TABLE IF EXISTS ch_types; \
             CREATE TABLE ch_types (id UInt64, s Nullable(String)) ENGINE = MergeTree ORDER BY id; \
             DROP VIEW IF EXISTS ch_view; \
             CREATE VIEW ch_view AS SELECT * FROM ch_types",
            "s7",
            10,
        ),
    )
    .await
    .unwrap();

    let driver = m.driver("c1").unwrap();
    let dbs = driver.list_databases().await.unwrap();
    assert!(dbs.contains(&"shop".to_string()));

    let tables = driver.list_tables("shop").await.unwrap();
    let types_table = tables.iter().find(|t| t.name == "ch_types").unwrap();
    assert_eq!(types_table.engine.as_deref(), Some("MergeTree"));
    assert!(matches!(types_table.kind, TableKind::Table));
    let view = tables.iter().find(|t| t.name == "ch_view").unwrap();
    assert!(matches!(view.kind, TableKind::View));

    let cols = driver.list_columns("shop", "ch_types").await.unwrap();
    assert_eq!(cols[0].name, "id");
    assert_eq!(cols[0].key, "PRI"); // the ORDER BY column

    let idx = driver.list_indexes("shop", "ch_types").await.unwrap();
    assert!(idx.iter().any(|i| i.name == "PRIMARY"));

    let fks = driver.list_foreign_keys("shop", "ch_types").await.unwrap();
    assert!(fks.is_empty());
}

#[tokio::test]
async fn table_ddl_starts_with_create_table() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req(
            "DROP TABLE IF EXISTS ch_types; CREATE TABLE ch_types (id UInt64) ENGINE = MergeTree ORDER BY id",
            "s8",
            10,
        ),
    )
    .await
    .unwrap();

    let driver = m.driver("c1").unwrap();
    let ddl = driver.table_ddl("shop", "ch_types").await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE"), "{ddl}");
}

#[tokio::test]
async fn apply_changes_is_not_supported() {
    let Some((m, _h)) = setup().await else { return };
    let result = execute::apply_changes(
        &m,
        "c1",
        "s9",
        vec![ParamStatement {
            sql: "SELECT 1".into(),
            params: vec![],
        }],
    )
    .await;
    assert!(result.is_err());
}
