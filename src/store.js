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
