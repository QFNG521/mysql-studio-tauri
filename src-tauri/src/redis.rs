use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use redis::{Client as RedisClient, Commands};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{run_blocking, start_ssh_tunnel, AppState, ConnConfig};

// ================= 数据模型 =================

#[derive(Serialize)]
pub struct RedisDbInfo {
    pub index: u8,
    pub keys: u64,
}

#[derive(Serialize)]
pub struct RedisInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub mode: String,
    pub used_memory: String,
    pub dbs: Vec<RedisDbInfo>,
}

#[derive(Serialize)]
pub struct RedisKeyInfo {
    pub key: String,
    pub rtype: String,
    pub ttl: i64,
}

#[derive(Deserialize)]
pub struct RedisScanArgs {
    pub id: String,
    pub db: u8,
    /// SCAN 游标，"0" 表示从头开始
    pub cursor: String,
    pub pattern: Option<String>,
    pub count: Option<u32>,
}

#[derive(Serialize)]
pub struct RedisScanResult {
    /// 下一页游标；"0" 表示已到末尾
    pub cursor: String,
    pub keys: Vec<RedisKeyInfo>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RedisZMember {
    pub member: String,
    pub score: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RedisHashField {
    pub field: String,
    pub value: String,
}

/// 一个键的完整值（按类型返回对应字段，其余为 None）
#[derive(Serialize)]
pub struct RedisValue {
    pub key: String,
    pub rtype: String,
    pub ttl: i64,
    /// 元素个数（string 为字节长度）
    pub size: usize,
    pub string: Option<String>,
    pub list: Option<Vec<String>>,
    pub set: Option<Vec<String>>,
    pub zset: Option<Vec<RedisZMember>>,
    pub hash: Option<Vec<RedisHashField>>,
}

#[derive(Deserialize)]
pub struct RedisKeyArgs {
    pub id: String,
    pub db: u8,
    pub key: String,
}

#[derive(Deserialize)]
pub struct RedisSetArgs {
    pub id: String,
    pub db: u8,
    pub key: String,
    pub rtype: String,
    pub string: Option<String>,
    pub list: Option<Vec<String>>,
    pub set: Option<Vec<String>>,
    pub zset: Option<Vec<RedisZMember>>,
    pub hash: Option<Vec<RedisHashField>>,
    /// 过期秒数：>0 设置过期；0 表示永不过期（persist）；None 保持不变
    #[serde(default)]
    pub ttl: Option<i64>,
}

#[derive(Deserialize)]
pub struct RedisTtlArgs {
    pub id: String,
    pub db: u8,
    pub key: String,
    pub ttl: i64,
}

// ================= 工具 =================

fn b2s(b: Vec<u8>) -> String {
    String::from_utf8_lossy(&b).into_owned()
}

/// 给一批原始键批量取类型与 TTL，构造 RedisKeyInfo 列表
fn key_infos(
    conn: &mut redis::Connection,
    keys: Vec<Vec<u8>>,
) -> Result<Vec<RedisKeyInfo>, String> {
    let mut infos = Vec::with_capacity(keys.len());
    for k in keys {
        let key = b2s(k);
        let rtype: String = redis::cmd("TYPE")
            .arg(&key)
            .query(conn)
            .map_err(|e| e.to_string())?;
        let ttl: i64 = redis::cmd("TTL")
            .arg(&key)
            .query(conn)
            .map_err(|e| e.to_string())?;
        infos.push(RedisKeyInfo { key, rtype, ttl });
    }
    Ok(infos)
}

/// 构造 redis / rediss URL。SSH 隧道场景下 host/port 已被替换为本地端口
fn redis_url(cfg: &ConnConfig) -> String {
    let scheme = if cfg.redis_tls { "rediss" } else { "redis" };
    let auth = if let Some(u) = cfg.redis_username.as_deref().filter(|s| !s.is_empty()) {
        format!("{}:{}@", u, cfg.password)
    } else if !cfg.password.is_empty() {
        format!(":{}@", cfg.password)
    } else {
        String::new()
    };
    format!("{scheme}://{auth}{}:{}/", cfg.host, cfg.port)
}

fn open_client(cfg: &ConnConfig) -> Result<RedisClient, String> {
    RedisClient::open(redis_url(cfg)).map_err(|e| format!("Redis 连接地址无效: {e}"))
}

/// 取一个到目标 db 的阻塞连接（含 SELECT）
fn redis_conn_of(
    clients: &Arc<Mutex<HashMap<String, RedisClient>>>,
    id: &str,
    db: u8,
) -> Result<redis::Connection, String> {
    let client = clients
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "Redis 会话不存在或已断开，请重新连接".to_string())?;
    let mut conn = client
        .get_connection()
        .map_err(|e| format!("Redis 连接失败: {e}"))?;
    if db != 0 {
        redis::cmd("SELECT")
            .arg(db)
            .query::<()>(&mut conn)
            .map_err(|e| format!("切换到 DB{db} 失败: {e}"))?;
    }
    Ok(conn)
}

/// 解析 INFO 文本为 key:value（跳过注释与空行）
fn parse_info(text: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            m.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    m
}

/// 解析 INFO keyspace：从 "db0:keys=5,expires=1,avg_ttl=0" 提取 db 索引 -> key 数
fn parse_keyspace(text: &str) -> HashMap<u8, u64> {
    let mut m = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((dbpart, rest)) = line.split_once(':') {
            if let Some(idx_str) = dbpart.strip_prefix("db") {
                if let Ok(idx) = idx_str.parse::<u8>() {
                    if let Some((k, _)) = rest.split_once(',') {
                        if let Some(v) = k.strip_prefix("keys=") {
                            if let Ok(n) = v.parse::<u64>() {
                                m.insert(idx, n);
                            }
                        }
                    }
                }
            }
        }
    }
    m
}

// ================= 命令 =================

#[tauri::command]
pub async fn redis_test(
    state: State<'_, AppState>,
    config: ConnConfig,
) -> Result<String, String> {
    let _ = &state;
    run_blocking(move || {
        // 测试时隧道为局部变量，函数返回即关闭
        let mut eff = config.clone();
        let _tunnel = if config.ssh_enabled {
            let t = start_ssh_tunnel(&config)?;
            eff.host = "127.0.0.1".into();
            eff.port = t.local_port;
            Some(t)
        } else {
            None
        };
        let client = open_client(&eff)?;
        let mut conn = client
            .get_connection()
            .map_err(|e| format!("Redis 连接失败: {e}"))?;
        let _: String = redis::cmd("PING")
            .query(&mut conn)
            .map_err(|e| format!("Redis PING 失败: {e}"))?;
        let info: String = redis::cmd("INFO")
            .arg("server")
            .query(&mut conn)
            .map_err(|e| e.to_string())?;
        let ver = parse_info(&info)
            .get("redis_version")
            .cloned()
            .unwrap_or_else(|| "未知".into());
        Ok(ver)
    })
    .await
}

#[tauri::command]
pub async fn redis_connect(
    state: State<'_, AppState>,
    config: ConnConfig,
) -> Result<RedisInfo, String> {
    let clients = state.redis_clients.clone();
    let tunnels = state.tunnels.clone();
    run_blocking(move || {
        // SSH 隧道：先建立并验证，Redis 走本地端口
        let mut eff = config.clone();
        let mut tunnel = None;
        if config.ssh_enabled {
            let t = start_ssh_tunnel(&config)?;
            eff.host = "127.0.0.1".into();
            eff.port = t.local_port;
            tunnel = Some(t);
        }
        let client = open_client(&eff)?;
        let mut conn = client
            .get_connection()
            .map_err(|e| format!("Redis 连接失败: {e}"))?;
        let _: String = redis::cmd("PING")
            .query(&mut conn)
            .map_err(|e| format!("Redis PING 失败: {e}"))?;

        let server: String = redis::cmd("INFO")
            .arg("server")
            .query(&mut conn)
            .map_err(|e| e.to_string())?;
        let s = parse_info(&server);
        let version = s
            .get("redis_version")
            .cloned()
            .unwrap_or_else(|| "未知".into());
        let mode = s
            .get("redis_mode")
            .cloned()
            .unwrap_or_else(|| "standalone".into());

        let mem: String = redis::cmd("INFO")
            .arg("memory")
            .query(&mut conn)
            .map_err(|e| e.to_string())?;
        let used_memory = parse_info(&mem)
            .get("used_memory_human")
            .cloned()
            .unwrap_or_default();

        // 逻辑库数量（CONFIG GET databases）
        let cfg_raw: Vec<String> = redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query(&mut conn)
            .map_err(|e| e.to_string())?;
        let db_count: u8 = cfg_raw.get(1).and_then(|v| v.parse().ok()).unwrap_or(16);

        // 各 db 的 key 数（INFO keyspace 一次拿全）
        let ks: String = redis::cmd("INFO")
            .arg("keyspace")
            .query(&mut conn)
            .map_err(|e| e.to_string())?;
        let ks_map = parse_keyspace(&ks);
        let mut dbs = Vec::new();
        for i in 0..db_count {
            let keys = ks_map.get(&i).copied().unwrap_or(0);
            dbs.push(RedisDbInfo { index: i, keys });
        }

        clients
            .lock()
            .map_err(|e| e.to_string())?
            .insert(config.id.clone(), client);
        match tunnel {
            Some(t) => {
                tunnels
                    .lock()
                    .map_err(|e| e.to_string())?
                    .insert(config.id.clone(), t);
            }
            None => {
                tunnels.lock().map_err(|e| e.to_string())?.remove(&config.id);
            }
        }

        Ok(RedisInfo {
            id: config.id,
            name: config.name,
            version,
            mode,
            used_memory,
            dbs,
        })
    })
    .await
}

#[tauri::command]
pub async fn redis_scan(
    state: State<'_, AppState>,
    args: RedisScanArgs,
) -> Result<RedisScanResult, String> {
    let RedisScanArgs {
        id,
        db,
        cursor,
        pattern,
        count,
    } = args;
    let clients = state.redis_clients.clone();
    run_blocking(move || {
        let mut conn = redis_conn_of(&clients, &id, db)?;
        let want = count.unwrap_or(200).max(1) as usize;
        let pat = pattern.as_deref().unwrap_or("").to_string();
        let has_match = !pat.is_empty() && pat != "*";

        // 浏览模式（无有效 MATCH）：单次 SCAN，保留游标分页语义
        if !has_match {
            let mut cmd = redis::cmd("SCAN");
            cmd.arg(&cursor);
            cmd.arg("COUNT").arg(want as u64);
            let (next_cursor, keys): (String, Vec<Vec<u8>>) =
                cmd.query(&mut conn).map_err(|e| e.to_string())?;
            let infos = key_infos(&mut conn, keys)?;
            return Ok(RedisScanResult {
                cursor: next_cursor,
                keys: infos,
            });
        }

        // 搜索模式：循环 SCAN 直到扫完、攒够结果或达到迭代上限。
        // 单次 SCAN 只会采样一部分键，对超大库往往首轮就返回 0 条匹配，
        // 必须持续遍历才能拿到结果（与主流 Redis GUI 行为一致）。
        // 每轮用更大的 COUNT 加快遍历；SCAN 在 rehash 时可能重复返回键，需去重。
        let scan_hint = (want as u64).saturating_mul(5).max(1000);
        let max_iters: u32 = 200_000;
        let mut seen: HashSet<String> = HashSet::new();
        let mut collected: Vec<RedisKeyInfo> = Vec::new();
        let mut cur = cursor.clone();
        let mut iters = 0u32;
        loop {
            let mut cmd = redis::cmd("SCAN");
            cmd.arg(&cur);
            cmd.arg("MATCH").arg(&pat);
            cmd.arg("COUNT").arg(scan_hint);
            let (next, keys): (String, Vec<Vec<u8>>) =
                cmd.query(&mut conn).map_err(|e| e.to_string())?;
            for k in keys {
                let key = b2s(k);
                if !seen.insert(key.clone()) {
                    continue; // 去重
                }
                let rtype: String = redis::cmd("TYPE")
                    .arg(&key)
                    .query(&mut conn)
                    .map_err(|e| e.to_string())?;
                let ttl: i64 = redis::cmd("TTL")
                    .arg(&key)
                    .query(&mut conn)
                    .map_err(|e| e.to_string())?;
                collected.push(RedisKeyInfo { key, rtype, ttl });
            }
            cur = next;
            iters += 1;
            if cur == "0" || collected.len() >= want || iters >= max_iters {
                break;
            }
        }
        Ok(RedisScanResult {
            cursor: cur,
            keys: collected,
        })
    })
    .await
}

#[tauri::command]
pub async fn redis_get(
    state: State<'_, AppState>,
    args: RedisKeyArgs,
) -> Result<RedisValue, String> {
    let RedisKeyArgs { id, db, key } = args;
    let clients = state.redis_clients.clone();
    run_blocking(move || {
        let mut conn = redis_conn_of(&clients, &id, db)?;
        let rtype: String = redis::cmd("TYPE")
            .arg(&key)
            .query(&mut conn)
            .map_err(|e| e.to_string())?;
        let ttl: i64 = redis::cmd("TTL")
            .arg(&key)
            .query(&mut conn)
            .map_err(|e| e.to_string())?;

        if rtype == "none" {
            return Err(format!("键「{key}」不存在"));
        }

        let (size, string, list, set, zset, hash) = match rtype.as_str() {
            "string" => {
                let v: Option<Vec<u8>> = conn.get(&key).map_err(|e| e.to_string())?;
                match v {
                    Some(b) => (b.len(), Some(b2s(b)), None, None, None, None),
                    None => (0, Some(String::new()), None, None, None, None),
                }
            }
            "list" => {
                let v: Vec<Vec<u8>> = conn
                    .lrange(&key, 0, -1)
                    .map_err(|e| e.to_string())?;
                let size = v.len();
                (size, None, Some(v.into_iter().map(b2s).collect()), None, None, None)
            }
            "set" => {
                let v: Vec<Vec<u8>> = conn.smembers(&key).map_err(|e| e.to_string())?;
                let size = v.len();
                (size, None, None, Some(v.into_iter().map(b2s).collect()), None, None)
            }
            "zset" => {
                let v: Vec<(Vec<u8>, f64)> = redis::cmd("ZRANGE")
                    .arg(&key)
                    .arg(0)
                    .arg(-1)
                    .arg("WITHSCORES")
                    .query(&mut conn)
                    .map_err(|e| e.to_string())?;
                let size = v.len();
                (
                    size,
                    None,
                    None,
                    None,
                    Some(
                        v.into_iter()
                            .map(|(m, s)| RedisZMember {
                                member: b2s(m),
                                score: s,
                            })
                            .collect(),
                    ),
                    None,
                )
            }
            "hash" => {
                let v: Vec<(Vec<u8>, Vec<u8>)> = conn.hgetall(&key).map_err(|e| e.to_string())?;
                let size = v.len();
                (
                    size,
                    None,
                    None,
                    None,
                    None,
                    Some(
                        v.into_iter()
                            .map(|(f, val)| RedisHashField {
                                field: b2s(f),
                                value: b2s(val),
                            })
                            .collect(),
                    ),
                )
            }
            // stream 等暂不预览
            other => {
                return Ok(RedisValue {
                    key,
                    rtype: other.to_string(),
                    ttl,
                    size: 0,
                    string: None,
                    list: None,
                    set: None,
                    zset: None,
                    hash: None,
                });
            }
        };

        Ok(RedisValue {
            key,
            rtype,
            ttl,
            size,
            string,
            list,
            set,
            zset,
            hash,
        })
    })
    .await
}

#[tauri::command]
pub async fn redis_set(
    state: State<'_, AppState>,
    args: RedisSetArgs,
) -> Result<(), String> {
    let RedisSetArgs {
        id,
        db,
        key,
        rtype,
        string,
        list,
        set,
        zset,
        hash,
        ttl,
    } = args;
    let clients = state.redis_clients.clone();
    run_blocking(move || {
        let mut conn = redis_conn_of(&clients, &id, db)?;
        // 先删除旧值，避免类型冲突
        conn.del::<_, ()>(&key).map_err(|e| e.to_string())?;
        // 先校验类型，避免在 match 里提前 return 触发 never-type 推断问题
        let known = matches!(rtype.as_str(), "string" | "list" | "set" | "zset" | "hash");
        if !known {
            return Err(format!("不支持的类型: {rtype}"));
        }
        match rtype.as_str() {
            "string" => {
                let v = string.unwrap_or_default();
                conn.set::<_, _, ()>(&key, v).map_err(|e| e.to_string())?;
            }
            "list" => {
                if let Some(items) = list {
                    if !items.is_empty() {
                        conn.rpush::<_, _, ()>(&key, items).map_err(|e| e.to_string())?;
                    }
                }
            }
            "set" => {
                if let Some(items) = set {
                    if !items.is_empty() {
                        conn.sadd::<_, _, ()>(&key, items).map_err(|e| e.to_string())?;
                    }
                }
            }
            "zset" => {
                if let Some(items) = zset {
                    for m in items {
                        conn.zadd::<_, _, _, ()>(&key, m.member, m.score)
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            "hash" => {
                if let Some(items) = hash {
                    if !items.is_empty() {
                        let pairs: Vec<(String, String)> = items
                            .into_iter()
                            .map(|h| (h.field, h.value))
                            .collect();
                        conn.hset_multiple::<_, _, _, ()>(&key, &pairs)
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            _ => {}
        }
        // 过期时间
        match ttl {
            Some(n) if n > 0 => {
                conn.expire::<_, ()>(&key, n).map_err(|e| e.to_string())?;
            }
            Some(_) => {
                conn.persist::<_, ()>(&key).map_err(|e| e.to_string())?;
            }
            None => {}
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn redis_del(
    state: State<'_, AppState>,
    args: RedisKeyArgs,
) -> Result<u64, String> {
    let RedisKeyArgs { id, db, key } = args;
    let clients = state.redis_clients.clone();
    run_blocking(move || {
        let mut conn = redis_conn_of(&clients, &id, db)?;
        let n: u64 = conn.del(&key).map_err(|e| e.to_string())?;
        Ok(n)
    })
    .await
}

#[tauri::command]
pub async fn redis_expire(
    state: State<'_, AppState>,
    args: RedisTtlArgs,
) -> Result<(), String> {
    let RedisTtlArgs { id, db, key, ttl } = args;
    let clients = state.redis_clients.clone();
    run_blocking(move || {
        let mut conn = redis_conn_of(&clients, &id, db)?;
        if ttl > 0 {
            conn.expire::<_, ()>(&key, ttl).map_err(|e| e.to_string())?;
        } else {
            conn.persist::<_, ()>(&key).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}
