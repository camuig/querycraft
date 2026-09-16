//! Integration tests against a live MySQL server. Run with:
//! QUERYCRAFT_TEST_DSN="127.0.0.1:33070:root:secret" cargo test --test live_mysql
//! Without the environment variable the tests are skipped.

use query_craft_lib::connections::{Credentials, StoredConnectionView};
use query_craft_lib::db::execute::{self, CountRequest, ExecuteRequest, ExportRequest};
use query_craft_lib::db::export::ExportFormat;
use query_craft_lib::db::{ConnectionManager, DbKind, ParamStatement, StatementResultKind, TableKind};
use query_craft_lib::history::History;
use serde_json::{json, Value};

fn dsn() -> Option<(StoredConnectionView, String)> {
    let raw = std::env::var("QUERYCRAFT_TEST_DSN").ok()?;
    let parts: Vec<&str> = raw.split(':').collect();
    assert_eq!(parts.len(), 4, "DSN: host:port:user:password");
    Some((
        StoredConnectionView {
            kind: DbKind::Mysql,
            host: parts[0].to_string(),
            port: parts[1].parse().unwrap(),
            user: parts[2].to_string(),
            database: None,
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
    let history = History::at_path(std::env::temp_dir().join("querycraft-test-history.json"));
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
    let r = execute::execute(&m, &h, req("SELECT * FROM customers ORDER BY id", "s1", 500))
        .await
        .unwrap();
    assert_eq!(r.len(), 1);
    let res = &r[0];
    assert!(matches!(res.kind, StatementResultKind::Rows));
    let names: Vec<&str> = res.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names[..3], ["id", "email", "name"]);
    assert!(res.columns[0].primary_key && res.columns[0].unsigned);
    let alice = &res.rows[0];
    assert_eq!(alice[0], json!(1));
    assert_eq!(alice[1], json!("alice@example.com"));
    assert_eq!(alice[3], json!("100.50")); // DECIMAL -> string
    assert_eq!(alice[4], json!(1)); // TINYINT(1)
    assert_eq!(alice[5], json!("1990-05-01")); // DATE
    assert!(alice[6].as_str().unwrap().starts_with("20")); // DATETIME(3)
    assert_eq!(alice[7], json!("{\"vip\": true}")); // JSON
    assert_eq!(alice[8], json!("0x89504E47")); // BLOB -> hex
    assert_eq!(alice[9], json!("9007199254740993")); // BIGINT > 2^53 -> string
    assert!(res.columns[8].binary);
    let bob = &res.rows[1];
    assert_eq!(bob[5], Value::Null);
    assert_eq!(bob[7], Value::Null);
    let carol = &res.rows[2];
    assert_eq!(carol[2], json!("Кэрол"));
    assert_eq!(carol[3], json!("-12.25"));
    assert_eq!(carol[9], json!(123));

    let r = execute::execute(
        &m,
        &h,
        req("SELECT weight, rating, price FROM products WHERE id=1", "s1", 500),
    )
    .await
    .unwrap();
    assert_eq!(r[0].rows[0], vec![json!(0.5), json!(4.5), json!("9.99")]);
    assert_eq!(r[0].columns[0].type_name, "FLOAT");
    assert_eq!(r[0].columns[2].type_name, "DECIMAL");
}

#[tokio::test]
async fn multiple_statements_truncation_and_errors() {
    let Some((m, h)) = setup().await else { return };
    let sql =
        "SELECT id FROM big_table ORDER BY id; UPDATE big_table SET v = v WHERE id < 5; SELECT * FROM nope; SELECT 1";
    let mut r = req(sql, "s2", 100);
    r.stop_on_error = false;
    let r = execute::execute(&m, &h, r).await.unwrap();
    assert_eq!(r.len(), 4);
    assert_eq!(r[0].rows.len(), 100);
    assert!(r[0].truncated);
    assert!(matches!(r[1].kind, StatementResultKind::Affected));
    assert_eq!(r[1].affected_rows, 0); // values did not change
    assert!(matches!(r[2].kind, StatementResultKind::Error));
    assert!(r[2].error.as_ref().unwrap().contains("1146"), "{:?}", r[2].error);
    assert_eq!(r[3].rows[0][0], json!(1));

    // stop_on_error
    let r = execute::execute(&m, &h, req("SELECT * FROM nope; SELECT 1", "s2", 100))
        .await
        .unwrap();
    assert_eq!(r.len(), 1);
}

#[tokio::test]
async fn stored_procedure_returns_multiple_sets() {
    let Some((m, h)) = setup().await else { return };
    let r = execute::execute(&m, &h, req("CALL two_sets()", "s3", 100))
        .await
        .unwrap();
    let rows: Vec<_> = r
        .iter()
        .filter(|x| matches!(x.kind, StatementResultKind::Rows))
        .collect();
    assert_eq!(
        rows.len(),
        2,
        "{:?}",
        r.iter().map(|x| (x.kind, x.rows.len())).collect::<Vec<_>>()
    );
    assert_eq!(rows[0].rows[0][0], json!(1));
    assert_eq!(rows[1].rows[0], vec![json!("b"), Value::Null]);
}

#[tokio::test]
async fn session_keeps_state_between_calls() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(&m, &h, req("SET @x = 42", "s4", 10)).await.unwrap();
    let r = execute::execute(&m, &h, req("SELECT @x", "s4", 10)).await.unwrap();
    assert_eq!(r[0].rows[0][0], json!(42));
    // another session does not see the variable
    let r = execute::execute(&m, &h, req("SELECT @x", "s5", 10)).await.unwrap();
    assert_eq!(r[0].rows[0][0], Value::Null);
}

#[tokio::test]
async fn apply_changes_commits_and_rolls_back() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(
        &m,
        &h,
        req(
            "DROP TABLE IF EXISTS t_apply; CREATE TABLE t_apply (id INT PRIMARY KEY, s VARCHAR(10), n INT NULL)",
            "s6",
            10,
        ),
    )
    .await
    .unwrap();
    let ok = execute::apply_changes(
        &m,
        "c1",
        "s6",
        vec![
            ParamStatement {
                sql: "INSERT INTO `shop`.`t_apply` (`id`,`s`,`n`) VALUES (?,?,?)".into(),
                params: vec![json!(1), json!("a"), Value::Null],
            },
            ParamStatement {
                sql: "INSERT INTO `shop`.`t_apply` (`id`,`s`) VALUES (?,?)".into(),
                params: vec![json!(2), json!("ü")],
            },
            ParamStatement {
                sql: "UPDATE `shop`.`t_apply` SET `n`=? WHERE `id`=?".into(),
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
        "s6",
        vec![
            ParamStatement {
                sql: "DELETE FROM `shop`.`t_apply` WHERE `id`=?".into(),
                params: vec![json!(2)],
            },
            ParamStatement {
                sql: "INSERT INTO `shop`.`t_apply` (`id`) VALUES (?)".into(),
                params: vec![json!(1)],
            }, // duplicate PK
        ],
    )
    .await;
    assert!(bad.is_err());
    let r = execute::execute(&m, &h, req("SELECT id, s, n FROM t_apply ORDER BY id", "s6", 10))
        .await
        .unwrap();
    assert_eq!(
        r[0].rows,
        vec![
            vec![json!(1), json!("a"), json!(7)],
            vec![json!(2), json!("ü"), Value::Null]
        ]
    );
    execute::execute(&m, &h, req("DROP TABLE t_apply", "s6", 10))
        .await
        .unwrap();
}

#[tokio::test]
async fn cancel_kills_running_query() {
    let Some((m, h)) = setup().await else { return };
    let mut r = req("SELECT SLEEP(10)", "s7", 10);
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
    assert!(start.elapsed().as_secs() < 5, "the query was not cancelled");
    // SLEEP returns 1 or error 1317 after KILL QUERY; both are acceptable
    assert!(matches!(
        res[0].kind,
        StatementResultKind::Rows | StatementResultKind::Error
    ));
    // the session keeps working after the cancellation
    let r = execute::execute(&m, &h, req("SELECT 5", "s7", 10)).await.unwrap();
    assert_eq!(r[0].rows[0][0], json!(5));
}

#[tokio::test]
async fn schema_queries() {
    let Some((m, _h)) = setup().await else { return };
    let driver = m.driver("c1").unwrap();
    let dbs = driver.list_databases().await.unwrap();
    assert!(dbs.contains(&"shop".to_string()));
    let tables = driver.list_tables("shop").await.unwrap();
    let view = tables.iter().find(|t| t.name == "active_customers").unwrap();
    assert!(matches!(view.kind, TableKind::View));
    let customers = tables.iter().find(|t| t.name == "customers").unwrap();
    assert_eq!(customers.comment, "Покупатели");
    let cols = driver.list_columns("shop", "customers").await.unwrap();
    assert_eq!(cols[0].name, "id");
    assert_eq!(cols[0].key, "PRI");
    assert!(cols[0].extra.contains("auto_increment"));
    assert_eq!(cols[0].column_type, "int unsigned");
    let idx = driver.list_indexes("shop", "orders").await.unwrap();
    let composite = idx.iter().find(|i| i.name == "idx_orders_customer_status").unwrap();
    assert_eq!(composite.columns, vec!["customer_id", "status"]);
    let fks = driver.list_foreign_keys("shop", "orders").await.unwrap();
    assert_eq!(fks[0].name, "fk_orders_customer");
    assert_eq!(fks[0].ref_table, "customers");
    assert_eq!(fks[0].on_delete, "CASCADE");
    let ddl = driver.table_ddl("shop", "customers").await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE `customers`"));
    let vddl = driver.table_ddl("shop", "active_customers").await.unwrap();
    assert!(vddl.contains("VIEW"), "{vddl}");
}

#[tokio::test]
async fn export_ignores_the_grid_row_limit() {
    let Some((m, _h)) = setup().await else { return };
    // 4096 rows from a self-join of an 8-row derived table (2^12).
    let sql = "SELECT a.n * 1000 + b.n * 100 + c.n * 10 + d.n AS id \
               FROM (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 \
                     UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7) a \
               JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 \
                     UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7) b \
               JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 \
                     UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7) c \
               JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 \
                     UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7) d \
               ORDER BY id";
    let out = std::env::temp_dir().join(format!("querycraft-test-export-{}.json", uuid::Uuid::new_v4()));
    let summary = execute::export(
        &m,
        ExportRequest {
            connection_id: "c1".into(),
            session_id: "s-export".into(),
            query_id: uuid::Uuid::new_v4().to_string(),
            sql: sql.into(),
            database: Some("shop".into()),
            format: ExportFormat::Json,
            path: out.to_string_lossy().into_owned(),
        },
    )
    .await
    .expect("export");
    assert_eq!(summary.rows, 4096);
    let parsed: Vec<serde_json::Map<String, Value>> =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(parsed.len(), 4096);
    assert_eq!(parsed[4095]["id"], json!(7777));
    let _ = std::fs::remove_file(&out);

    let total = execute::count(
        &m,
        CountRequest {
            connection_id: "c1".into(),
            session_id: "s-export".into(),
            query_id: uuid::Uuid::new_v4().to_string(),
            sql: format!("{sql};"),
            database: Some("shop".into()),
        },
    )
    .await
    .expect("count");
    assert_eq!(total, 4096);
}
