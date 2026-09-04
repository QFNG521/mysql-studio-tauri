use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mysql::prelude::Queryable;
use mysql::{Opts, OptsBuilder, Params, Pool, Value};
use serde::{Deserialize, Serialize};
use tauri::State;

// ================= 状态 =================

pub struct AppState {
    pub pools: Arc<Mutex<HashMap<String, Pool>>>,
    /// 每个启用 SSH 隧道的会话一条隧道，断开连接时 Drop 关闭
    pub tunnels: Arc<Mutex<HashMap<String, SshTunnel>>>,
    pub data_dir: PathBuf,
}

// ================= 数据模型 =================

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ConnConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    // ---- SSH 隧道（可选） ----
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default)]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    #[serde(default)]
    pub ssh_password: String,
    /// 私钥文件路径；为空则用密码认证
    #[serde(default)]
    pub ssh_key_path: Option<String>,
    // ---- SSL/TLS 直连（可选） ----
    #[serde(default)]
    pub ssl_enabled: bool,
    /// CA 证书 PEM 路径；留空 = 仅加密不验证服务端
    #[serde(default)]
    pub ssl_ca: Option<String>,
    /// 客户端证书链 PEM 路径，双向认证时填写
    #[serde(default)]
    pub ssl_cert: Option<String>,
    /// 客户端私钥 PEM 路径
    #[serde(default)]
    pub ssl_key: Option<String>,
}

fn default_timeout() -> u64 {
    8
}

#[derive(Serialize)]
pub struct ConnInfo {
    pub id: String,
    pub name: String,
    pub server_version: String,
    pub databases: Vec<DbInfo>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DbInfo {
    pub name: String,
    pub system: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub rows: Option<u64>, // 估算行数
    pub engine: Option<String>,
    pub comment: String,
    pub data_length: u64,
    pub table_type: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ColMeta {
    pub name: String,
    pub org_name: String,
    pub table: String,
    pub column_type: u8,
    pub flags: u32,
    pub length: u32,
}

/// information_schema 里的列定义（用于表结构页 / 编辑规则）
#[derive(Clone, Serialize, Deserialize)]
pub struct ColumnDef {
    pub name: String,
    pub column_type: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub is_auto_inc: bool,
    #[serde(rename = "default")]
    pub default_value: Option<String>,
    pub comment: String,
    pub charset: Option<String>,
    pub collation: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct IndexDef {
    pub name: String,
    pub non_unique: bool,
    pub seq: u32,
    pub column: String,
    pub index_type: String,
}

/// 外键定义（一条记录 = 一个约束中的一列）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForeignKeyDef {
    pub name: String,          // 约束名
    pub column: String,        // 本表列
    pub ref_db: String,        // 被引用库
    pub ref_table: String,     // 被引用表
    pub ref_column: String,    // 被引用列
    pub on_update: String,     // CASCADE / RESTRICT / SET NULL / NO ACTION
    pub on_delete: String,
}

#[derive(Serialize)]
pub struct TableMeta {
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexDef>,
    /// 本表作为子表指向别处的外键
    pub foreign_keys: Vec<ForeignKeyDef>,
    /// 别的表指向本表的外键（反向引用）
    pub referenced_by: Vec<ForeignKeyDef>,
    pub ddl: String,
    pub pk_columns: Vec<String>,
    pub row_count: u64,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct OrderBy {
    pub column: String,
    pub dir: String, // ASC | DESC
}

/// 主键定位值（None 表示 IS NULL）
#[derive(Clone, Deserialize, Serialize)]
pub struct PkVal {
    pub column: String,
    pub value: Option<String>,
}

#[derive(Serialize)]
pub struct RowsResult {
    pub columns: Vec<ColMeta>,
    pub rows: Vec<Vec<Option<String>>>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
pub struct StmtResult {
    pub sql: String,
    pub columns: Vec<ColMeta>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected: u64,
    pub last_insert_id: u64,
    pub truncated: bool, // 行数超过 max_rows
    pub elapsed_ms: u64,
    pub error: Option<String>,
    pub warnings: u16,
}

// ================= 工具函数 =================

fn quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

async fn run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?
}

pub fn build_opts(cfg: &ConnConfig) -> Opts {
    let mut b = OptsBuilder::new()
        .ip_or_hostname(Some(cfg.host.clone()))
        .tcp_port(cfg.port)
        .user(Some(cfg.user.clone()))
        .pass(Some(cfg.password.clone()))
        .tcp_connect_timeout(Some(Duration::from_secs(cfg.timeout_secs)))
        // 必须关掉：mysql crate 默认 prefer_socket=true，回环地址时会悄悄改走
        // Unix socket 重连，而 socket 连接不做 TLS（Ssl_cipher 为空）
        .prefer_socket(false);
    if let Some(db) = &cfg.database {
        if !db.trim().is_empty() {
            b = b.db_name(Some(db.clone()));
        }
    }
    if cfg.ssl_enabled {
        let mut ssl = mysql::SslOpts::default();
        if let Some(ca) = cfg.ssl_ca.as_deref().filter(|s| !s.trim().is_empty()) {
            // 有 CA：验证服务端证书。客户端常用 IP 直连，域名校验默认放宽
            ssl = ssl
                .with_root_cert_path(Some(std::path::PathBuf::from(ca)))
                .with_danger_skip_domain_validation(true);
        } else {
            // 无 CA：仅加密，不验证服务端（兼容自签名场景）
            ssl = ssl
                .with_danger_accept_invalid_certs(true)
                .with_danger_skip_domain_validation(true);
        }
        // 双向认证：证书链 + 私钥（PEM）
        let cert = cfg.ssl_cert.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let key = cfg.ssl_key.as_deref().map(str::trim).filter(|s| !s.is_empty());
        if let (Some(cert), Some(key)) = (cert, key) {
            ssl = ssl.with_client_identity(Some(mysql::ClientIdentity::new(
                std::path::PathBuf::from(cert),
                std::path::PathBuf::from(key),
            )));
        }
        b = b.ssl_opts(ssl);
    }
    Opts::from(b)
}

// ================= SSH 隧道 =================

/// 一条 SSH 隧道：本地随机端口 → SSH 服务器 → (mysql_host, mysql_port)。
/// Drop 时停止接受新连接；已建立的连接靠对端关闭自然结束。
pub struct SshTunnel {
    pub local_port: u16,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    _session: Arc<Mutex<ssh2::Session>>,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // accept 循环 80ms 轮询 shutdown，无需 TCP 唤醒（唤醒连接会催生幻影 pump）
        // session 是非阻塞模式：disconnect 需重试驱动直到发出
        if let Ok(s) = self._session.lock() {
            let deadline = std::time::Instant::now() + Duration::from_millis(800);
            while std::time::Instant::now() < deadline {
                match s.disconnect(None, "tunnel closed", None) {
                    Ok(_) => break,
                    Err(ref e) if ssh_would_block(e) => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

fn ssh_connect_session(cfg: &ConnConfig) -> Result<(TcpStream, ssh2::Session), String> {
    use std::net::ToSocketAddrs;
    let ssh_port = if cfg.ssh_port == 0 { 22 } else { cfg.ssh_port };
    let addr = (cfg.ssh_host.as_str(), ssh_port);
    let tcp = TcpStream::connect_timeout(
        &addr
            .to_socket_addrs()
            .map_err(|e| format!("SSH 地址解析失败: {e}"))?
            .next()
            .ok_or_else(|| "SSH 地址无效".to_string())?,
        Duration::from_secs(cfg.timeout_secs.max(3)),
    )
    .map_err(|e| format!("连接 SSH 服务器 {addr:?} 失败: {e}"))?;
    tcp.set_nodelay(true).ok();

    let mut sess = ssh2::Session::new().map_err(|e| format!("初始化 SSH 会话失败: {e}"))?;
    sess.set_tcp_stream(tcp.try_clone().map_err(|e| e.to_string())?);
    sess.handshake()
        .map_err(|e| format!("SSH 握手失败: {e}"))?;

    if let Some(key_path) = &cfg.ssh_key_path {
        // 私钥认证；私钥本身有口令时直接用 ssh_password 字段
        sess.userauth_pubkey_file(
            &cfg.ssh_user,
            None,
            Path::new(key_path),
            if cfg.ssh_password.is_empty() { None } else { Some(&cfg.ssh_password) },
        )
        .map_err(|e| format!("SSH 私钥认证失败: {e}"))?;
    } else {
        sess.userauth_password(&cfg.ssh_user, &cfg.ssh_password)
            .map_err(|e| format!("SSH 密码认证失败（用户 {}）: {e}", cfg.ssh_user))?;
    }
    if !sess.authenticated() {
        return Err("SSH 认证未通过".into());
    }
    // 认证完成后切非阻塞：所有 channel 操作立即返回 WouldBlock，
    // 由数据泵线程轮询驱动。阻塞+超时轮询会占死 ssh2 内部 session 锁，
    // 多连接并发时把延迟放大到秒级（详见 pump_tunnel 注释）。
    sess.set_blocking(false);
    Ok((tcp, sess))
}

/// 建立 SSH 隧道并立即验证：SSH 可达、认证通过、能打开到 MySQL 的转发通道。
pub fn start_ssh_tunnel(cfg: &ConnConfig) -> Result<SshTunnel, String> {
    if cfg.ssh_host.trim().is_empty() || cfg.ssh_user.trim().is_empty() {
        return Err("启用了 SSH 隧道但未填写 SSH 服务器或用户名".into());
    }
    let (_tcp, sess) = ssh_connect_session(cfg)?;
    let sess = Arc::new(Mutex::new(sess));

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("绑定本地端口失败: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).ok();

    let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let shutdown2 = shutdown.clone();
    let sess2 = sess.clone();
    let remote_host = cfg.host.clone();
    let remote_port = cfg.port;

    std::thread::spawn(move || {
        while !shutdown2.load(std::sync::atomic::Ordering::SeqCst) {
            let (client, _peer) = match listener.accept() {
                Ok(x) => x,
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(80));
                    continue;
                }
                Err(_) => break,
            };
            let sess = sess2.clone();
            let remote_host = remote_host.clone();
            std::thread::spawn(move || {
                if let Err(_e) = pump_tunnel(sess, client, &remote_host, remote_port) {
                    // 单个连接失败直接关闭，不影响隧道
                }
            });
        }
    });

    Ok(SshTunnel { local_port, shutdown, _session: sess })
}

/// ssh2 0.9 没有 would_block() 方法；EAGAIN = LIBSSH2_ERROR_EAGAIN(-37)
fn ssh_would_block(e: &ssh2::Error) -> bool {
    matches!(e.code(), ssh2::ErrorCode::Session(-37))
}

/// 把一条本地 TCP 连接经 SSH direct-tcpip 转发到目标地址。
/// Channel 不可克隆：用 Arc<Mutex> 共享。Session 必须处于非阻塞模式——
/// 若用「阻塞 + 超时轮询」，每次 channel 操作会占住 ssh2 内部的 session 锁
/// 最长达一个超时周期，N 条连接并发时延迟被放大为 O(N × 超时)，
/// 实测会把 150ms 轮询放大成每包 3~30 秒。非阻塞下锁持有仅微秒级。
fn pump_tunnel(
    sess: Arc<Mutex<ssh2::Session>>,
    client: TcpStream,
    remote_host: &str,
    remote_port: u16,
) -> Result<(), String> {
    // 调试：设 MYSQL_STUDIO_TUNNEL_DEBUG=1 时打印每个数据块的方向/长度/全量 hex
    let debug = std::env::var("MYSQL_STUDIO_TUNNEL_DEBUG").is_ok();
    static PUMP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let pump_id = PUMP_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let peer = client.peer_addr().map(|a| a.port()).unwrap_or(0);
    let hex16 = |b: &[u8]| -> String {
        b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join("")
    };
    if debug {
        eprintln!("[pump#{pump_id} peer={peer}] start (waiting channel)");
    }

    // 非阻塞模式下开通道：WouldBlock 表示 OPEN 还在握手，重试即可驱动完成
    let open_start = std::time::Instant::now();
    let deadline = open_start + Duration::from_secs(10);
    let channel = loop {
        let s = sess.lock().map_err(|e| e.to_string())?;
        match s.channel_direct_tcpip(remote_host, remote_port, None) {
            Ok(ch) => break ch,
            Err(e) if ssh_would_block(&e) && std::time::Instant::now() < deadline => {
                drop(s);
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return Err(format!("SSH 打开转发通道失败: {e}")),
        }
    };
    if debug {
        eprintln!(
            "[pump#{pump_id}] channel opened in {:?}",
            open_start.elapsed()
        );
    }
    let chan = Arc::new(Mutex::new(channel));

    let mut client_r = client.try_clone().map_err(|e| e.to_string())?;
    let mut client_w = client.try_clone().map_err(|e| e.to_string())?;
    // 客户端 socket 保持阻塞模式：c2s 读阻塞等请求（对端关闭自然返回 0），
    // s2c 写阻塞形成天然背压；都不占用 ssh2 session 锁。
    // macOS 上 accept 出来的 socket 会继承 listener 的 O_NONBLOCK，必须显式设回！
    let _ = client.set_nonblocking(false);

    // 方向 1：client → channel（发送 SQL 请求）
    let c2s = {
        let chan = chan.clone();
        let debug = debug;
        let hex16 = hex16.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                let n = match client_r.read(&mut buf) {
                    Ok(0) => {
                        if debug {
                            eprintln!("[c2s#{pump_id}] client EOF");
                        }
                        break;
                    }
                    Ok(n) => n,
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        if debug {
                            eprintln!("[c2s#{pump_id}] read err: {e}");
                        }
                        break;
                    }
                };
                if debug {
                    eprintln!("[c2s#{pump_id}] n={n} hex={}", hex16(&buf[..n]));
                }
                if !write_all_polling(&chan, &buf[..n]) {
                    if debug {
                        eprintln!("[c2s#{pump_id}] write_all_polling failed");
                    }
                    break;
                }
            }
            // client 已关闭：非阻塞下逐步重试，完成通道关闭握手（尽力 2 秒）
            if let Ok(mut c) = chan.lock() {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while std::time::Instant::now() < deadline {
                    match c.close() {
                        Ok(_) => break,
                        Err(ref e) if ssh_would_block(e) => {
                            std::thread::sleep(Duration::from_millis(2))
                        }
                        Err(_) => break,
                    }
                }
                while std::time::Instant::now() < deadline {
                    match c.wait_eof() {
                        Ok(_) => break,
                        Err(ref e) if ssh_would_block(e) => {
                            std::thread::sleep(Duration::from_millis(2))
                        }
                        Err(_) => break,
                    }
                }
            }
            if debug {
                eprintln!("[c2s#{pump_id}] exit");
            }
        })
    };

    // 方向 2：channel → client（接收响应）
    let c2r = std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            let n = {
                // try_lock：写方向可能正持有锁在写数据
                let mut guard = loop {
                    match chan.try_lock() {
                        Ok(g) => break g,
                        Err(_) => std::thread::sleep(Duration::from_millis(1)),
                    }
                };
                match guard.read(&mut buf) {
                    Ok(n) => n,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        drop(guard);
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => {
                        if debug {
                            eprintln!("[s2c#{pump_id}] chan read err: {e}");
                        }
                        break;
                    }
                }
            };
            if n == 0 {
                if debug {
                    eprintln!("[s2c#{pump_id}] chan EOF");
                }
                break;
            }
            if debug {
                eprintln!("[s2c#{pump_id}] n={n} hex={}", hex16(&buf[..n]));
            }
            if client_w.write_all(&buf[..n]).is_err() {
                if debug {
                    eprintln!("[s2c#{pump_id}] client write failed");
                }
                break;
            }
        }
        let _ = client_w.shutdown(std::net::Shutdown::Both);
        if debug {
            eprintln!("[s2c#{pump_id}] exit");
        }
    });

    let _ = c2s.join();
    let _ = c2r.join();
    Ok(())
}

/// 把数据写进共享 Channel，遇到 WouldBlock（会话超时）就重试
fn write_all_polling(chan: &Mutex<ssh2::Channel>, mut data: &[u8]) -> bool {
    while !data.is_empty() {
        let mut guard = loop {
            match chan.try_lock() {
                Ok(g) => break g,
                Err(_) => std::thread::sleep(Duration::from_millis(2)),
            }
        };
        match guard.write(data) {
            Ok(0) => return false,
            Ok(n) => data = &data[n..],
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                drop(guard);
                std::thread::sleep(Duration::from_millis(3));
            }
            Err(_) => return false,
        }
    }
    true
}

fn value_to_display(v: &Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => {
            if b.len() > 8192 {
                Some(format!("(BLOB, {} bytes)", b.len()))
            } else {
                Some(String::from_utf8_lossy(b).into_owned())
            }
        }
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, m, d, h, mi, s, us) => {
            if *us > 0 {
                Some(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}"))
            } else {
                Some(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
            }
        }
        Value::Time(neg, days, h, m, s, us) => {
            let sign = if *neg { "-" } else { "" };
            let hs = (*days as u64) * 24 + *h as u64;
            if *us > 0 {
                Some(format!("{sign}{hs:02}:{m:02}:{s:02}.{us:06}"))
            } else {
                Some(format!("{sign}{hs:02}:{m:02}:{s:02}"))
            }
        }
    }
}

fn col_meta(c: &mysql::Column) -> ColMeta {
    ColMeta {
        name: c.name_str().to_string(),
        org_name: c.org_name_str().to_string(),
        table: c.table_str().to_string(),
        column_type: c.column_type() as u8,
        flags: c.flags().bits() as u32,
        length: c.column_length(),
    }
}

fn row_to_strings(row: &mysql::Row, ncols: usize) -> Vec<Option<String>> {
    (0..ncols)
        .map(|i| {
            row.get::<Value, usize>(i)
                .and_then(|v| value_to_display(&v))
        })
        .collect()
}

fn map_err(e: mysql::Error) -> String {
    e.to_string()
}

/// 取连接并统一设置 utf8mb4（否则服务器按 latin1 会话返回中文会乱码）
fn get_conn(pool: &Pool) -> Result<mysql::PooledConn, String> {
    let mut conn = pool.get_conn().map_err(map_err)?;
    conn.query_drop("SET NAMES utf8mb4").map_err(map_err)?;
    Ok(conn)
}

fn pool_of(state: &AppState, session: &str) -> Result<Pool, String> {
    state
        .pools
        .lock()
        .map_err(|e| e.to_string())?
        .get(session)
        .cloned()
        .ok_or_else(|| "连接不存在或已断开，请重新连接".into())
}

// ---- 连接配置持久化 ----

fn load_connections(dir: &Path) -> Vec<ConnConfig> {
    std::fs::read_to_string(dir.join("connections.json"))
        .ok()
        .and_then(|txt| serde_json::from_str(&txt).ok())
        .unwrap_or_default()
}

fn save_connections_file(dir: &Path, conns: &[ConnConfig]) -> Result<(), String> {
    let txt = serde_json::to_string_pretty(conns).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("connections.json"), txt).map_err(|e| e.to_string())
}

// ================= 保存的查询 =================

/// 一条命名查询，持久化在 data_dir/saved_queries.json
/// conn_id / db 为空表示"全局"，否则只出现在对应连接/库的列表里。
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SavedQuery {
    pub id: String,
    #[serde(default)]
    pub conn_id: String,
    #[serde(default)]
    pub db: String,
    pub name: String,
    #[serde(default)]
    pub sql: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

fn load_queries(dir: &Path) -> Vec<SavedQuery> {
    std::fs::read_to_string(dir.join("saved_queries.json"))
        .ok()
        .and_then(|txt| serde_json::from_str(&txt).ok())
        .unwrap_or_default()
}

fn save_queries_file(dir: &Path, list: &[SavedQuery]) -> Result<(), String> {
    let txt = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("saved_queries.json"), txt).map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub async fn list_saved_queries(
    state: State<'_, AppState>,
    conn_id: String,
    db: String,
) -> Result<Vec<SavedQuery>, String> {
    let dir = state.data_dir.clone();
    run_blocking(move || {
        let all = load_queries(&dir);
        let mut list: Vec<SavedQuery> = all
            .into_iter()
            .filter(|q| (q.conn_id.is_empty() || q.conn_id == conn_id) && (q.db.is_empty() || q.db == db))
            .collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(list)
    }).await
}

/// 新建或更新一条查询；id 为空则自动生成
#[tauri::command]
pub async fn save_query(state: State<'_, AppState>, query: SavedQuery) -> Result<SavedQuery, String> {
    let dir = state.data_dir.clone();
    run_blocking(move || {
        let mut list = load_queries(&dir);
        let now = now_secs();
        let mut q = query;
        if q.id.is_empty() {
            q.id = format!("q{}", now_secs() * 1000 + (list.len() as u64));
            q.created_at = now;
        }
        q.updated_at = now;
        if q.name.trim().is_empty() {
            return Err("查询名称不能为空".into());
        }
        let saved = q.clone();
        match list.iter_mut().find(|x| x.id == q.id) {
            Some(x) => *x = q,
            None => list.push(q),
        }
        save_queries_file(&dir, &list)?;
        Ok(saved)
    }).await
}

#[tauri::command]
pub async fn delete_query(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = state.data_dir.clone();
    run_blocking(move || {
        let mut list = load_queries(&dir);
        let before = list.len();
        list.retain(|q| q.id != id);
        if list.len() == before {
            return Err("未找到该查询".into());
        }
        save_queries_file(&dir, &list)
    }).await
}

// ---- SQL 语句分割（支持引号与注释）----

pub fn split_statements(sql: &str) -> Vec<String> {
    #[derive(PartialEq)]
    enum S {
        Normal,
        SQuote,
        DQuote,
        Backtick,
        LineComment,
        BlockComment,
    }
    let mut stmts = Vec::new();
    let mut cur = String::new();
    let mut state = S::Normal;
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match state {
            S::Normal => {
                match c {
                    '\'' => {
                        state = S::SQuote;
                        cur.push(c);
                    }
                    '"' => {
                        state = S::DQuote;
                        cur.push(c);
                    }
                    '`' => {
                        state = S::Backtick;
                        cur.push(c);
                    }
                    '-' => {
                        if chars.peek() == Some(&'-') {
                            chars.next();
                            // "--" 后必须跟空白或 EOF 才是注释（注释内容直接丢弃）
                            match chars.peek() {
                                None | Some(' ') | Some('\t') | Some('\n') | Some('\r') => {
                                    state = S::LineComment;
                                }
                                _ => cur.push_str("--"),
                            }
                        } else {
                            cur.push(c);
                        }
                    }
                    '#' => {
                        state = S::LineComment;
                    }
                    '/' => {
                        if chars.peek() == Some(&'*') {
                            chars.next();
                            state = S::BlockComment;
                        } else {
                            cur.push(c);
                        }
                    }
                    ';' => {
                        if !cur.trim().is_empty() {
                            stmts.push(cur.trim().to_string());
                        }
                        cur.clear();
                    }
                    _ => cur.push(c),
                }
            }
            S::SQuote | S::DQuote | S::Backtick => {
                cur.push(c);
                let q = match state {
                    S::SQuote => '\'',
                    S::DQuote => '"',
                    _ => '`',
                };
                if c == '\\' && state != S::Backtick {
                    if let Some(&n) = chars.peek() {
                        cur.push(n);
                        chars.next();
                    }
                } else if c == q {
                    // 双写引号转义（'' / "" / ``）
                    if chars.peek() == Some(&q) {
                        cur.push(q);
                        chars.next();
                    } else {
                        state = S::Normal;
                    }
                }
            }
            S::LineComment => {
                if c == '\n' {
                    state = S::Normal;
                    cur.push('\n');
                }
            }
            S::BlockComment => {
                if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    state = S::Normal;
                    cur.push(' ');
                }
            }
        }
    }
    if !cur.trim().is_empty() {
        stmts.push(cur.trim().to_string());
    }
    stmts
}

// ================= 连接配置命令 =================

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> Result<Vec<ConnConfig>, String> {
    let dir = state.data_dir.clone();
    run_blocking(move || Ok(load_connections(&dir))).await
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    config: ConnConfig,
) -> Result<(), String> {
    let dir = state.data_dir.clone();
    run_blocking(move || {
        let mut conns = load_connections(&dir);
        match conns.iter_mut().find(|c| c.id == config.id) {
            Some(c) => *c = config,
            None => conns.push(config),
        }
        save_connections_file(&dir, &conns)
    }).await
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = state.data_dir.clone();
    run_blocking(move || {
        let mut conns = load_connections(&dir);
        conns.retain(|c| c.id != id);
        save_connections_file(&dir, &conns)
    }).await
}

// ================= 连接命令 =================

pub fn connect_impl(cfg: &ConnConfig) -> Result<(String, Vec<DbInfo>), String> {
    let opts = build_opts(cfg);
    let pool = Pool::new(opts).map_err(|e| format!("创建连接池失败: {e}"))?;
    let mut conn = get_conn(&pool)?;
    let (maj, mi, pa) = conn.server_version();
    let version = format!("{maj}.{mi}.{pa}");
    let dbs: Vec<String> = conn
        .query("SHOW DATABASES")
        .map_err(map_err)?;
    let sys_names = ["information_schema", "mysql", "performance_schema", "sys"];
    let databases = dbs
        .into_iter()
        .map(|name| DbInfo {
            system: sys_names.contains(&name.as_str()),
            name,
        })
        .collect();
    Ok((version, databases))
}

#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>, config: ConnConfig) -> Result<String, String> {
    let _ = &state;
    let cfg = config.clone();
    run_blocking(move || {
        let mut eff = cfg.clone();
        // 测试连接时隧道是局部变量，函数返回即关闭
        if cfg.ssh_enabled {
            let t = start_ssh_tunnel(&cfg)?;
            eff.host = "127.0.0.1".into();
            eff.port = t.local_port;
        }
        let (version, _) = connect_impl(&eff)?;
        Ok(version)
    }).await
}

#[tauri::command]
pub async fn connect_db(state: State<'_, AppState>, config: ConnConfig) -> Result<ConnInfo, String> {
    let pools = state.pools.clone();
    let tunnels = state.tunnels.clone();
    run_blocking(move || {
        // SSH 隧道：先建立并验证认证/转发可用，MySQL 走本地端口
        let mut eff = config.clone();
        let mut tunnel = None;
        if config.ssh_enabled {
            let t = start_ssh_tunnel(&config)?;
            eff.host = "127.0.0.1".into();
            eff.port = t.local_port;
            tunnel = Some(t);
        }
        let opts = build_opts(&eff);
        let pool = Pool::new(opts).map_err(|e| format!("创建连接池失败: {e}"))?;
        let (version, databases) = connect_impl(&eff)?;
        pools
            .lock()
            .map_err(|e| e.to_string())?
            .insert(config.id.clone(), pool);
        match tunnel {
            Some(t) => {
                tunnels
                    .lock()
                    .map_err(|e| e.to_string())?
                    .insert(config.id.clone(), t)
            }
            // 重连时若上次有隧道而这次没启用，清掉旧的
            None => {
                tunnels.lock().map_err(|e| e.to_string())?.remove(&config.id)
            }
        };
        Ok(ConnInfo {
            id: config.id,
            name: config.name,
            server_version: version,
            databases,
        })
    }).await
}

#[tauri::command]
pub async fn disconnect_db(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .pools
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    // 关闭 SSH 隧道（若有）
    state
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
}

// ================= 元数据命令 =================

/// 本表作为子表指向别处的外键（含多列外键的每一列）
pub fn load_foreign_keys<C: Queryable>(
    conn: &mut C,
    db: &str,
    table: &str,
) -> Result<Vec<ForeignKeyDef>, String> {
    let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, String, String)> = conn
        .exec(
            "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, \
                    kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, \
                    rc.UPDATE_RULE, rc.DELETE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE kcu \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
               ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
              AND rc.CONSTRAINT_NAME  = kcu.CONSTRAINT_NAME \
              AND rc.TABLE_NAME       = kcu.TABLE_NAME \
             WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? \
               AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            (db, table),
        )
        .map_err(map_err)?;
    Ok(rows
        .into_iter()
        .map(
            |(name, column, ref_db, ref_table, ref_column, on_update, on_delete)| ForeignKeyDef {
                name,
                column,
                ref_db: ref_db.unwrap_or_else(|| db.to_string()),
                ref_table: ref_table.unwrap_or_default(),
                ref_column: ref_column.unwrap_or_default(),
                on_update,
                on_delete,
            },
        )
        .collect())
}

/// 别的表作为子表指向本表的外键（反向引用）
pub fn load_referenced_by<C: Queryable>(
    conn: &mut C,
    db: &str,
    table: &str,
) -> Result<Vec<ForeignKeyDef>, String> {
    let rows: Vec<(String, String, String, String, String, String, String)> = conn
        .exec(
            "SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME, \
                    kcu.REFERENCED_COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE kcu \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
               ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
              AND rc.CONSTRAINT_NAME  = kcu.CONSTRAINT_NAME \
              AND rc.TABLE_NAME       = kcu.TABLE_NAME \
             WHERE kcu.REFERENCED_TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME = ? \
             ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            (db, table),
        )
        .map_err(map_err)?;
    Ok(rows
        .into_iter()
        .map(
            |(name, child_db, child_table, column, ref_column, on_update, on_delete)| ForeignKeyDef {
                name,
                column,
                ref_db: child_db,
                ref_table: child_table,
                ref_column,
                on_update,
                on_delete,
            },
        )
        .collect())
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, session: String) -> Result<Vec<DbInfo>, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let mut conn = get_conn(&pool)?;
        let dbs: Vec<String> = conn.query("SHOW DATABASES").map_err(map_err)?;
        let sys_names = ["information_schema", "mysql", "performance_schema", "sys"];
        Ok(dbs
            .into_iter()
            .map(|name| DbInfo {
                system: sys_names.contains(&name.as_str()),
                name,
            })
            .collect())
    }).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    session: String,
    db: String,
) -> Result<Vec<TableInfo>, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let mut conn = get_conn(&pool)?;
        let rows: Vec<(String, Option<u64>, Option<String>, Option<String>, Option<u64>, Option<String>)> = conn
            .exec(
                "SELECT TABLE_NAME, TABLE_ROWS, ENGINE, TABLE_COMMENT, DATA_LENGTH, TABLE_TYPE \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                (db,),
            )
            .map_err(map_err)?;
        Ok(rows
            .into_iter()
            .map(|(name, rows, engine, comment, data_length, table_type)| TableInfo {
                name,
                rows,
                engine,
                comment: comment.unwrap_or_default(),
                data_length: data_length.unwrap_or(0),
                table_type: table_type.unwrap_or_else(|| "BASE TABLE".into()),
            })
            .collect())
    }).await
}

#[tauri::command]
pub async fn get_table_meta(
    state: State<'_, AppState>,
    session: String,
    db: String,
    table: String,
) -> Result<TableMeta, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let mut conn = get_conn(&pool)?;
        conn.query_drop(format!("USE {}", quote_ident(&db)))
            .map_err(map_err)?;

        let col_rows: Vec<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> = conn
            .exec(
                "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, \
                 COLUMN_KEY, EXTRA, COLUMN_COMMENT, COLLATION_NAME \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                (db.clone(), table.clone()),
            )
            .map_err(map_err)?;

        let mut columns = Vec::new();
        let mut pk_columns = Vec::new();
        for (name, column_type, data_type, nullable, default, key, extra, comment, collation) in col_rows {
            if key.as_deref() == Some("PRI") {
                pk_columns.push(name.clone());
            }
            columns.push(ColumnDef {
                name,
                column_type,
                data_type,
                nullable: nullable == "YES",
                is_pk: key.as_deref() == Some("PRI"),
                is_auto_inc: extra.as_deref().map(|e| e.contains("auto_increment")).unwrap_or(false),
                default_value: default,
                comment: comment.unwrap_or_default(),
                charset: if collation.is_some() { Some(String::new()) } else { None },
                collation,
            });
        }

        let idx_rows: Vec<(String, u32, u32, String, String)> = conn
            .exec(
                "SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE \
                 FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                 ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                (db.clone(), table.clone()),
            )
            .map_err(map_err)?;
        let indexes = idx_rows
            .into_iter()
            .map(|(name, non_unique, seq, column, index_type)| IndexDef {
                name,
                non_unique: non_unique > 0,
                seq,
                column,
                index_type,
            })
            .collect();

        let foreign_keys = load_foreign_keys(&mut conn, &db, &table)?;
        let referenced_by = load_referenced_by(&mut conn, &db, &table)?;

        let ddl: Option<(String, String)> = conn
            .query_first(format!("SHOW CREATE TABLE {}.{}", quote_ident(&db), quote_ident(&table)))
            .map_err(map_err)?;
        let ddl = ddl.map(|(_, d)| d).unwrap_or_default();

        let row_count: u64 = conn
            .query_first(format!(
                "SELECT COUNT(*) FROM {}.{}",
                quote_ident(&db),
                quote_ident(&table)
            ))
            .map_err(map_err)?
            .unwrap_or(0);

        Ok(TableMeta {
            columns,
            indexes,
            foreign_keys,
            referenced_by,
            ddl,
            pk_columns,
            row_count,
        })
    }).await
}

// ================= 数据浏览 / 编辑 =================

#[tauri::command]
pub async fn fetch_rows(
    state: State<'_, AppState>,
    session: String,
    db: String,
    table: String,
    page: u32,
    page_size: u32,
    order_by: Option<Vec<OrderBy>>,
    where_sql: Option<String>,
) -> Result<RowsResult, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let started = Instant::now();
        let mut conn = get_conn(&pool)?;
        conn.query_drop(format!("USE {}", quote_ident(&db)))
            .map_err(map_err)?;

        let full = format!("{}.{}", quote_ident(&db), quote_ident(&table));
        let where_clause = match where_sql.as_deref().map(str::trim) {
            Some(w) if !w.is_empty() => format!(" WHERE {w}"),
            _ => String::new(),
        };
        let order_clause = order_by
            .unwrap_or_default()
            .iter()
            .filter(|o| !o.column.trim().is_empty())
            .map(|o| {
                let dir = if o.dir.eq_ignore_ascii_case("DESC") { "DESC" } else { "ASC" };
                format!("{} {}", quote_ident(&o.column), dir)
            })
            .collect::<Vec<_>>()
            .join(", ");
        let order_clause = if order_clause.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {order_clause}")
        };

        let page_size = page_size.clamp(1, 5000);
        let offset = page.saturating_sub(1) * page_size;

        let total: u64 = conn
            .query_first(format!(
                "SELECT COUNT(*) FROM {full}{where_clause}"
            ))
            .map_err(map_err)?
            .unwrap_or(0);

        let sql = format!(
            "SELECT * FROM {full}{where_clause}{order_clause} LIMIT {offset}, {page_size}"
        );
        let mut result = conn.query_iter(&sql).map_err(map_err)?;
        let cols = result.columns();
        let columns: Vec<ColMeta> = cols.as_ref().iter().map(col_meta).collect();
        let ncols = columns.len();
        let mut rows = Vec::new();
        for row in result.by_ref() {
            let row = row.map_err(map_err)?;
            rows.push(row_to_strings(&row, ncols));
        }
        Ok(RowsResult {
            columns,
            rows,
            total,
            page,
            page_size,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }).await
}

#[tauri::command]
pub async fn update_cell(
    state: State<'_, AppState>,
    session: String,
    db: String,
    table: String,
    pk_vals: Vec<PkVal>,
    column: String,
    value: Option<String>,
) -> Result<u64, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let mut conn = get_conn(&pool)?;
        conn.query_drop(format!("USE {}", quote_ident(&db)))
            .map_err(map_err)?;
        if pk_vals.is_empty() {
            return Err("无主键信息，无法安全更新".into());
        }
        let full = format!("{}.{}", quote_ident(&db), quote_ident(&table));

        let mut params: Vec<Value> = Vec::new();
        let sets = match value {
            Some(v) => {
                params.push(Value::Bytes(v.into_bytes()));
                format!("SET {} = ?", quote_ident(&column))
            }
            None => format!("SET {} = NULL", quote_ident(&column)),
        };
        let mut wheres = Vec::new();
        for pk in pk_vals {
            match pk.value {
                Some(v) => {
                    params.push(Value::Bytes(v.into_bytes()));
                    wheres.push(format!("{} = ?", quote_ident(&pk.column)));
                }
                None => wheres.push(format!("{} IS NULL", quote_ident(&pk.column))),
            }
        }
        let sql = format!(
            "UPDATE {full} {sets} WHERE {} LIMIT 1",
            wheres.join(" AND ")
        );
        let affected = conn
            .exec_iter(sql, Params::Positional(params))
            .map_err(map_err)?
            .affected_rows();
        if affected == 0 {
            return Err("更新失败：目标行不存在或已被修改".into());
        }
        Ok(affected)
    }).await
}

#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    session: String,
    db: String,
    table: String,
    values: BTreeMap<String, Option<String>>,
) -> Result<u64, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let mut conn = get_conn(&pool)?;
        conn.query_drop(format!("USE {}", quote_ident(&db)))
            .map_err(map_err)?;
        if values.is_empty() {
            return Err("没有可插入的列值".into());
        }
        let full = format!("{}.{}", quote_ident(&db), quote_ident(&table));
        let mut cols = Vec::new();
        let mut placeholders = Vec::new();
        let mut params: Vec<Value> = Vec::new();
        for (col, v) in values {
            cols.push(quote_ident(&col));
            match v {
                Some(s) => {
                    params.push(Value::Bytes(s.into_bytes()));
                    placeholders.push("?".to_string());
                }
                None => placeholders.push("NULL".to_string()),
            }
        }
        let sql = format!(
            "INSERT INTO {full} ({}) VALUES ({})",
            cols.join(", "),
            placeholders.join(", ")
        );
        let result = conn
            .exec_iter(sql, Params::Positional(params))
            .map_err(map_err)?;
        Ok(result.last_insert_id().unwrap_or(0))
    }).await
}

#[tauri::command]
pub async fn delete_rows(
    state: State<'_, AppState>,
    session: String,
    db: String,
    table: String,
    keys: Vec<Vec<PkVal>>,
) -> Result<u64, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let mut conn = get_conn(&pool)?;
        conn.query_drop(format!("USE {}", quote_ident(&db)))
            .map_err(map_err)?;
        if keys.is_empty() {
            return Err("未选择要删除的行".into());
        }
        let full = format!("{}.{}", quote_ident(&db), quote_ident(&table));
        let mut params: Vec<Value> = Vec::new();
        let mut ors = Vec::new();
        for key in keys {
            if key.is_empty() {
                continue;
            }
            let mut ands = Vec::new();
            for pk in key {
                match pk.value {
                    Some(v) => {
                        params.push(Value::Bytes(v.into_bytes()));
                        ands.push(format!("{} = ?", quote_ident(&pk.column)));
                    }
                    None => ands.push(format!("{} IS NULL", quote_ident(&pk.column))),
                }
            }
            ors.push(format!("({})", ands.join(" AND ")));
        }
        let sql = format!("DELETE FROM {full} WHERE {}", ors.join(" OR "));
        let affected = conn
            .exec_iter(sql, Params::Positional(params))
            .map_err(map_err)?
            .affected_rows();
        Ok(affected)
    }).await
}

// ================= SQL 执行 =================

fn exec_one<C: Queryable>(conn: &mut C, stmt: &str, max_rows: usize) -> StmtResult {
    let started = Instant::now();
    match conn.query_iter(stmt) {
        Ok(mut result) => {
            let cols = result.columns();
            let columns: Vec<ColMeta> = cols.as_ref().iter().map(col_meta).collect();
            let ncols = columns.len();
            let mut rows = Vec::new();
            let mut truncated = false;
            for row in result.by_ref() {
                if rows.len() >= max_rows {
                    truncated = true;
                    break;
                }
                match row {
                    Ok(r) => rows.push(row_to_strings(&r, ncols)),
                    Err(e) => {
                        return StmtResult {
                            sql: stmt.to_string(),
                            columns,
                            rows,
                            affected: 0,
                            last_insert_id: 0,
                            truncated: false,
                            elapsed_ms: started.elapsed().as_millis() as u64,
                            error: Some(e.to_string()),
                            warnings: 0,
                        };
                    }
                }
            }
            let affected = result.affected_rows();
            let last_insert_id = result.last_insert_id().unwrap_or(0);
            let warnings = result.warnings();
            StmtResult {
                sql: stmt.to_string(),
                columns,
                rows,
                affected,
                last_insert_id,
                truncated,
                elapsed_ms: started.elapsed().as_millis() as u64,
                error: None,
                warnings,
            }
        }
        Err(e) => StmtResult {
            sql: stmt.to_string(),
            columns: Vec::new(),
            rows: Vec::new(),
            affected: 0,
            last_insert_id: 0,
            truncated: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
            error: Some(e.to_string()),
            warnings: 0,
        },
    }
}

#[tauri::command]
pub async fn execute_sql(
    state: State<'_, AppState>,
    session: String,
    db: String,
    sql: String,
    max_rows: Option<u32>,
) -> Result<Vec<StmtResult>, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let stmts = split_statements(&sql);
        if stmts.is_empty() {
            return Err("没有可执行的语句".into());
        }
        let max_rows = max_rows.unwrap_or(500).clamp(1, 100_000) as usize;
        let mut conn = get_conn(&pool)?;
        if !db.trim().is_empty() {
            conn.query_drop(format!("USE {}", quote_ident(&db)))
                .map_err(map_err)?;
        }
        let mut results = Vec::new();
        for stmt in stmts {
            let r = exec_one(&mut conn, &stmt, max_rows);
            let has_error = r.error.is_some();
            results.push(r);
            if has_error {
                break; // 出错即停止后续语句
            }
        }
        Ok(results)
    }).await
}

// ================= CSV 导出 =================

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[tauri::command]
pub async fn export_csv(
    state: State<'_, AppState>,
    session: String,
    db: String,
    sql: String,
    path: String,
) -> Result<u64, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let stmts = split_statements(&sql);
        let stmt = stmts
            .first()
            .ok_or_else(|| "没有可执行的语句".to_string())?;
        let mut conn = get_conn(&pool)?;
        if !db.trim().is_empty() {
            conn.query_drop(format!("USE {}", quote_ident(&db)))
                .map_err(map_err)?;
        }
        let mut result = conn.query_iter(stmt).map_err(map_err)?;
        let cols = result.columns();
        let ncols = cols.as_ref().len();
        let header: Vec<String> = cols
            .as_ref()
            .iter()
            .map(|c| csv_escape(&c.name_str()))
            .collect();
        use std::io::Write;
        let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut w = std::io::BufWriter::new(file);
        writeln!(w, "{}", header.join(",")).map_err(|e| e.to_string())?;
        let mut count: u64 = 0;
        for row in result.by_ref() {
            let row = row.map_err(map_err)?;
            let vals = row_to_strings(&row, ncols);
            let line: Vec<String> = vals
                .into_iter()
                .map(|v| csv_escape(&v.unwrap_or_default()))
                .collect();
            writeln!(w, "{}", line.join(",")).map_err(|e| e.to_string())?;
            count += 1;
        }
        w.flush().map_err(|e| e.to_string())?;
        Ok(count)
    }).await
}

// ================= JSON / Excel 导出 =================

/// JSON 导出用值：NULL → null，数值 → number，日期按 SQL 文本，BLOB 超 8KB 只给占位。
fn json_value(v: &Value) -> serde_json::Value {
    match v {
        Value::NULL => serde_json::Value::Null,
        Value::Int(i) => serde_json::Value::from(*i),
        Value::UInt(u) => serde_json::Value::from(*u),
        Value::Float(f) => serde_json::Value::from(*f),
        Value::Double(d) => serde_json::Value::from(*d),
        Value::Bytes(b) => {
            let s = if b.len() > 8192 {
                format!("(BLOB, {} bytes)", b.len())
            } else {
                String::from_utf8_lossy(b).into_owned()
            };
            serde_json::Value::from(s)
        }
        other => serde_json::Value::from(other.as_sql(true)),
    }
}

#[tauri::command]
pub async fn export_json(
    state: State<'_, AppState>,
    session: String,
    db: String,
    sql: String,
    path: String,
) -> Result<u64, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let stmts = split_statements(&sql);
        let stmt = stmts
            .first()
            .ok_or_else(|| "没有可执行的语句".to_string())?;
        let mut conn = get_conn(&pool)?;
        if !db.trim().is_empty() {
            conn.query_drop(format!("USE {}", quote_ident(&db)))
                .map_err(map_err)?;
        }
        let mut result = conn.query_iter(stmt).map_err(map_err)?;
        let cols = result.columns();
        let ncols = cols.as_ref().len();
        // 列名去重（JSON 对象键重复会被覆盖）
        let mut names: Vec<String> = Vec::with_capacity(ncols);
        for c in cols.as_ref().iter() {
            let base = c.name_str().to_string();
            let mut n = base.clone();
            let mut k = 2;
            while names.contains(&n) {
                n = format!("{base}_{k}");
                k += 1;
            }
            names.push(n);
        }
        use std::io::Write;
        let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut w = std::io::BufWriter::new(file);
        // 流式写 JSON 数组，避免大结果集整体驻留内存
        w.write_all(b"[").map_err(|e| e.to_string())?;
        let mut count: u64 = 0;
        for row in result.by_ref() {
            let row = row.map_err(map_err)?;
            if count > 0 {
                w.write_all(b",").map_err(|e| e.to_string())?;
            }
            let mut obj = serde_json::Map::with_capacity(ncols);
            for i in 0..ncols {
                let jv = row
                    .get::<Value, usize>(i)
                    .map(|v| json_value(&v))
                    .unwrap_or(serde_json::Value::Null);
                obj.insert(names[i].clone(), jv);
            }
            let line = serde_json::to_string(&obj).map_err(|e| e.to_string())?;
            w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            count += 1;
        }
        w.write_all(b"]").map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
        Ok(count)
    }).await
}

#[tauri::command]
pub async fn export_xlsx(
    state: State<'_, AppState>,
    session: String,
    db: String,
    sql: String,
    path: String,
) -> Result<u64, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let stmts = split_statements(&sql);
        let stmt = stmts
            .first()
            .ok_or_else(|| "没有可执行的语句".to_string())?;
        let mut conn = get_conn(&pool)?;
        if !db.trim().is_empty() {
            conn.query_drop(format!("USE {}", quote_ident(&db)))
                .map_err(map_err)?;
        }
        let mut result = conn.query_iter(stmt).map_err(map_err)?;
        let cols = result.columns();
        let ncols = cols.as_ref().len();
        let header: Vec<String> = cols
            .as_ref()
            .iter()
            .map(|c| c.name_str().to_string())
            .collect();

        let mut wb = rust_xlsxwriter::Workbook::new();
        let sheet = wb.add_worksheet();
        let _ = sheet.set_name("查询结果");
        let header_fmt = rust_xlsxwriter::Format::new()
            .set_bold()
            .set_background_color(0xF7F8FA);
        for (c, name) in header.iter().enumerate() {
            let _ = sheet.write_string_with_format(0, c as u16, name, &header_fmt);
        }
        let _ = sheet.set_freeze_panes(1, 0); // 冻结表头行
        sheet
            .set_column_width(0, 14)
            .ok(); // 给首列一个基本宽度，其余自动

        let mut row_idx: u32 = 1;
        let mut count: u64 = 0;
        for row in result.by_ref() {
            let row = row.map_err(map_err)?;
            for i in 0..ncols {
                let col = i as u16;
                match row.get::<Value, usize>(i) {
                    None | Some(Value::NULL) => {}
                    Some(Value::Int(x)) => {
                        let _ = sheet.write_number(row_idx, col, x as f64);
                    }
                    Some(Value::UInt(x)) => {
                        let _ = sheet.write_number(row_idx, col, x as f64);
                    }
                    Some(Value::Float(x)) => {
                        let _ = sheet.write_number(row_idx, col, x as f64);
                    }
                    Some(Value::Double(x)) => {
                        let _ = sheet.write_number(row_idx, col, x as f64);
                    }
                    Some(other) => {
                        // 字符串/日期/BLOB 占位，复用统一的显示转换
                        let s = value_to_display(&other).unwrap_or_default();
                        let _ = sheet.write_string(row_idx, col, s);
                    }
                }
            }
            row_idx += 1;
            count += 1;
        }
        wb.save(&path).map_err(|e| e.to_string())?;
        Ok(count)
    }).await
}

/// 把 mysql::Value 转成 INSERT 用的 SQL 字面量。
/// 注意不能用 display 展示值（BLOB 会变成 "(BLOB, N bytes)"），要按原始类型转换。
fn sql_literal(v: &mysql::Value) -> String {
    match v {
        mysql::Value::NULL => "NULL".to_string(),
        mysql::Value::Int(i) => i.to_string(),
        mysql::Value::UInt(u) => u.to_string(),
        mysql::Value::Float(f) => f.to_string(),
        mysql::Value::Double(d) => d.to_string(),
        mysql::Value::Bytes(b) => match std::str::from_utf8(b) {
            // 文本 → 单引号字符串（' 翻倍、反斜杠翻倍）
            Ok(s) => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
            // 二进制 → hex 字面量
            Err(_) => format!("0x{}", b.iter().map(|x| format!("{:02X}", x)).collect::<String>()),
        },
        // DATE/TIME/DATETIME 等由驱动按 SQL 文本输出，直接使用
        _ => v.as_sql(true),
    }
}

/// 把整表（或带 where_sql 筛选）数据写成 INSERT 脚本到 writer，返回行数。
/// 每批 100 行合成一条多值 INSERT，导入时快很多。
pub fn dump_inserts<W: std::io::Write, C: Queryable>(
    w: &mut W,
    conn: &mut C,
    db: &str,
    table: &str,
    where_sql: Option<&str>,
) -> Result<u64, String> {
    let mut sql = format!("SELECT * FROM {}.{}", quote_ident(db), quote_ident(table));
    if let Some(cond) = where_sql {
        let cond = cond.trim();
        if !cond.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(cond);
        }
    }
    let mut result = conn.query_iter(sql).map_err(map_err)?;
    let cols = result.columns();
    let col_names: Vec<String> = cols
        .as_ref()
        .iter()
        .map(|c| quote_ident(&c.name_str()))
        .collect();
    let ncols = col_names.len();
    let col_list = col_names.join(",");
    let table_q = format!("{}.{}", quote_ident(db), quote_ident(table));

    writeln!(w, "-- 轻库导出: {} 的数据 INSERT 脚本", table_q).map_err(|e| e.to_string())?;
    writeln!(w, "SET NAMES utf8mb4;").map_err(|e| e.to_string())?;

    const BATCH: usize = 100;
    let mut count: u64 = 0;
    let mut batch: Vec<String> = Vec::with_capacity(BATCH);
    for row in result.by_ref() {
        let row = row.map_err(map_err)?;
        let vals: Vec<String> = (0..ncols)
            .map(|i| {
                let v = row
                    .get::<mysql::Value, usize>(i)
                    .unwrap_or(mysql::Value::NULL);
                sql_literal(&v)
            })
            .collect();
        batch.push(format!("({})", vals.join(",")));
        if batch.len() >= BATCH {
            flush_insert_batch(w, &table_q, &col_list, &mut batch, &mut count)?;
        }
    }
    flush_insert_batch(w, &table_q, &col_list, &mut batch, &mut count)?;
    Ok(count)
}

fn flush_insert_batch<W: std::io::Write>(
    w: &mut W,
    table_q: &str,
    col_list: &str,
    batch: &mut Vec<String>,
    count: &mut u64,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    writeln!(
        w,
        "INSERT INTO {} ({}) VALUES\n{};",
        table_q,
        col_list,
        batch.join(",\n")
    )
    .map_err(|e| e.to_string())?;
    *count += batch.len() as u64;
    batch.clear();
    Ok(())
}

/// 导出整表（或带 where_sql 筛选）数据为 SQL INSERT 脚本（每 100 行一条多值 INSERT）。
#[tauri::command]
pub async fn export_inserts(
    state: State<'_, AppState>,
    session: String,
    db: String,
    table: String,
    path: String,
    where_sql: Option<String>,
) -> Result<u64, String> {
    let pool = pool_of(&state, &session)?;
    run_blocking(move || {
        let mut conn = get_conn(&pool)?;
        if !db.trim().is_empty() {
            conn.query_drop(format!("USE {}", quote_ident(&db)))
                .map_err(map_err)?;
        }
        let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut w = std::io::BufWriter::with_capacity(1 << 20, file);
        dump_inserts(&mut w, &mut conn, &db, &table, where_sql.as_deref())
    }).await
}
