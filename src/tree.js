import { api } from './api.js'
import { store } from './store.js'
import { showContextMenu, toast, setStatus, escapeHtml } from './ui.js'
import { openConnDialog, deleteConn } from './conn.js'
import { openTabs } from './main.js'

let filter = ''

export async function refreshTree() {
  await loadConnections()
  renderTree()
}

async function loadConnections() {
  const list = await api.listConnections()
  store.configs.clear()
  for (const c of list) store.configs.set(c.id, c)
}

export async function connectTo(cfg) {
  if (store.isConnected(cfg.id)) {
    renderTree()
    return
  }
  setStatus(`正在连接 ${cfg.host}:${cfg.port} …`)
  try {
    const info = await api.connect(cfg)
    store.sessions.set(cfg.id, info)
    ensureTreeState(cfg.id).expanded = true
    renderTree()
    setStatus(`已连接 ${cfg.name} · MySQL ${info.server_version}`)
    toast(`已连接「${cfg.name}」`, 'ok')
  } catch (e) {
    setStatus('连接失败')
    toast(String(e), 'error', 6000)
    renderTree()
  }
}

function ensureTreeState(id) {
  if (!store.treeState[id]) store.treeState[id] = { expanded: false }
  return store.treeState[id]
}

export function renderTree() {
  const root = document.getElementById('tree')

  if (store.configs.size === 0) {
    root.innerHTML = `<div class="tree-empty">
      还没有连接<br/>点击下方按钮创建
      <br/><button class="btn btn-primary" id="tree-new-conn">＋ 新建连接</button>
    </div>`
    root.querySelector('#tree-new-conn').onclick = () => openConnDialog()
    return
  }

  root.innerHTML = ''
  for (const cfg of store.configs.values()) {
    root.appendChild(renderConnNode(cfg))
  }
}

/** 统一的展开箭头渲染（避免多处手写 class） */
function setArrow(el, state) {
  if (state === 'open') { el.textContent = '▶'; el.className = 'arrow clickable open' }
  else if (state === 'closed') { el.textContent = '▶'; el.className = 'arrow clickable' }
  else { el.textContent = ''; el.className = 'arrow' }
}

/**
 * 展开交互（macOS Finder 风格，保证双击可靠切换）：
 * - 单击行：仅选中（不切换，否则双击会切 2 次，净效果为零 = 用户说的"不灵敏"）
 * - 双击行：切换展开/折叠
 * - 单击箭头：立即切换（stopPropagation，避免冒泡触发行的双击）
 */
function bindRowToggle(row, arrowEl, toggle, { onClick = null } = {}) {
  if (arrowEl) {
    arrowEl.onclick = (e) => { e.stopPropagation(); selectRow(row); toggle() }
    // 双击箭头时不要让行级 dblclick 再切一次
    arrowEl.ondblclick = (e) => e.stopPropagation()
  }
  row.onclick = () => { selectRow(row); onClick?.() }
  row.ondblclick = (e) => {
    if (e.target === arrowEl) return
    e.preventDefault()
    selectRow(row)
    toggle()
  }
}

function selectRow(row) {
  document.querySelectorAll('.node-row.selected').forEach((el) => el.classList.remove('selected'))
  row.classList.add('selected')
}

// ================= 连接节点 =================

function renderConnNode(cfg) {
  const st = ensureTreeState(cfg.id)
  const connected = store.isConnected(cfg.id)
  const node = document.createElement('div')
  node.className = 'tree-node'

  const row = document.createElement('div')
  row.className = 'node-row'
  row.innerHTML = `
    <span class="arrow"></span>
    <span class="node-icon"><span class="ic-dot ${connected ? 'on' : 'off'}"></span></span>
    <span class="node-label">${escapeHtml(cfg.name)}</span>
    <span class="node-actions">
      ${connected
        ? '<button class="icon-btn" data-act="refresh" title="刷新">⟳</button><button class="icon-btn" data-act="disc" title="断开">⏻</button>'
        : '<button class="icon-btn" data-act="connect" title="连接">▶</button>'}
    </span>`
  node.appendChild(row)
  setArrow(row.querySelector('.arrow'), connected ? (st.expanded ? 'open' : 'closed') : 'none')

  const info = store.sessions.get(cfg.id)

  const toggle = async () => {
    if (!store.isConnected(cfg.id)) { await connectTo(cfg); return }
    st.expanded = !st.expanded
    renderTree()
  }
  // 未连接时单击即发起连接（连接是主操作）；已连接时双击/箭头负责展开
  bindRowToggle(row, row.querySelector('.arrow'), toggle, {
    onClick: () => { if (!store.isConnected(cfg.id)) connectTo(cfg) },
  })

  row.querySelector('.node-actions').onclick = (e) => {
    e.stopPropagation()
    const act = e.target.dataset?.act
    if (act === 'connect') connectTo(cfg)
    if (act === 'refresh') { loadDbs(cfg.id).then(renderTree); toast('刷新中…') }
    if (act === 'disc') {
      store.disconnect(cfg.id)
      renderTree()
      toast('已断开')
    }
  }

  row.oncontextmenu = (e) => {
    e.preventDefault()
    selectRow(row)
    const firstDb = cfg.database || info?.databases.find((d) => !d.system)?.name || ''
    showContextMenu(e.clientX, e.clientY, [
      { label: connected ? '刷新数据库列表' : '连接', action: () => connected ? loadDbs(cfg.id).then(renderTree) : connectTo(cfg) },
      { label: '编辑连接', action: () => openConnDialog(cfg) },
      '-',
      { label: '新建查询', disabled: !connected, action: () => openTabs.openQuery(cfg.id, firstDb) },
      '-',
      { label: connected ? '展开全部' : '', disabled: !connected, action: () => { st.expanded = true; renderTree() } },
      { label: connected ? '折叠全部' : '', disabled: !connected, action: () => { st.expanded = false; renderTree() } },
      { label: connected ? '断开连接' : '', disabled: !connected, action: () => { store.disconnect(cfg.id); renderTree() } },
      { label: '删除连接', action: () => deleteConn(cfg) },
    ].filter((it) => it === '-' || it.label))
  }

  const children = document.createElement('div')
  children.className = 'node-children'
  children.style.display = st.expanded && connected ? '' : 'none'
  node.appendChild(children)

  if (st.expanded && connected) {
    const dbs = (info?.databases || []).filter((d) => matches(d.name))
    for (const db of dbs) children.appendChild(renderDbNode(cfg, db))
    if (!dbs.length) {
      children.innerHTML = '<div class="node-row"><span class="node-label" style="color:var(--muted)">（无匹配的数据库）</span></div>'
    }
  }
  return node
}

function matches(name) {
  const q = filter.trim().toLowerCase()
  return !q || name.toLowerCase().includes(q)
}

async function loadDbs(connId) {
  try {
    const dbs = await api.listDatabases(connId)
    const s = store.sessions.get(connId)
    if (s) s.databases = dbs
  } catch (e) {
    toast(String(e), 'error')
  }
}

// ================= 数据库节点（下含：表 / 查询） =================

function renderDbNode(cfg, db) {
  const key = `${cfg.id}/${db.name}`
  const st = ensureTreeState(key)
  const node = document.createElement('div')
  node.className = 'tree-node'
  const row = document.createElement('div')
  row.className = 'node-row'
  row.innerHTML = `
    <span class="arrow"></span>
    <span class="node-icon">🛢</span>
    <span class="node-label">${escapeHtml(db.name)}${db.system ? '<span class="node-badge gray">系统</span>' : ''}</span>
    <span class="node-actions"><button class="icon-btn" data-act="q" title="新建查询">✎</button></span>`
  node.appendChild(row)
  setArrow(row.querySelector('.arrow'), st.expanded ? 'open' : 'closed')

  const children = document.createElement('div')
  children.className = 'node-children'
  children.style.display = st.expanded ? '' : 'none'
  node.appendChild(children)

  const toggle = () => { st.expanded = !st.expanded; renderTree() }
  bindRowToggle(row, row.querySelector('.arrow'), toggle)

  row.querySelector('[data-act="q"]').onclick = (e) => {
    e.stopPropagation()
    openTabs.openQuery(cfg.id, db.name)
  }

  row.oncontextmenu = (e) => {
    e.preventDefault()
    selectRow(row)
    showContextMenu(e.clientX, e.clientY, [
      { label: '打开表列表', action: () => openTabs.openTables(cfg.id, db.name) },
      { label: '打开查询列表', action: () => openTabs.openQueries(cfg.id, db.name) },
      '-',
      { label: '新建表', action: () => openTabs.openDesign(cfg.id, db.name) },
      { label: '新建查询', action: () => openTabs.openQuery(cfg.id, db.name) },
      { label: '刷新表列表', action: () => {
        st.expanded = true
        api.listTables(cfg.id, db.name)
          .then((tables) => { st.tables = tables; toast('表列表已刷新', 'ok'); renderTree() })
          .catch((err) => toast(String(err), 'error'))
      } },
      '-',
      { label: st.expanded ? '折叠' : '展开', action: toggle },
      { label: '复制库名', action: () => copyText(db.name) },
    ])
  }

  if (st.expanded) {
    children.appendChild(renderGroupNode(cfg, db, 'tables', '表', '▦', () => openTabs.openTables(cfg.id, db.name)))
    children.appendChild(renderGroupNode(cfg, db, 'queries', '查询', '✎', () => openTabs.openQueries(cfg.id, db.name)))
  }
  return node
}

/** 数据库下的两类子节点：表 / 查询（叶子节点，点击直接开右侧页面） */
function renderGroupNode(cfg, db, kind, label, icon, open) {
  const node = document.createElement('div')
  node.className = 'tree-node'
  const row = document.createElement('div')
  row.className = 'node-row leaf'
  row.innerHTML = `
    <span class="arrow"></span>
    <span class="node-icon">${icon}</span>
    <span class="node-label">${label}</span>`
  node.appendChild(row)

  // 叶子节点：单击直接打开对应页面（无展开状态，无双击歧义）
  row.onclick = () => { selectRow(row); open() }

  row.oncontextmenu = (e) => {
    e.preventDefault()
    selectRow(row)
    showContextMenu(e.clientX, e.clientY, [
      { label: `打开${label}列表`, action: open },
    ])
  }
  return node
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制', 'ok', 1200)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); toast('已复制', 'ok', 1200) }
    catch { toast('复制失败', 'error') }
    ta.remove()
  }
}

export function fmtNum(n) {
  if (n == null) return '-'
  return n.toLocaleString('en-US')
}

// 搜索框：现在只筛数据库名（表已不在树里，改为在表列表页内筛选）
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('tree-search')
  input.placeholder = '筛选数据库…'
  input.addEventListener('input', () => {
    filter = input.value
    for (const [id] of store.configs) ensureTreeState(id).expanded = true
    renderTree()
  })
})
