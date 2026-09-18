//! Integration tests against a live Redis/Valkey server. Run with:
//! QUERYCRAFT_TEST_REDIS_DSN="127.0.0.1:33076::secret" cargo test --test live_redis -- --test-threads=1
//! The user field may be empty (the default ACL user). Add a 5th DSN field
//! ("valkey") or set QUERYCRAFT_TEST_REDIS_KIND=valkey to run against Valkey
//! instead of Redis. Without the environment variable the tests are skipped.

use query_craft_lib::connections::{Credentials, StoredConnectionView};
use query_craft_lib::db::execute::{self, ExecuteRequest};
use query_craft_lib::db::{ConnectionManager, DbKind, ParamStatement, StatementResultKind};
use query_craft_lib::history::History;
use serde_json::{json, Value};

fn dsn() -> Option<(StoredConnectionView, String)> {
    let raw = std::env::var("QUERYCRAFT_TEST_REDIS_DSN").ok()?;
    let parts: Vec<&str> = raw.split(':').collect();
    assert!(
        parts.len() == 4 || parts.len() == 5,
        "DSN: host:port:user:password[:kind]"
    );
    let kind_field = parts.get(4).map(|s| s.to_ascii_lowercase());
    let kind_env = std::env::var("QUERYCRAFT_TEST_REDIS_KIND")
        .ok()
        .map(|s| s.to_ascii_lowercase());
    let kind = if kind_field.as_deref() == Some("valkey") || kind_env.as_deref() == Some("valkey") {
        DbKind::Valkey
    } else {
        DbKind::Redis
    };
    Some((
        StoredConnectionView {
            kind,
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
    let history = History::at_path(std::env::temp_dir().join("querycraft-test-history-redis.json"));
    Some((manager, history))
}

fn req(sql: &str, session: &str) -> ExecuteRequest {
    ExecuteRequest {
        connection_id: "c1".into(),
        session_id: session.into(),
        query_id: uuid::Uuid::new_v4().to_string(),
        sql: sql.into(),
        max_rows: 500,
        database: Some("0".into()),
        stop_on_error: true,
    }
}

#[tokio::test]
async fn connect_reports_server_version_and_connection_id() {
    let Some((view, pass)) = dsn() else { return };
    let manager = ConnectionManager::new();
    let info = manager
        .connect("c-version", &view, Credentials::password(Some(pass)))
        .await
        .expect("connect");
    assert!(!info.server_version.is_empty(), "{info:?}");
    assert!(info.connection_id.is_some());
}

#[tokio::test]
async fn set_get_del_round_trip() {
    let Some((m, h)) = setup().await else { return };
    let script = "SET qc:str \"hello world\"\n# a comment line\nGET qc:str\nDEL qc:str";
    let r = execute::execute(&m, &h, req(script, "s1")).await.unwrap();
    assert_eq!(r.len(), 3, "{r:?}");
    assert_eq!(r[0].rows[0][0], json!("OK"));
    assert_eq!(r[1].rows[0][0], json!("hello world"));
    assert_eq!(r[2].rows[0][0], json!(1));
}

#[tokio::test]
async fn hset_hgetall_gives_field_value_columns() {
    let Some((m, h)) = setup().await else { return };
    let script = "HSET qc:hash f1 v1 f2 v2\nHGETALL qc:hash";
    let r = execute::execute(&m, &h, req(script, "s2")).await.unwrap();
    let names: Vec<&str> = r[1].columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["field", "value"]);
    assert_eq!(r[1].rows.len(), 2);
    execute::execute(&m, &h, req("DEL qc:hash", "s2")).await.unwrap();
}

#[tokio::test]
async fn zadd_zrange_withscores_gives_member_score() {
    let Some((m, h)) = setup().await else { return };
    let script = "ZADD qc:zset 1 a 2 b\nZRANGE qc:zset 0 -1 WITHSCORES";
    let r = execute::execute(&m, &h, req(script, "s3")).await.unwrap();
    let names: Vec<&str> = r[1].columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["member", "score"]);
    assert_eq!(
        r[1].rows,
        vec![vec![json!("a"), json!(1.0)], vec![json!("b"), json!(2.0)]]
    );
    execute::execute(&m, &h, req("DEL qc:zset", "s3")).await.unwrap();
}

#[tokio::test]
async fn scan_gives_two_result_sets() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(&m, &h, req("SET qc:scan:1 a", "s4")).await.unwrap();
    execute::execute(&m, &h, req("SET qc:scan:2 b", "s4")).await.unwrap();

    let r = execute::execute(&m, &h, req("SCAN 0 MATCH qc:scan:*", "s4"))
        .await
        .unwrap();
    assert_eq!(r.len(), 2, "{r:?}");
    assert_eq!(r[0].columns[0].name, "cursor");
    assert_eq!(r[1].columns[0].name, "key");

    execute::execute(&m, &h, req("DEL qc:scan:1 qc:scan:2", "s4"))
        .await
        .unwrap();
}

#[tokio::test]
async fn list_keys_reports_types_lengths_and_ttl() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(&m, &h, req("SET qc:lk:str hello", "s5"))
        .await
        .unwrap();
    execute::execute(&m, &h, req("HSET qc:lk:hash f v", "s5"))
        .await
        .unwrap();

    let driver = m.driver("c1").unwrap();
    let listing = driver.list_keys("0", "qc:lk:*", 10).await.unwrap();
    assert!(!listing.truncated);

    let str_key = listing.keys.iter().find(|k| k.name == "qc:lk:str").unwrap();
    assert_eq!(str_key.key_type, "string");
    assert_eq!(str_key.length, Some(5));
    assert_eq!(str_key.ttl, None);

    let hash_key = listing.keys.iter().find(|k| k.name == "qc:lk:hash").unwrap();
    assert_eq!(hash_key.key_type, "hash");
    assert_eq!(hash_key.length, Some(1));

    execute::execute(&m, &h, req("DEL qc:lk:str qc:lk:hash", "s5"))
        .await
        .unwrap();
}

#[tokio::test]
async fn list_databases_has_zero() {
    let Some((m, _h)) = setup().await else { return };
    let driver = m.driver("c1").unwrap();
    let dbs = driver.list_databases().await.unwrap();
    assert!(dbs.contains(&"0".to_string()), "{dbs:?}");
}

#[tokio::test]
async fn refused_command_produces_an_error_result() {
    let Some((m, h)) = setup().await else { return };
    let r = execute::execute(&m, &h, req("SUBSCRIBE x", "s6")).await.unwrap();
    assert_eq!(r.len(), 1);
    assert!(matches!(r[0].kind, StatementResultKind::Error), "{:?}", r[0]);
}

#[tokio::test]
async fn select_switches_the_session_database() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(&m, &h, req("SELECT 1\nSET qc:db1:key v", "s7"))
        .await
        .unwrap();

    let driver = m.driver("c1").unwrap();
    let listing0 = driver.list_keys("0", "qc:db1:*", 10).await.unwrap();
    assert!(listing0.keys.is_empty(), "{:?}", listing0.keys);
    let listing1 = driver.list_keys("1", "qc:db1:*", 10).await.unwrap();
    assert_eq!(listing1.keys.len(), 1);

    execute::execute(&m, &h, req("SELECT 1\nDEL qc:db1:key", "s7"))
        .await
        .unwrap();
}

#[tokio::test]
async fn apply_runs_statements_in_one_transaction() {
    let Some((m, h)) = setup().await else { return };
    let statements = vec![
        ParamStatement {
            sql: "SELECT".into(),
            params: vec![json!(0)],
        },
        ParamStatement {
            sql: "hset".into(),
            params: vec![json!("qc:h"), json!("f1"), json!("v1")],
        },
        ParamStatement {
            sql: "HSET".into(),
            params: vec![json!("qc:h"), json!("f2"), json!("v2")],
        },
        ParamStatement {
            sql: "HDEL".into(),
            params: vec![json!("qc:h"), json!("f1")],
        },
    ];
    let result = execute::apply_changes(&m, "c1", "s-apply1", statements).await.unwrap();
    assert_eq!(result.affected_rows, 4);

    let r = execute::execute(&m, &h, req("HGETALL qc:h", "s-apply1")).await.unwrap();
    assert_eq!(r[0].rows, vec![vec![json!("f2"), json!("v2")]]);

    execute::execute(&m, &h, req("DEL qc:h", "s-apply1")).await.unwrap();
}

#[tokio::test]
async fn apply_sends_a_numeric_param_as_decimal_text() {
    let Some((m, h)) = setup().await else { return };
    let statements = vec![ParamStatement {
        sql: "ZADD".into(),
        params: vec![json!("qc:z"), json!(1.5), json!("a")],
    }];
    let result = execute::apply_changes(&m, "c1", "s-apply2", statements).await.unwrap();
    assert_eq!(result.affected_rows, 1);

    let r = execute::execute(&m, &h, req("ZSCORE qc:z a", "s-apply2"))
        .await
        .unwrap();
    let cell = &r[0].rows[0][0];
    let score = cell.as_f64().or_else(|| cell.as_str().and_then(|s| s.parse().ok()));
    assert_eq!(score, Some(1.5), "{cell:?}");

    execute::execute(&m, &h, req("DEL qc:z", "s-apply2")).await.unwrap();
}

#[tokio::test]
async fn apply_rejects_a_null_param_and_writes_nothing() {
    let Some((m, h)) = setup().await else { return };
    let statements = vec![ParamStatement {
        sql: "SET".into(),
        params: vec![json!("qc:null"), Value::Null],
    }];
    let result = execute::apply_changes(&m, "c1", "s-apply3", statements).await;
    assert!(result.is_err());

    let r = execute::execute(&m, &h, req("EXISTS qc:null", "s-apply3"))
        .await
        .unwrap();
    assert_eq!(r[0].rows[0][0], json!(0));
}

#[tokio::test]
async fn apply_refuses_a_disallowed_command_before_running_anything() {
    let Some((m, h)) = setup().await else { return };
    let statements = vec![
        ParamStatement {
            sql: "SET".into(),
            params: vec![json!("qc:refused"), json!("v")],
        },
        ParamStatement {
            sql: "SUBSCRIBE".into(),
            params: vec![json!("x")],
        },
    ];
    let result = execute::apply_changes(&m, "c1", "s-apply4", statements).await;
    assert!(result.is_err());

    let r = execute::execute(&m, &h, req("EXISTS qc:refused", "s-apply4"))
        .await
        .unwrap();
    assert_eq!(r[0].rows[0][0], json!(0));
}

#[tokio::test]
async fn apply_expire_and_persist_change_ttl() {
    let Some((m, h)) = setup().await else { return };
    execute::execute(&m, &h, req("SET qc:ttl v", "s-apply5")).await.unwrap();

    let expire = vec![ParamStatement {
        sql: "EXPIRE".into(),
        params: vec![json!("qc:ttl"), json!(100)],
    }];
    execute::apply_changes(&m, "c1", "s-apply5", expire).await.unwrap();

    let r = execute::execute(&m, &h, req("TTL qc:ttl", "s-apply5")).await.unwrap();
    let ttl = r[0].rows[0][0].as_i64().expect("TTL is an integer");
    assert!((1..=100).contains(&ttl), "{ttl}");

    let persist = vec![ParamStatement {
        sql: "PERSIST".into(),
        params: vec![json!("qc:ttl")],
    }];
    execute::apply_changes(&m, "c1", "s-apply5", persist).await.unwrap();

    let r = execute::execute(&m, &h, req("TTL qc:ttl", "s-apply5")).await.unwrap();
    assert_eq!(r[0].rows[0][0], json!(-1));

    execute::execute(&m, &h, req("DEL qc:ttl", "s-apply5")).await.unwrap();
}

/// Safety net: removes any `qc:*` key left behind in databases 0 and 1 by a
/// test that failed before reaching its own cleanup.
#[tokio::test]
async fn zz_cleanup_leftover_keys() {
    let Some((m, h)) = setup().await else { return };
    let driver = m.driver("c1").unwrap();
    for db in ["0", "1"] {
        let listing = driver.list_keys(db, "qc:*", 1000).await.unwrap();
        if listing.keys.is_empty() {
            continue;
        }
        let names: Vec<String> = listing.keys.into_iter().map(|k| k.name).collect();
        let script = format!("SELECT {db}\nDEL {}", names.join(" "));
        execute::execute(&m, &h, req(&script, "s-cleanup")).await.unwrap();
    }
}
