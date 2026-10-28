// 全局前端状态
import { api } from './api.js'

export const store = {
  /** 连接配置列表 id -> config */
  configs: new Map(),
  /** 已连接会话 id -> { info, dbs: DbInfo[] } */
  sessions: new Map(),
  /** 树展开/选中状态 id -> { expanded, connected } */
  treeState: {},
  /** 查询页 schema 缓存 connId -> { dbName -> { table -> [cols] } } */
  schemaCache: new Map(),

  isConnected(id) {
    return this.sessions.has(id)
  },
  disconnect(id) {
    this.sessions.delete(id)
    api.disconnect(id).catch(() => {})
    // 关闭该连接的所有 tab 由 main.js 处理
    document.dispatchEvent(new CustomEvent('conn-closed', { detail: id }))
  },
}

// Redis 搜索历史：按「连接@db」维度持久化到 localStorage，跨会话保留，可点击复用
const REDIS_HISTORY_KEY = 'ql.redis.history.v1'
const REDIS_HISTORY_MAX = 30

function loadHistoryMap() {
  try {
    const raw = localStorage.getItem(REDIS_HISTORY_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveHistoryMap(map) {
  try { localStorage.setItem(REDIS_HISTORY_KEY, JSON.stringify(map)) } catch { /* 忽略隐私模式等写入失败 */ }
}

export const redisHistory = {
  /** 返回某连接某 db 的最近关键词列表（最新在前） */
  get(connId, db) {
    return loadHistoryMap()[`${connId}@${db}`] || []
  },
  /** 记录一次查询关键词：去重并置顶，超过上限丢弃最旧 */
  add(connId, db, keyword) {
    const kw = (keyword || '').trim()
    if (!kw) return
    const map = loadHistoryMap()
    const k = `${connId}@${db}`
    const next = [kw, ...(map[k] || []).filter((x) => x !== kw)].slice(0, REDIS_HISTORY_MAX)
    map[k] = next
    saveHistoryMap(map)
  },
  /** 清除某连接某 db 的历史 */
  clear(connId, db) {
    const map = loadHistoryMap()
    delete map[`${connId}@${db}`]
    saveHistoryMap(map)
  },
  /** 删除某连接某 db 的某一条历史关键词 */
  remove(connId, db, keyword) {
    const map = loadHistoryMap()
    const k = `${connId}@${db}`
    const next = (map[k] || []).filter((x) => x !== keyword)
    if (next.length) map[k] = next
    else delete map[k]
    saveHistoryMap(map)
  },
}
