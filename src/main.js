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
import { toast, confirmSaveBox, escapeHtml, showContextMenu } from './ui.js'

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

/** 真的把标签页从 DOM 里摘掉（不弹任何提示） */
function removeTab(id) {
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

/** 查询页是否有未保存的修改 */
function isDirtyQuery(t) {
  return t.kind === 'query' && !!t.isDirty?.()
}

/**
 * 关闭一批标签页：先挑出未保存的查询页，让用户决定保存 / 不保存 / 取消。
 * 保存失败或被用户取消命名的标签会被保留下来，不会被关掉。
 */
async function closeTabs(ids) {
  const set = new Set(ids)
  const targets = tabs.filter((t) => set.has(t.id))
  if (!targets.length) return
  const dirty = targets.filter(isDirtyQuery)

  let keep = new Set()
  if (dirty.length) {
    const names = dirty.map((t) => escapeHtml(t.title)).join('、')
    const ans = await confirmSaveBox({
      title: '有未保存的查询',
      message: `以下 <b>${dirty.length}</b> 个查询有未保存的修改：<br/><span style="color:var(--danger)">${names}</span><br/>关闭前是否保存？`,
      saveText: `保存并关闭（${dirty.length}）`,
      dropText: '不保存',
    })
    if (ans === 'cancel') return
    if (ans === 'save') {
      for (const t of dirty) {
        const ok = await t.saveNow?.()
        if (!ok) keep.add(t.id) // 保存失败 / 取名时取消 → 这个标签不关
      }
    }
  }

  for (const t of targets) {
    if (keep.has(t.id)) continue
    removeTab(t.id)
  }
  if (keep.size) {
    const first = tabs.find((t) => t.id === [...keep][0])
    if (first) activateTab(first.id)
    toast('部分标签页未保存，已保留', 'error', 3600)
  }
}

function closeTab(id) {
  return closeTabs([id])
}

/** 标签页右键菜单项：关闭 / 关闭其他 / 关闭左侧 / 关闭右侧 / 全部关闭 */
function tabMenuItems(id) {
  const idx = tabs.findIndex((t) => t.id === id)
  const left = tabs.slice(0, Math.max(0, idx)).map((t) => t.id)
  const right = idx < 0 ? [] : tabs.slice(idx + 1).map((t) => t.id)
  const others = [...left, ...right]
  const all = tabs.map((t) => t.id)
  const withCount = (arr, label) => (arr.length ? `${label}（${arr.length}）` : label)
  return [
    { label: '关闭', action: () => closeTab(id) },
    '-',
    { label: withCount(others, '关闭其他'), disabled: !others.length, action: () => closeTabs(others) },
    { label: withCount(left, '关闭左侧'), disabled: !left.length, action: () => closeTabs(left) },
    { label: withCount(right, '关闭右侧'), disabled: !right.length, action: () => closeTabs(right) },
    '-',
    { label: withCount(all, '全部关闭'), disabled: !all.length, action: () => closeTabs(all) },
  ]
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
    showContextMenu(e.clientX, e.clientY, tabMenuItems(def.id))
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
    // 已保存的查询：重复打开时聚焦到已存在的标签页，不再新开一个
    if (savedQuery?.id) {
      const exist = tabs.find((t) => t.kind === 'query' && t.savedQuery?.id === savedQuery.id)
      if (exist) {
        activateTab(exist.id)
        if (sql != null) exist.setSql?.(sql)
        return exist
      }
    }
    querySeq++
    const title = savedQuery ? savedQuery.name : sql ? '查询*' : `查询 ${querySeq}`
    return createTab({
      id: `query:${Date.now()}_${querySeq}`,
      kind: 'query',
      title,
      icon: '✎',
      connId, db, initialSql: sql, savedQuery,
    })
  },
  /** 从磁盘上的 .sql 文件打开查询；同一文件重复打开复用标签页 */
  openQueryFile(connId, db, filePath, text) {
    const exist = tabs.find((t) => t.kind === 'query' && t.filePath === filePath)
    if (exist) {
      activateTab(exist.id)
      // 同上：非空则不覆盖
      if (text != null && !exist.getSql?.().trim()) exist.setSql?.(text)
      return exist
    }
    querySeq++
    return createTab({
      id: `queryfile:${filePath}`,
      kind: 'query',
      title: baseName(filePath),
      icon: '✎',
      connId, db, initialSql: text, filePath,
    })
  },
  /** 按文件路径查找已打开的查询标签 */
  findQueryByFile(filePath) {
    return tabs.find((t) => t.kind === 'query' && t.filePath === filePath)
  },
  /** 聚焦某个标签页 */
  focusTab(id) { activateTab(id) },
  /** 当前激活的标签页 */
  activeTab() { return tabs.find((t) => t.id === activeTabId) },
}

/** 取路径最后一段文件名（兼容 Windows 反斜杠） */
function baseName(p) {
  return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'query.sql'
}

// 连接断开时关闭该连接的所有 tab
document.addEventListener('conn-closed', (e) => {
  const connId = e.detail
  for (const t of [...tabs]) {
    // 连接都断了，直接移除，不弹保存提示（也连不上库去保存）
    if (t.connId === connId) removeTab(t.id)
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
