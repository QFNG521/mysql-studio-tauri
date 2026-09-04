import { store } from './store.js'
import './styles.css'
import { openConnDialog } from './conn.js'
import { refreshTree } from './tree.js'
import { renderDataTab } from './tabs-data.js'
import { renderStructTab } from './tabs-struct.js'
import { renderQueryTab } from './tabs-query.js'
import { renderTablesTab } from './tabs-tables.js'
import { renderQueriesTab } from './tabs-queries.js'
import { renderDesignTab } from './tabs-design.js'
import { toast } from './ui.js'

const tabs = []
let activeTabId = null
let querySeq = 0

const tabbar = () => document.getElementById('tabbar')
const panelsEl = () => document.getElementById('panels')
const emptyState = () => document.getElementById('empty-state')

function updateEmptyState() {
  emptyState().style.display = tabs.length ? 'none' : ''
}

function activateTab(id) {
  activeTabId = id
  for (const t of tabs) {
    t.el.classList.toggle('active', t.id === id)
    t.btn.classList.toggle('active', t.id === id)
    if (t.id === id) {
      t.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      t.onShow?.() // 页面可注册刷新逻辑（如查询列表重新加载）
    }
  }
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  const t = tabs[idx]
  t.el.remove()
  t.btn.remove()
  tabs.splice(idx, 1)
  if (activeTabId === id && tabs.length) {
    activateTab(tabs[Math.max(0, idx - 1)].id)
  }
  updateEmptyState()
}

function createTab(def) {
  // 同一表的结构页复用
  if (def.kind !== 'query') {
    // 筛选条件不同视为不同的数据页
    const exist = tabs.find((t) =>
      t.kind === def.kind && t.connId === def.connId && t.db === def.db && t.table === def.table &&
      (t.whereSql || '') === (def.whereSql || ''),
    )
    if (exist) {
      activateTab(exist.id)
      if (def.initialSql) exist.setSql?.(def.initialSql)
      return exist
    }
  }
  const el = document.createElement('div')
  el.className = 'tab-panel'
  panelsEl().appendChild(el)

  const btn = document.createElement('div')
  btn.className = 'tab'
  btn.innerHTML = `<span class="tab-icon">${def.icon}</span><span class="tab-label"></span><span class="tab-close">✕</span>`
  btn.title = `${def.db || ''}${def.table ? '.' + def.table : ''}${def.whereSql ? ` WHERE ${def.whereSql}` : ''}`
  btn.querySelector('.tab-label').textContent = def.title
  btn.onclick = (e) => {
    if (e.target.classList.contains('tab-close')) return
    activateTab(def.id)
  }
  btn.querySelector('.tab-close').onclick = () => closeTab(def.id)
  btn.oncontextmenu = (e) => {
    e.preventDefault()
    import('./ui.js').then(({ showContextMenu }) => {
      showContextMenu(e.clientX, e.clientY, [{ label: '关闭标签页', action: () => closeTab(def.id) }])
    })
  }
  tabbar().appendChild(btn)

  const tab = { ...def, el, btn, close: () => closeTab(def.id) }
  tabs.push(tab)
  activateTab(tab.id)
  updateEmptyState()

  if (def.kind === 'data') renderDataTab(el, tab)
  else if (def.kind === 'struct') renderStructTab(el, tab)
  else if (def.kind === 'query') renderQueryTab(el, tab, def.initialSql || '')
  else if (def.kind === 'tables') renderTablesTab(el, tab)
  else if (def.kind === 'queries') renderQueriesTab(el, tab)
  else if (def.kind === 'design') renderDesignTab(el, tab)
  return tab
}

export const openTabs = {
  openData(connId, db, table, whereSql = '') {
    const w = (whereSql || '').trim()
    const same = (t) =>
      t.kind === 'data' && t.connId === connId && t.db === db && t.table === table

    // 1) 同表 + 同筛选条件 → 直接激活
    let exist = tabs.find((t) => same(t) && (t.whereSql || '') === w)
    // 2) 带筛选时，优先复用该表未筛选的标签页，避免每跳一次就多开一个页
    if (!exist && w) exist = tabs.find((t) => same(t) && !t.whereSql)

    if (exist) {
      activateTab(exist.id)
      if (w && exist.whereSql !== w) exist.applyWhere?.(w)
      return exist
    }
    createTab({
      id: `data:${connId}/${db}/${table}${w ? '#' + w : ''}`,
      kind: 'data',
      title: w ? `${table} · 筛选` : table,
      icon: '▤',
      connId, db, table, whereSql: w,
    })
  },
  openStruct(connId, db, table) {
    createTab({ id: `struct:${connId}/${db}/${table}`, kind: 'struct', title: `${table} · 结构`, icon: '⚙', connId, db, table })
  },
  /** 设计表：table 为空 = 新建表 */
  openDesign(connId, db, table = null) {
    if (table) {
      createTab({ id: `design:${connId}/${db}/${table}`, kind: 'design', title: `${table} · 设计`, icon: '✏', connId, db, table })
    } else {
      createTab({ id: `design:${connId}/${db}/__new__`, kind: 'design', title: '新建表', icon: '✏', connId, db })
    }
  },
  /** 打开某个库的表列表 */
  openTables(connId, db) {
    createTab({ id: `tables:${connId}/${db}`, kind: 'tables', title: `${db} · 表`, icon: '▦', connId, db })
  },
  /** 打开某个库保存的查询列表 */
  openQueries(connId, db) {
    createTab({ id: `queries:${connId}/${db}`, kind: 'queries', title: `${db} · 查询`, icon: '✎', connId, db })
  },
  /** @param {object|null} savedQuery 已保存的查询（打开已有记录时带上 id，便于 ⌘S 覆盖保存） */
  openQuery(connId, db, sql = '', savedQuery = null) {
    querySeq++
    const title = savedQuery ? savedQuery.name : sql ? '查询*' : `查询 ${querySeq}`
    createTab({
      id: `query:${Date.now()}_${querySeq}`,
      kind: 'query',
      title,
      icon: '✎',
      connId, db, initialSql: sql, savedQuery,
    })
  },
}

// 连接断开时关闭该连接的所有 tab
document.addEventListener('conn-closed', (e) => {
  const connId = e.detail
  for (const t of [...tabs]) {
    if (t.connId === connId) closeTab(t.id)
  }
  toast('连接已断开，相关标签页已关闭')
})

// ---------- 启动 ----------
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btn-new-conn').onclick = () => openConnDialog()

  // tabbar 右侧"+"新建查询
  const plus = document.createElement('div')
  plus.className = 'tab'
  plus.style.padding = '0 10px'
  plus.title = '新建查询'
  plus.innerHTML = '<span style="font-size:15px;color:var(--muted)">＋</span>'
  plus.onclick = () => {
    const cur = tabs.find((t) => t.id === activeTabId)
    const connId = cur?.connId || [...store.sessions.keys()][0]
    if (!connId) { toast('请先连接一个数据库', 'error'); return }
    const db = cur?.db || store.sessions.get(connId)?.databases?.find((d) => !d.system)?.name || ''
    openTabs.openQuery(connId, db)
  }
  tabbar().appendChild(plus)

  await refreshTree()
  updateEmptyState()
})
