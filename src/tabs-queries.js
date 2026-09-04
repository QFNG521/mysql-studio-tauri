import { api } from './api.js'
import { toast, escapeHtml, showContextMenu, confirmBox, promptBox } from './ui.js'
import { openTabs } from './main.js'
import { copyText } from './tree.js'
import { highlightSqlToHtml } from './sql-highlight.js'

function fmtTime(sec) {
  if (!sec) return '—'
  const d = new Date(sec * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 保存的查询列表页：新建 / 打开 / 重命名 / 删除
 */
export function renderQueriesTab(panel, tab) {
  const st = (tab.state = { queries: [], loading: false })

  panel.innerHTML = `
    <div class="list-panel">
      <div class="list-toolbar">
        <button class="btn btn-sm btn-primary" data-act="new">＋ 新建查询</button>
        <span class="tb-sep"></span>
        <button class="btn btn-sm" data-act="refresh">⟳ 刷新</button>
        <span class="tb-sep"></span>
        <span class="tb-label" data-ref="db-label"></span>
        <span class="tb-sep"></span>
        <input class="list-search" data-ref="search" placeholder="筛选名称 / SQL…" spellcheck="false"/>
        <span class="spacer" style="flex:1"></span>
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
      st.queries = await api.listSavedQueries(tab.connId, tab.db)
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
    if (!q) return st.queries
    return st.queries.filter(
      (x) => x.name.toLowerCase().includes(q) || (x.sql || '').toLowerCase().includes(q),
    )
  }

  function renderRows() {
    const list = visible()
    const rows = list
      .map((q) => {
        const preview = (q.sql || '').replace(/\s+/g, ' ').trim()
        return `<tr data-id="${escapeHtml(q.id)}">
          <td class="c-icon">✎</td>
          <td class="c-name"><b>${escapeHtml(q.name)}</b></td>
          <td class="c-sql"><code>${highlightSqlToHtml(preview.slice(0, 300)) || '<span class="muted">（空）</span>'}</code></td>
          <td class="c-time">${escapeHtml(fmtTime(q.updated_at))}</td>
        </tr>`
      })
      .join('')

    R('wrap').innerHTML = `
      <table class="list-grid q-list">
        <thead><tr>
          <th class="c-icon"></th>
          <th class="c-name">名称</th>
          <th class="c-sql">SQL</th>
          <th class="c-time">更新时间</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">还没有保存的查询，点击「＋ 新建查询」<br/><span style="font-size:11.5px">在查询页按 ⌘S 也可以保存当前语句</span></td></tr>`}</tbody>
      </table>`

    R('wrap').querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      const q = st.queries.find((x) => x.id === tr.dataset.id)
      if (!q) return
      tr.ondblclick = () => openQuery(q)
      tr.oncontextmenu = (e) => {
        e.preventDefault()
        showContextMenu(e.clientX, e.clientY, [
          { label: '打开', action: () => openQuery(q) },
          { label: '重命名', action: () => renameQuery(q) },
          '-',
          { label: '复制 SQL', action: () => copyText(q.sql || '') },
          { label: '删除', action: () => removeQuery(q) },
        ])
      }
    })

    R('info').innerHTML = `共 <b>${st.queries.length}</b> 条保存的查询`
  }

  function openQuery(q) {
    openTabs.openQuery(tab.connId, tab.db, q.sql || '', q)
  }

  async function renameQuery(q) {
    const name = await promptBox('重命名查询', q.name)
    if (name == null) return
    if (!name.trim()) { toast('名称不能为空', 'error'); return }
    try {
      await api.saveQuery({ ...q, name: name.trim() })
      toast('已重命名', 'ok')
      load()
    } catch (e) {
      toast(String(e), 'error', 5000)
    }
  }

  async function removeQuery(q) {
    const { ok } = await confirmBox('删除查询', `确定删除保存的查询 <b>${escapeHtml(q.name)}</b> 吗？此操作不可恢复。`, {
      danger: true,
      okText: '删除',
    })
    if (!ok) return
    try {
      await api.deleteQuery(q.id)
      toast('已删除', 'ok')
      load()
    } catch (e) {
      toast(String(e), 'error', 5000)
    }
  }

  A('refresh').onclick = load
  R('search').oninput = renderRows
  A('new').onclick = () => openTabs.openQuery(tab.connId, tab.db, '')

  // 每次切回该页都重新加载（在查询页保存后回来能立刻看到新记录）
  tab.onShow = () => {
    R('search').value = ''
    load()
  }

  load()
}

