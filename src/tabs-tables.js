import { api } from './api.js'
import { toast, escapeHtml, showContextMenu } from './ui.js'
import { openTabs } from './main.js'
import { fmtNum, copyText } from './tree.js'
import { highlightSqlToHtml } from './sql-highlight.js'

// 右侧 DDL 面板：是否展开 / 宽度都跨会话记住
const DDL_OPEN_KEY = 'mysql-studio-tables-ddl-open'
const DDL_WIDTH_KEY = 'mysql-studio-tables-ddl-width'
const DDL_MIN_W = 240
const DDL_DEFAULT_W = 460

function fmtSize(bytes) {
  if (!bytes) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

function qi(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

/**
 * 表列表页：展示某个库下的全部表 / 视图
 * 右侧可显示/隐藏 DDL 面板：单击行即预览该表的 CREATE 语句（像 Navicat 那样
 * 不用开新标签页就能看建表语句）。
 */
export function renderTablesTab(panel, tab) {
  const st = (tab.state = {
    tables: [],
    loading: false,
    loaded: false,
    sort: { key: 'name', dir: 'ASC' },
    search: '',
    selected: null,
    ddl: new Map(), // 表名 -> { text } / { error }，切页/重复点击都不再请求
    ddlSeq: 0,
    ddlOpen: localStorage.getItem(DDL_OPEN_KEY) !== '0',
  })

  panel.innerHTML = `
    <div class="list-panel">
      <div class="list-toolbar">
        <button class="btn btn-sm btn-primary" data-act="refresh">⟳ 刷新</button>
        <button class="btn btn-sm" data-act="new-table">＋ 新建表</button>
        <span class="tb-sep"></span>
        <span class="tb-label" data-ref="db-label"></span>
        <span class="tb-sep"></span>
        <input class="list-search" data-ref="search" placeholder="筛选表名…" spellcheck="false"/>
        <span style="flex:1"></span>
        <label class="chk"><input type="checkbox" data-ref="show-views" checked/> 显示视图</label>
        <span class="tb-sep"></span>
        <button class="btn btn-sm" data-act="toggle-ddl" title="显示 / 隐藏右侧 DDL 面板">▤ DDL</button>
        <span class="tb-label" data-ref="info">加载中…</span>
      </div>
      <div class="list-body">
        <div class="list-wrap" data-ref="wrap" tabindex="0"></div>
        <div class="list-splitter" data-ref="splitter" title="拖动调整宽度 · 双击复位"></div>
        <aside class="ddl-side" data-ref="ddl-side">
          <div class="ddl-head">
            <span class="ddl-name" data-ref="ddl-name">DDL</span>
            <span style="flex:1"></span>
            <button class="btn btn-sm" data-act="ddl-copy" title="复制 DDL 语句" disabled>复制</button>
            <button class="btn btn-sm" data-act="ddl-query" title="在查询页打开这段 DDL" disabled>查询页</button>
            <button class="btn btn-sm" data-act="ddl-hide" title="隐藏 DDL 面板">✕</button>
          </div>
          <pre class="ddl-pre" data-ref="ddl-pre"></pre>
          <div class="ddl-foot" data-ref="ddl-foot"></div>
        </aside>
      </div>
    </div>`

  const R = (n) => panel.querySelector(`[data-ref="${n}"]`)
  const A = (n) => panel.querySelector(`[data-act="${n}"]`)
  const root = panel.querySelector('.list-panel')
  R('db-label').innerHTML = `<b>${escapeHtml(tab.db)}</b>`
  R('search').value = st.search

  const savedW = parseInt(localStorage.getItem(DDL_WIDTH_KEY), 10)
  if (savedW >= DDL_MIN_W) R('ddl-side').style.width = savedW + 'px'

  // ---------- 载入表列表 ----------
  /**
   * @param {object} o
   * @param {boolean} o.silent 静默刷新：不显示"加载中"，且列表没变化时完全不重绘
   *        （切回标签页时用它，避免每切一次都闪一下、丢掉滚动位置）
   */
  async function load({ silent = false } = {}) {
    if (st.loading) return
    st.loading = true
    if (!silent) R('info').textContent = '加载中…'
    try {
      const tables = await api.listTables(tab.connId, tab.db)
      const changed = !st.loaded ||
        tables.length !== st.tables.length ||
        tables.some((t, i) => t.name !== st.tables[i]?.name || t.table_type !== st.tables[i]?.table_type)
      st.tables = tables
      st.loaded = true
      if (changed) {
        // 选中的表被删掉了 → 清空 DDL 面板
        if (st.selected && !tables.some((t) => t.name === st.selected)) {
          st.selected = null
          renderDdl()
        }
        renderRows()
      } else {
        renderInfo()
      }
    } catch (e) {
      if (!silent) {
        R('wrap').innerHTML = `<div class="grid-empty" style="color:var(--danger)">${escapeHtml(String(e))}</div>`
        R('info').textContent = '加载失败'
      }
    } finally {
      st.loading = false
    }
  }

  function visible() {
    const q = R('search').value.trim().toLowerCase()
    const showViews = R('show-views').checked
    let list = st.tables.filter((t) => (showViews || t.table_type !== 'VIEW') && (!q || t.name.toLowerCase().includes(q)))
    const { key, dir } = st.sort
    const sign = dir === 'DESC' ? -1 : 1
    list = [...list].sort((a, b) => {
      const va = a[key], vb = b[key]
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign
      return String(va).localeCompare(String(vb)) * sign
    })
    return list
  }

  function sortMark(key) {
    return st.sort.key === key ? (st.sort.dir === 'DESC' ? ' ▼' : ' ▲') : ''
  }

  function renderInfo() {
    const views = st.tables.filter((t) => t.table_type === 'VIEW').length
    R('info').innerHTML =
      `共 <b>${st.tables.length}</b> 个对象（表 <b>${st.tables.length - views}</b> · 视图 <b>${views}</b>）`
  }

  // ---------- 行 ----------
  function renderRows() {
    const wrap = R('wrap')
    const keepTop = wrap.scrollTop
    const list = visible()
    const head = (key, label, cls = '') =>
      `<th class="${cls}" data-sort="${key}">${label}${sortMark(key)}</th>`
    const rows = list
      .map((t) => {
        const icon = t.table_type === 'VIEW' ? '▣' : '▦'
        return `<tr data-name="${escapeHtml(t.name)}" data-type="${escapeHtml(t.table_type)}"${
          t.name === st.selected ? ' class="selected"' : ''
        }>
          <td class="c-icon">${icon}</td>
          <td class="c-name mono"><b>${escapeHtml(t.name)}</b></td>
          <td>${t.table_type === 'VIEW' ? '<span class="tag blue">视图</span>' : '<span class="tag">表</span>'}</td>
          <td class="num">${fmtNum(t.rows)}</td>
          <td class="mono">${escapeHtml(t.engine || '—')}</td>
          <td class="num">${fmtSize(t.data_length)}</td>
          <td class="c-comment" title="${escapeHtml(t.comment || '')}">${escapeHtml(t.comment || '—')}</td>
        </tr>`
      })
      .join('')

    wrap.innerHTML = `
      <table class="list-grid">
        <thead><tr>
          <th class="c-icon"></th>
          ${head('name', '表名')}
          ${head('table_type', '类型')}
          ${head('rows', '行数（估算）', 'num')}
          ${head('engine', '引擎')}
          ${head('data_length', '数据大小', 'num')}
          ${head('comment', '注释')}
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">没有匹配的表</td></tr>'}</tbody>
      </table>`
    wrap.scrollTop = keepTop

    wrap.querySelectorAll('th[data-sort]').forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.sort
        if (st.sort.key === key) st.sort.dir = st.sort.dir === 'ASC' ? 'DESC' : 'ASC'
        else st.sort = { key, dir: 'ASC' }
        renderRows()
      }
    })

    wrap.querySelectorAll('tbody tr[data-name]').forEach((tr) => {
      const name = tr.dataset.name
      tr.title = `${name} · 双击打开数据`
      tr.onclick = () => selectRow(name)
      tr.ondblclick = () => openData(name)
      tr.oncontextmenu = (e) => {
        e.preventDefault()
        selectRow(name)
        const qname = `${qi(tab.db)}.${qi(name)}`
        const isView = tr.dataset.type === 'VIEW'
        showContextMenu(e.clientX, e.clientY, [
          { label: '打开数据', action: () => openData(name) },
          { label: '查看结构', action: () => openTabs.openStruct(tab.connId, tab.db, name) },
          {
            label: '查看 DDL',
            action: () => { setDdlOpen(true); loadDdl(name); R('wrap').blur() },
          },
          { label: '设计表', action: () => openTabs.openDesign(tab.connId, tab.db, name), disabled: isView },
          { label: '新建查询 (SELECT)', action: () => openTabs.openQuery(tab.connId, tab.db, `SELECT * FROM ${qname} LIMIT 100;`) },
          '-',
          { label: '复制 CREATE 语句', action: () => copyDdl(name) },
          { label: '复制 SELECT 语句', action: () => copyText(`SELECT * FROM ${qname}`) },
          { label: '复制表名', action: () => copyText(name) },
        ])
      }
    })

    // 只有表真的被删掉了才清空 DDL；被筛选条件挡住时保持右侧内容不变
    if (st.selected && !st.tables.some((t) => t.name === st.selected)) {
      st.selected = null
      renderDdl()
    }
    renderInfo()
  }

  function openData(name) {
    openTabs.openData(tab.connId, tab.db, name)
  }

  /** 单击选中：高亮 + （面板可见时）立刻预览 DDL */
  function selectRow(name) {
    st.selected = name
    R('wrap').querySelectorAll('tbody tr[data-name]').forEach((tr) => {
      tr.classList.toggle('selected', tr.dataset.name === name)
    })
    if (st.ddlOpen) loadDdl(name)
    else renderDdlHead()
  }

  /** 上下方向键移动选中行（列表获得焦点时生效） */
  function moveSelection(delta) {
    const list = visible()
    if (!list.length) return
    const cur = list.findIndex((t) => t.name === st.selected)
    let next
    if (cur < 0) next = list[delta > 0 ? 0 : list.length - 1]
    else next = list[Math.min(list.length - 1, Math.max(0, cur + delta))]
    selectRow(next.name)
    const tr = R('wrap').querySelector(`tbody tr[data-name="${cssEsc(next.name)}"]`)
    tr?.scrollIntoView({ block: 'nearest' })
  }

  // ---------- DDL 面板 ----------
  function setDdlOpen(open) {
    st.ddlOpen = open
    root.classList.toggle('ddl-hidden', !open)
    A('toggle-ddl').classList.toggle('active', open)
    localStorage.setItem(DDL_OPEN_KEY, open ? '1' : '0')
    if (open && st.selected) loadDdl(st.selected)
  }

  function renderDdlHead() {
    const name = st.selected
    R('ddl-name').textContent = name || 'DDL'
    R('ddl-name').title = name ? `${tab.db}.${name}` : '选择一张表查看 DDL'
    const ready = !!name && !!st.ddl.get(name)?.text
    A('ddl-copy').disabled = !ready
    A('ddl-query').disabled = !ready
  }

  function renderDdl() {
    renderDdlHead()
    const pre = R('ddl-pre')
    const foot = R('ddl-foot')
    if (!st.selected) {
      pre.innerHTML = '<span class="ddl-placeholder">在上面列表中点选一张表（或按 ↑ ↓ 切换），这里会显示它的 CREATE 语句。</span>'
      foot.textContent = ''
      return
    }
    const entry = st.ddl.get(st.selected)
    if (!entry) {
      pre.innerHTML = '<span class="ddl-placeholder">加载 DDL…</span>'
      foot.textContent = ''
      return
    }
    if (entry.error) {
      pre.innerHTML = `<span class="ddl-error">${escapeHtml(entry.error)}</span>`
      foot.textContent = ''
      return
    }
    const text = String(entry.text ?? '')
    pre.innerHTML = highlightSqlToHtml(text)
    const lines = text.split('\n').length
    foot.innerHTML = `<span>${lines} 行 · ${text.length} 字符</span><span style="flex:1"></span><span>${escapeHtml(st.selected)}</span>`
  }

  async function loadDdl(name) {
    if (!name) return
    renderDdlHead()
    if (st.ddl.has(name)) { renderDdl(); return }
    const type = st.tables.find((t) => t.name === name)?.table_type
    const seq = ++st.ddlSeq
    R('ddl-pre').innerHTML = '<span class="ddl-placeholder">加载 DDL…</span>'
    R('ddl-foot').textContent = ''
    try {
      st.ddl.set(name, { text: await fetchDdl(name, type) })
    } catch (e) {
      st.ddl.set(name, { error: String(e) })
    }
    if (seq === st.ddlSeq) renderDdl()
  }

  /** 优先用专用命令（不截断长 DDL）；老版本后端没有该命令时退回普通查询 */
  async function fetchDdl(name, type) {
    try {
      const ddl = await api.getTableDdl(tab.connId, tab.db, name)
      if (typeof ddl === 'string' && ddl.trim()) return ddl
    } catch (e) {
      // 只有"命令不存在"才降级；权限/语法等真实错误要原样抛给用户看
      if (!/not found|unknown|command|未 mock|unhandled/i.test(String(e))) throw e
    }
    const stmt = type === 'VIEW'
      ? `SHOW CREATE VIEW ${qi(tab.db)}.${qi(name)}`
      : `SHOW CREATE TABLE ${qi(tab.db)}.${qi(name)}`
    const res = await api.executeSql({ session: tab.connId, db: tab.db, sql: stmt, maxRows: 1 })
    const r = res?.[0]
    if (!r) throw new Error('没有返回结果')
    if (r.error) throw new Error(r.error)
    // SHOW CREATE TABLE → [表名, DDL]；SHOW CREATE VIEW → [视图名, DDL, ...]
    const row = r.rows?.[0] || []
    const text = row[1] ?? row[0] ?? ''
    if (!text) throw new Error('该对象没有可显示的 DDL')
    return text
  }

  function copyDdl(name) {
    const t = st.ddl.get(name || st.selected)?.text
    if (!t) { toast('DDL 还没加载好，请稍候', 'error', 2000); return }
    copyText(t)
  }

  // ---------- 面板宽度拖拽 ----------
  let drag = null
  R('splitter').addEventListener('mousedown', (e) => {
    e.preventDefault()
    drag = { x: e.clientX, w: R('ddl-side').getBoundingClientRect().width }
    R('splitter').classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  })
  document.addEventListener('mousemove', (e) => {
    if (!drag) return
    const maxW = Math.max(DDL_MIN_W, panel.clientWidth * 0.72)
    const w = Math.min(maxW, Math.max(DDL_MIN_W, drag.w - (e.clientX - drag.x)))
    R('ddl-side').style.width = w + 'px'
  })
  document.addEventListener('mouseup', () => {
    if (!drag) return
    drag = null
    R('splitter').classList.remove('dragging')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    localStorage.setItem(DDL_WIDTH_KEY, String(Math.round(R('ddl-side').getBoundingClientRect().width)))
  })
  R('splitter').addEventListener('dblclick', () => {
    localStorage.removeItem(DDL_WIDTH_KEY)
    R('ddl-side').style.width = DDL_DEFAULT_W + 'px'
  })

  // ---------- 事件绑定 ----------
  A('refresh').onclick = () => {
    st.ddl.clear()
    if (st.selected && st.ddlOpen) loadDdl(st.selected)
    load()
  }
  A('new-table').onclick = () => openTabs.openDesign(tab.connId, tab.db)
  A('toggle-ddl').onclick = () => setDdlOpen(!st.ddlOpen)
  A('ddl-hide').onclick = () => setDdlOpen(false)
  A('ddl-copy').onclick = () => copyDdl()
  A('ddl-query').onclick = () => {
    const t = st.ddl.get(st.selected)?.text
    if (!t) return
    openTabs.openQuery(tab.connId, tab.db, t.trim().endsWith(';') ? t : t + ';')
  }
  R('search').oninput = () => { st.search = R('search').value; renderRows() }
  R('show-views').onchange = renderRows
  R('wrap').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      moveSelection(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && st.selected) {
      e.preventDefault()
      openData(st.selected)
    } else if (e.key === 'Escape') {
      R('search').value = ''
      st.search = ''
      renderRows()
    }
  })

  // 切回该页：静默刷新（不闪、不丢筛选与滚动位置），别处建了表也能看到
  tab.onShow = () => load({ silent: true })

  setDdlOpen(st.ddlOpen)
  renderDdl()
  load()
}

/** CSS 属性选择器里的字符串转义（表名可能含引号/反斜杠） */
function cssEsc(s) {
  return String(s).replace(/["\\]/g, '\\$&')
}
