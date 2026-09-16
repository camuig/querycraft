//! SSH tunnel integration tests against the throwaway server started by
//! `scripts/ssh-server.sh` (user `qc`, password `secret`, keys in
//! `$TMPDIR/querycraft-ssh`) with the docker-compose databases on the same
//! docker network. Run with:
//! QUERYCRAFT_TEST_SSH=1 cargo test --test live_ssh
//! `QUERYCRAFT_TEST_SSH_KEYS` overrides the key directory. The agent test
//! additionally needs `QUERYCRAFT_TEST_SSH_AGENT=1` and an agent (SSH_AUTH_SOCK)
//! holding `id_ed25519`. Without `QUERYCRAFT_TEST_SSH` the tests are skipped.

use std::path::PathBuf;

use query_craft_lib::connections::{Credentials, SshAuth, SshConfig, StoredConnectionView};
use query_craft_lib::db::execute::{self, ExecuteRequest};
use query_craft_lib::db::ssh::KnownHosts;
use query_craft_lib::db::{ConnectionManager, DbKind, StatementResultKind};
use query_craft_lib::history::History;
use serde_json::json;

const SSH_HOST: &str = "127.0.0.1";
const SSH_PORT: u16 = 33075;

fn keys_dir() -> Option<PathBuf> {
    std::env::var("QUERYCRAFT_TEST_SSH").ok()?;
    Some(
        std::env::var("QUERYCRAFT_TEST_SSH_KEYS")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("querycraft-ssh")),
    )
}

fn ssh(auth: SshAuth, key_path: Option<PathBuf>) -> SshConfig {
    SshConfig {
        host: SSH_HOST.into(),
        port: SSH_PORT,
        user: "qc".into(),
        auth,
        key_path: key_path.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// MariaDB as seen from inside the docker network: the tunnel target is the
/// container name, which does not resolve on the host at all.
fn mariadb_via(ssh: SshConfig, ssl: bool) -> StoredConnectionView {
    StoredConnectionView {
        kind: DbKind::Mariadb,
        host: "querycraft-mariadb".into(),
        port: 3306,
        user: "root".into(),
        database: Some("shop".into()),
        ssl,
        ssl_verify: false,
        ssl_ca_path: None,
        path: None,
        ssh: Some(ssh),
    }
}

fn credentials(ssh_secret: &str) -> Credentials {
    Credentials {
        password: Some("secret".into()),
        ssh_secret: Some(ssh_secret.into()),
    }
}

/// A fresh known-hosts file per test so the user's `~/.ssh/known_hosts` is never touched.
fn temp_known_hosts(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("querycraft-known-hosts-{name}-{}", uuid::Uuid::new_v4()))
}

async fn select_one(manager: &ConnectionManager, id: &str) -> serde_json::Value {
    let history = History::at_path(std::env::temp_dir().join("querycraft-ssh-history.json"));
    let results = execute::execute(
        manager,
        &history,
        ExecuteRequest {
            connection_id: id.into(),
            session_id: "s".into(),
            query_id: uuid::Uuid::new_v4().to_string(),
            sql: "SELECT 1 + 1".into(),
            max_rows: 10,
            database: None,
            stop_on_error: true,
        },
    )
    .await
    .unwrap();
    assert!(
        matches!(results[0].kind, StatementResultKind::Rows),
        "{:?}",
        results[0].error
    );
    results[0].rows[0][0].clone()
}

#[tokio::test]
async fn password_tunnel_reaches_the_database() {
    let Some(_keys) = keys_dir() else { return };
    let known_hosts = temp_known_hosts("password");
    let manager = ConnectionManager::new();
    let view = mariadb_via(ssh(SshAuth::Password, None), false);
    let info = manager
        .connect_with("c", &view, credentials("secret"), KnownHosts::File(known_hosts.clone()))
        .await
        .expect("tunnel + connect");
    assert!(info.server_version.contains("MariaDB"), "{}", info.server_version);
    assert_eq!(select_one(&manager, "c").await, json!(2));

    // Sessions are separate tunnel connections and keep working after the first one closed.
    manager.close_session("c", "s").await.unwrap();
    assert_eq!(select_one(&manager, "c").await, json!(2));

    // First contact recorded the host key.
    let recorded = std::fs::read_to_string(&known_hosts).unwrap();
    assert!(recorded.contains(&format!("[{SSH_HOST}]:{SSH_PORT}")), "{recorded}");
    manager.disconnect("c").await.unwrap();
    let _ = std::fs::remove_file(known_hosts);
}

#[tokio::test]
async fn key_tunnel_with_passphrase_and_tls_inside_the_tunnel() {
    let Some(keys) = keys_dir() else { return };
    let manager = ConnectionManager::new();
    // TLS to MariaDB runs inside the tunnel; the certificate is checked against
    // the configured host name, not the tunnel's 127.0.0.1 (verification is off
    // here because the test certificate is self-signed, see live_tls.rs).
    let view = mariadb_via(ssh(SshAuth::Key, Some(keys.join("id_ed25519_pass"))), true);
    manager
        .connect_with(
            "c",
            &view,
            credentials("secret"),
            KnownHosts::File(temp_known_hosts("key")),
        )
        .await
        .expect("key tunnel + tls connect");
    assert_eq!(select_one(&manager, "c").await, json!(2));
    manager.disconnect("c").await.unwrap();
}

#[tokio::test]
async fn agent_tunnel_reaches_the_database() {
    let Some(_keys) = keys_dir() else { return };
    if std::env::var("QUERYCRAFT_TEST_SSH_AGENT").is_err() {
        return;
    }
    let view = mariadb_via(ssh(SshAuth::Agent, None), false);
    let info =
        ConnectionManager::test_connection_with(&view, credentials(""), KnownHosts::File(temp_known_hosts("agent")))
            .await
            .expect("agent tunnel");
    assert!(info.server_version.contains("MariaDB"));
}

#[tokio::test]
async fn key_without_passphrase_and_wrong_secrets_are_reported() {
    let Some(keys) = keys_dir() else { return };
    let ok = mariadb_via(ssh(SshAuth::Key, Some(keys.join("id_ed25519"))), false);
    ConnectionManager::test_connection_with(&ok, credentials(""), KnownHosts::File(temp_known_hosts("plain")))
        .await
        .expect("unencrypted key");

    let wrong_password = mariadb_via(ssh(SshAuth::Password, None), false);
    let err = ConnectionManager::test_connection_with(
        &wrong_password,
        credentials("nope"),
        KnownHosts::File(temp_known_hosts("wrong")),
    )
    .await
    .expect_err("wrong ssh password");
    assert!(err.to_string().contains("SSH authentication failed"), "{err}");

    let wrong_passphrase = mariadb_via(ssh(SshAuth::Key, Some(keys.join("id_ed25519_pass"))), false);
    let err = ConnectionManager::test_connection_with(
        &wrong_passphrase,
        credentials("nope"),
        KnownHosts::File(temp_known_hosts("passphrase")),
    )
    .await
    .expect_err("wrong passphrase");
    assert!(err.to_string().contains("private key"), "{err}");
}

/// The certificate from `scripts/tls-servers.sh` names `querycraft-mariadb`,
/// so full verification succeeds only if TLS checks the configured host name
/// rather than the tunnel's local address.
#[tokio::test]
async fn tls_verification_inside_the_tunnel_uses_the_configured_host_name() {
    let Some(_keys) = keys_dir() else { return };
    let ca = std::env::temp_dir().join("querycraft-tls").join("ca.crt");
    if !ca.exists() {
        return;
    }
    let mut view = mariadb_via(ssh(SshAuth::Password, None), true);
    view.ssl_verify = true;
    view.ssl_ca_path = Some(ca.to_string_lossy().into_owned());
    ConnectionManager::test_connection_with(&view, credentials("secret"), KnownHosts::File(temp_known_hosts("ca")))
        .await
        .expect("verified tls through the tunnel");

    // Without the CA the same certificate is untrusted, proving verification is on.
    view.ssl_ca_path = None;
    ConnectionManager::test_connection_with(&view, credentials("secret"), KnownHosts::File(temp_known_hosts("noca")))
        .await
        .expect_err("self-signed certificate without its CA");
}

/// PostgreSQL redirects the socket with `hostaddr`, ClickHouse with a DNS
/// override; both must still verify the certificate for the configured name.
#[tokio::test]
async fn postgres_and_clickhouse_verify_tls_through_the_tunnel() {
    let Some(_keys) = keys_dir() else { return };
    let ca = std::env::temp_dir().join("querycraft-tls").join("ca.crt");
    if !ca.exists() {
        return;
    }
    let ca = Some(ca.to_string_lossy().into_owned());
    let history = History::at_path(std::env::temp_dir().join("querycraft-ssh-history.json"));

    for (kind, host, port, user, probe) in [
        (
            DbKind::Postgres,
            "querycraft-postgres",
            5432,
            "postgres",
            "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
        ),
        (
            DbKind::Clickhouse,
            "querycraft-clickhouse",
            8443,
            "default",
            "SELECT interface FROM system.processes WHERE query_id = queryID()",
        ),
    ] {
        let view = StoredConnectionView {
            kind,
            host: host.into(),
            port,
            user: user.into(),
            database: Some("shop".into()),
            ssl: true,
            ssl_verify: true,
            ssl_ca_path: ca.clone(),
            path: None,
            ssh: Some(ssh(SshAuth::Password, None)),
        };
        let manager = ConnectionManager::new();
        manager
            .connect_with(
                "c",
                &view,
                credentials("secret"),
                KnownHosts::File(temp_known_hosts("engine")),
            )
            .await
            .unwrap_or_else(|e| panic!("{kind:?} through the tunnel: {e}"));
        let results = execute::execute(
            &manager,
            &history,
            ExecuteRequest {
                connection_id: "c".into(),
                session_id: "s".into(),
                query_id: uuid::Uuid::new_v4().to_string(),
                sql: probe.into(),
                max_rows: 10,
                database: None,
                stop_on_error: true,
            },
        )
        .await
        .unwrap();
        assert!(results[0].error.is_none(), "{kind:?}: {:?}", results[0].error);
        let expected = if kind == DbKind::Postgres {
            json!(true)
        } else {
            json!(2)
        };
        assert_eq!(results[0].rows[0][0], expected, "{kind:?} session is not encrypted");
        manager.disconnect("c").await.unwrap();
    }
}

#[tokio::test]
async fn changed_host_key_is_refused() {
    let Some(_keys) = keys_dir() else { return };
    let known_hosts = temp_known_hosts("changed");
    // A bogus key recorded for the server: the real key must be treated as changed.
    std::fs::write(
        &known_hosts,
        format!("[{SSH_HOST}]:{SSH_PORT} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPUlesnRFhGVWrlVfc4KJztCiKP6eHYCwp9o3Wav34JG\n"),
    )
    .unwrap();
    let view = mariadb_via(ssh(SshAuth::Password, None), false);
    let err =
        ConnectionManager::test_connection_with(&view, credentials("secret"), KnownHosts::File(known_hosts.clone()))
            .await
            .expect_err("changed host key");
    assert!(err.to_string().contains("Host key"), "{err}");
    let _ = std::fs::remove_file(known_hosts);
}
