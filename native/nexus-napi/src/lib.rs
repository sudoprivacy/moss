use napi::bindgen_prelude::*;
use napi_derive::napi;
use nexus_vfs_client::NexusVfsClient;

/// The underlying NexusVfsClient is already thread-safe (sync wrapper
/// around a background tokio thread). All public methods here are
/// synchronous and use napi `AsyncTask` wrappers to avoid blocking the
/// Node.js event loop.

/// The cluster's fixed server-cert SAN. Every `nexusd-cluster` node cert
/// carries this DNS SAN, so an mTLS client validates against `nexus-node`
/// rather than the dialed host/IP. Overridable via the `with_mtls` `domain`
/// arg for non-standard deployments.
const DEFAULT_CLUSTER_SERVER_NAME: &str = "nexus-node";

#[napi]
pub struct NexusGrpcClient {
    inner: NexusVfsClient,
}

#[napi]
impl NexusGrpcClient {
    /// Create a new **plaintext** gRPC client targeting the given endpoint
    /// (e.g. "http://127.0.0.1:2126"). Used by the embedded/dev `serve-local`
    /// daemon (trusted loopback, `--no-tls`).
    /// The TCP connection is lazy — established on first RPC call.
    #[napi(constructor)]
    pub fn new(endpoint: String) -> Result<Self> {
        let inner = NexusVfsClient::connect(&endpoint)
            .map_err(|e| Error::from_reason(format!("gRPC connect failed: {e}")))?;
        Ok(Self { inner })
    }

    /// Create a new **mTLS** gRPC client targeting `endpoint`
    /// (e.g. "https://127.0.0.1:8443" or a bare "host:port"), authenticating
    /// with moss's client identity against the cluster CA. Required to reach
    /// an auth-on production `nexusd-cluster`, which serves mutual TLS and
    /// rejects a plaintext client.
    ///
    /// `ca_path`, `cert_path`, `key_path` are filesystem paths to PEM files:
    /// the cluster CA cert, moss's client cert, and moss's client key. `domain`
    /// optionally overrides the server-cert SAN to validate against (defaults
    /// to `nexus-node`). The TLS handshake is lazy — established on first RPC.
    /// Caller identity still rides the per-request auth token, not the cert.
    #[napi(factory)]
    pub fn with_mtls(
        endpoint: String,
        ca_path: String,
        cert_path: String,
        key_path: String,
        domain: Option<String>,
    ) -> Result<Self> {
        let ca_pem = std::fs::read(&ca_path)
            .map_err(|e| Error::from_reason(format!("read nexus CA cert '{ca_path}': {e}")))?;
        let cert_pem = std::fs::read(&cert_path)
            .map_err(|e| Error::from_reason(format!("read nexus client cert '{cert_path}': {e}")))?;
        let key_pem = std::fs::read(&key_path)
            .map_err(|e| Error::from_reason(format!("read nexus client key '{key_path}': {e}")))?;
        let server_name = domain.as_deref().unwrap_or(DEFAULT_CLUSTER_SERVER_NAME);
        let inner = NexusVfsClient::connect_tls(&endpoint, ca_pem, cert_pem, key_pem, server_name)
            .map_err(|e| Error::from_reason(format!("gRPC mTLS connect failed: {e}")))?;
        Ok(Self { inner })
    }

    /// Generic gRPC call: method name + JSON payload string + auth token.
    /// Returns the response as a JSON string.
    #[napi]
    pub fn call(
        &self,
        method: String,
        payload: String,
        auth_token: String,
    ) -> Result<String> {
        let response = self
            .inner
            .call(&method, payload.as_bytes(), &auth_token)
            .map_err(|e| Error::from_reason(format!("gRPC call failed: {e}")))?;
        String::from_utf8(response)
            .map_err(|e| Error::from_reason(format!("response not UTF-8: {e}")))
    }

    /// Read a file from the VFS. Returns raw bytes.
    #[napi]
    pub fn read(&self, path: String, auth_token: String) -> Result<Buffer> {
        let data = self
            .inner
            .read(&path, &auth_token)
            .map_err(|e| Error::from_reason(format!("gRPC read failed: {e}")))?;
        Ok(Buffer::from(data))
    }

    /// Write raw bytes to a VFS path.
    #[napi]
    pub fn write(
        &self,
        path: String,
        content: Buffer,
        auth_token: String,
    ) -> Result<()> {
        self.inner
            .write(&path, content.to_vec(), &auth_token)
            .map_err(|e| Error::from_reason(format!("gRPC write failed: {e}")))
    }

    /// Delete a VFS path.
    #[napi]
    pub fn delete(&self, path: String, auth_token: String) -> Result<()> {
        self.inner
            .delete(&path, &auth_token)
            .map_err(|e| Error::from_reason(format!("gRPC delete failed: {e}")))
    }

    /// Ping the nexus gRPC server. Returns the response as a JSON string.
    #[napi]
    pub fn ping(&self, auth_token: String) -> Result<String> {
        self.call("ping".to_string(), "{}".to_string(), auth_token)
    }
}
