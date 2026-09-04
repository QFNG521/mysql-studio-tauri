import { api } from './api.js'
import { toast, escapeHtml, showContextMenu } from './ui.js'
import { openTabs } from './main.js'
import { fmtNum, copyText } from './tree.js'

function fmtSize(bytes) {
  if (!bytes) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

/**
 * 表列表页：展示某个库下的全部表 / 视图
 */
export function renderTablesTab(panel, tab) {
  const st = (tab.state = { tables: [], loading: false, sort: { key: 'name', dir: 'ASC' } })

  panel.innerHTML = `
    <div class="list-panel">
      <div class="list-toolbar">
        <button class="btn btn-sm btn-primary" data-act="refresh">⟳ 刷新</button>
        <button class="btn btn-sm" data-act="new-table">＋ 新建表</button>
        <span class="tb-sep"></span>
        <span class="tb-label" data-ref="db-label"></span>
        <span class="tb-sep"></span>
        <input class="list-search" data-ref="search" placeholder="筛选表名…" spellcheck="false"/>
        <span class="spacer" style="flex:1"></span>
        <label class="chk"><input type="checkbox" data-ref="show-views" checked/> 显示视图</label>
        <span class="tb-sep"></span>
        <span class="tb-label" data-ref="info">加载中…</span>
      </div>
      <div class="list-wrap" data-ref="wrap"></div>
    </div>`

  const R = (n) => panel.querySelector(`[data-ref="${n}"]`)
  const A = (n) => panel.querySelector(`[data-act="${n}"]`)
  R('db-label').innerHTML = `<b>${escapeHtml(tab.db)}</b>`

  async function load() {
    if (st.loading) return
    st.loading = true
    R('info').textContent = '加载中…'
    try {
      st.tables = await api.listTables(tab.connId, tab.db)
      renderRows()
    } catch (e) {
      R('wrap').innerHTML = `<div class="grid-empty" style="color:var(--danger)">${escapeHtml(String(e))}</div>`
      R('info').textContent = '加载失败'
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

  function renderRows() {
    const list = visible()
    const head = (key, label, cls = '') =>
      `<th class="${cls}" data-sort="${key}">${label}${sortMark(key)}</th>`
    const rows = list
      .map((t) => {
        const icon = t.table_type === 'VIEW' ? '▣' : '▦'
        return `<tr data-name="${escapeHtml(t.name)}" data-type="${escapeHtml(t.table_type)}">
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

    R('wrap').innerHTML = `
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

    R('wrap').querySelectorAll('th[data-sort]').forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.sort
        if (st.sort.key === key) st.sort.dir = st.sort.dir === 'ASC' ? 'DESC' : 'ASC'
        else st.sort = { key, dir: 'ASC' }
        renderRows()
      }
    })

    R('wrap').querySelectorAll('tbody tr[data-name]').forEach((tr) => {
      const name = tr.dataset.name
      tr.ondblclick = () => openTabs.openData(tab.connId, tab.db, name)
      tr.oncontextmenu = (e) => {
        e.preventDefault()
        const qname = `\`${tab.db.replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``
        showContextMenu(e.clientX, e.clientY, [
          { label: '打开数据', action: () => openTabs.openData(tab.connId, tab.db, name) },
          { label: '查看结构', action: () => openTabs.openStruct(tab.connId, tab.db, name) },
          { label: '设计表', action: () => openTabs.openDesign(tab.connId, tab.db, name), disabled: tr.dataset.type === 'VIEW' },
          { label: '新建查询 (SELECT)', action: () => openTabs.openQuery(tab.connId, tab.db, `SELECT * FROM ${qname} LIMIT 100;`) },
          '-',
          { label: '复制 SELECT 语句', action: () => copyText(`SELECT * FROM ${qname}`) },
          { label: '复制表名', action: () => copyText(name) },
        ])
      }
    })

    const views = st.tables.filter((t) => t.table_type === 'VIEW').length
    R('info').innerHTML =
      `共 <b>${st.tables.length}</b> 个对象（表 <b>${st.tables.length - views}</b> · 视图 <b>${views}</b>）`
  }

  A('refresh').onclick = load
  A('new-table').onclick = () => openTabs.openDesign(tab.connId, tab.db)
  R('search').oninput = renderRows
  R('show-views').onchange = renderRows

  // 每次切回该页都重新加载（别处建了新表也能立刻看到）
  tab.onShow = () => {
    R('search').value = ''
    load()
  }

  load()
}
