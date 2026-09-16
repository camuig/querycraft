//! SSH tunnel (DataGrip's "SSH/SSL" tab): a local TCP listener whose every
//! accepted connection is forwarded to the database host through a
//! `direct-tcpip` channel of one SSH session. Drivers then connect to
//! `127.0.0.1:<local port>` exactly as they would to the database itself.
//!
//! Host keys are checked against `~/.ssh/known_hosts` the way OpenSSH does
//! with `StrictHostKeyChecking=accept-new`: an unknown host is recorded on
//! first use, a host whose key changed is refused.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle, Handler};
use russh::keys::agent::client::AgentClient;
use russh::keys::{self, known_hosts, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::connections::{SshAuth, SshConfig};
use crate::error::{AppError, AppResult};

const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Where the host key check reads and records keys.
#[derive(Debug, Clone, Default)]
pub enum KnownHosts {
    /// `~/.ssh/known_hosts`.
    #[default]
    Standard,
    /// A specific file (tests keep their throwaway servers out of the user's file).
    File(PathBuf),
}

/// What to do with a server key, given whether the known-hosts file knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostKeyDecision {
    Trusted,
    /// First contact: accept and remember the key.
    Learn,
    /// The recorded key differs — a possible man-in-the-middle, refuse.
    Changed,
}

fn decide_host_key(check: Result<bool, keys::Error>) -> HostKeyDecision {
    match check {
        Ok(true) => HostKeyDecision::Trusted,
        Ok(false) => HostKeyDecision::Learn,
        Err(keys::Error::KeyChanged { .. }) => HostKeyDecision::Changed,
        // No known_hosts file yet, or an unreadable one: treat as first contact.
        Err(_) => HostKeyDecision::Learn,
    }
}

#[derive(Debug, thiserror::Error)]
enum TunnelError {
    #[error(transparent)]
    Ssh(#[from] russh::Error),
    #[error("Host key for {host}:{port} has changed; remove the old entry from {file} if the server was reinstalled")]
    HostKeyChanged { host: String, port: u16, file: String },
}

struct TunnelHandler {
    host: String,
    port: u16,
    known_hosts: KnownHosts,
}

impl TunnelHandler {
    fn check(&self, key: &PublicKey) -> Result<bool, keys::Error> {
        match &self.known_hosts {
            KnownHosts::Standard => known_hosts::check_known_hosts(&self.host, self.port, key),
            KnownHosts::File(path) => known_hosts::check_known_hosts_path(&self.host, self.port, key, path),
        }
    }

    fn learn(&self, key: &PublicKey) -> Result<(), keys::Error> {
        match &self.known_hosts {
            KnownHosts::Standard => known_hosts::learn_known_hosts(&self.host, self.port, key),
            KnownHosts::File(path) => known_hosts::learn_known_hosts_path(&self.host, self.port, key, path),
        }
    }

    fn file_name(&self) -> String {
        match &self.known_hosts {
            KnownHosts::Standard => "~/.ssh/known_hosts".to_string(),
            KnownHosts::File(path) => path.display().to_string(),
        }
    }
}

impl Handler for TunnelHandler {
    type Error = TunnelError;

    async fn check_server_key(&mut self, server_public_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        match decide_host_key(self.check(&key)) {
            HostKeyDecision::Trusted => Ok(true),
            HostKeyDecision::Learn => {
                if let Err(e) = self.learn(&key) {
                    log::warn!("Could not record the host key of {}:{}: {e}", self.host, self.port);
                }
                Ok(true)
            }
            HostKeyDecision::Changed => Err(TunnelError::HostKeyChanged {
                host: self.host.clone(),
                port: self.port,
                file: self.file_name(),
            }),
        }
    }
}

/// An open tunnel; dropping it stops accepting connections and closes the SSH session.
pub struct SshTunnel {
    local_addr: SocketAddr,
    session: Arc<Handle<TunnelHandler>>,
    accept_task: JoinHandle<()>,
}

impl SshTunnel {
    /// Connects to the SSH host, authenticates and starts forwarding a local
    /// port to `target_host:target_port` as seen from the SSH host.
    pub async fn open(
        config: &SshConfig,
        secret: Option<&str>,
        target_host: &str,
        target_port: u16,
        known_hosts: KnownHosts,
    ) -> AppResult<Self> {
        let ssh_config = Arc::new(client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            nodelay: true,
            ..Default::default()
        });
        let handler = TunnelHandler {
            host: config.host.clone(),
            port: config.port,
            known_hosts,
        };

        let connect = client::connect(ssh_config, (config.host.as_str(), config.port), handler);
        let mut session = tokio::time::timeout(CONNECT_TIMEOUT, connect)
            .await
            .map_err(|_| AppError::Other(format!("SSH connection to {}:{} timed out", config.host, config.port)))?
            .map_err(|e| AppError::Other(format!("SSH connection to {}:{} failed: {e}", config.host, config.port)))?;

        authenticate(&mut session, config, secret).await?;

        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let local_addr = listener.local_addr()?;
        let session = Arc::new(session);
        let accept_task = tokio::spawn(accept_loop(
            listener,
            session.clone(),
            target_host.to_string(),
            target_port,
        ));

        Ok(Self {
            local_addr,
            session,
            accept_task,
        })
    }

    /// The local end of the tunnel: what the database driver connects to.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Stops forwarding and closes the SSH session.
    pub async fn close(&self) {
        self.accept_task.abort();
        let _ = self
            .session
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

async fn authenticate(session: &mut Handle<TunnelHandler>, config: &SshConfig, secret: Option<&str>) -> AppResult<()> {
    let failed = |what: &str| {
        AppError::Other(format!(
            "SSH authentication failed for {}@{}: {what}",
            config.user, config.host
        ))
    };
    let ssh_err = |e: russh::Error| AppError::Other(format!("SSH authentication error: {e}"));

    match config.auth {
        SshAuth::Password => {
            let password = secret.ok_or_else(|| failed("no password given"))?;
            let result = session
                .authenticate_password(config.user.clone(), password)
                .await
                .map_err(ssh_err)?;
            if !result.success() {
                return Err(failed("the password was rejected"));
            }
        }
        SshAuth::Key => {
            let path = config
                .key_path
                .as_deref()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| failed("no private key file chosen"))?;
            let key = load_private_key(Path::new(path), secret)?;
            let hash_alg = session.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten();
            let result = session
                .authenticate_publickey(config.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg))
                .await
                .map_err(ssh_err)?;
            if !result.success() {
                return Err(failed("the key was rejected"));
            }
        }
        SshAuth::Agent => {
            let agent = connect_agent().await?;
            return authenticate_with_agent(session, config, agent).await;
        }
    }
    Ok(())
}

/// The OpenSSH agent at `SSH_AUTH_SOCK` (a Unix socket).
#[cfg(unix)]
async fn connect_agent() -> AppResult<AgentClient<tokio::net::UnixStream>> {
    AgentClient::connect_env()
        .await
        .map_err(|e| AppError::Other(format!("Cannot reach the SSH agent (SSH_AUTH_SOCK): {e}")))
}

/// The Windows OpenSSH agent listens on a named pipe rather than a socket;
/// `SSH_AUTH_SOCK` may still name a different pipe.
#[cfg(windows)]
async fn connect_agent() -> AppResult<AgentClient<tokio::net::windows::named_pipe::NamedPipeClient>> {
    let pipe = std::env::var("SSH_AUTH_SOCK").unwrap_or_else(|_| r"\\.\pipe\openssh-ssh-agent".to_string());
    AgentClient::connect_named_pipe(&pipe)
        .await
        .map_err(|e| AppError::Other(format!("Cannot reach the SSH agent at {pipe}: {e}")))
}

/// Tries every identity the agent holds until the server accepts one.
async fn authenticate_with_agent<S>(
    session: &mut Handle<TunnelHandler>,
    config: &SshConfig,
    mut agent: AgentClient<S>,
) -> AppResult<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::Other(format!("The SSH agent returned no identities: {e}")))?;
    let hash_alg = session
        .best_supported_rsa_hash()
        .await
        .map_err(|e| AppError::Other(format!("SSH authentication error: {e}")))?
        .flatten();
    let mut tried = 0;
    for identity in identities {
        let keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        tried += 1;
        let result = session
            .authenticate_publickey_with(config.user.clone(), key, hash_alg, &mut agent)
            .await
            .map_err(|e| AppError::Other(format!("SSH agent authentication error: {e}")))?;
        if result.success() {
            return Ok(());
        }
    }
    Err(AppError::Other(format!(
        "SSH authentication failed for {}@{}: none of the {tried} agent keys was accepted",
        config.user, config.host
    )))
}

/// Reads an OpenSSH / PKCS#8 / PEM private key, decrypting it with the passphrase when it has one.
fn load_private_key(path: &Path, passphrase: Option<&str>) -> AppResult<keys::PrivateKey> {
    let expanded = expand_home(path);
    keys::load_secret_key(&expanded, passphrase.filter(|p| !p.is_empty()))
        .map_err(|e| AppError::Other(format!("Cannot load the SSH private key {}: {e}", expanded.display())))
}

/// `~/x` -> `<home>/x`, since file pickers produce absolute paths but people type `~`.
fn expand_home(path: &Path) -> PathBuf {
    let Ok(rest) = path.strip_prefix("~") else {
        return path.to_path_buf();
    };
    match dirs::home_dir() {
        Some(home) => home.join(rest),
        None => path.to_path_buf(),
    }
}

/// Accepts local connections for the lifetime of the tunnel and forwards each
/// one through its own SSH channel.
async fn accept_loop(
    listener: TcpListener,
    session: Arc<Handle<TunnelHandler>>,
    target_host: String,
    target_port: u16,
) {
    loop {
        let (socket, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                log::warn!("SSH tunnel listener stopped: {e}");
                return;
            }
        };
        let session = session.clone();
        let target_host = target_host.clone();
        tokio::spawn(async move {
            if let Err(e) = forward(socket, peer, &session, &target_host, target_port).await {
                log::debug!("SSH tunnel connection to {target_host}:{target_port} ended: {e}");
            }
        });
    }
}

async fn forward(
    mut socket: TcpStream,
    peer: SocketAddr,
    session: &Handle<TunnelHandler>,
    target_host: &str,
    target_port: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let channel = session
        .channel_open_direct_tcpip(
            target_host,
            u32::from(target_port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await?;
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_key_is_trusted() {
        assert_eq!(decide_host_key(Ok(true)), HostKeyDecision::Trusted);
    }

    #[test]
    fn unknown_key_is_learned() {
        assert_eq!(decide_host_key(Ok(false)), HostKeyDecision::Learn);
        let io = keys::Error::IO(std::io::Error::other("no such file"));
        assert_eq!(decide_host_key(Err(io)), HostKeyDecision::Learn);
    }

    #[test]
    fn changed_key_is_refused() {
        assert_eq!(
            decide_host_key(Err(keys::Error::KeyChanged { line: 3 })),
            HostKeyDecision::Changed
        );
    }

    #[test]
    fn expand_home_replaces_tilde_only_as_prefix() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            expand_home(Path::new("~/.ssh/id_ed25519")),
            home.join(".ssh/id_ed25519")
        );
        assert_eq!(expand_home(Path::new("/etc/x~")), PathBuf::from("/etc/x~"));
    }
}
