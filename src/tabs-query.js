import { api } from './api.js'
import { store } from './store.js'
import { toast, escapeHtml, promptBox, showContextMenu } from './ui.js'
import { renderReadonlyTable } from './grid.js'
import { highlightSqlToHtml } from './sql-highlight.js'
import { save } from '@tauri-apps/plugin-dialog'

import { EditorView, keymap } from '@codemirror/view'
import { baseExtensions, createSqlViewer } from './sql-view.js'
import { copyText } from './tree.js'

const HIST_KEY = 'mysql-studio-query-history'

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)) || [] } catch { return [] }
}
function pushHistory(sqlText) {
  if (!sqlText.trim()) return
  let h = getHistory().filter((s) => s !== sqlText)
  h.unshift(sqlText)
  h = h.slice(0, 50)
  localStorage.setItem(HIST_KEY, JSON.stringify(h))
}

export function renderQueryTab(panel, tab, initialSql = '') {
  panel.innerHTML = `
    <div class="query-panel">
      <div class="query-toolbar">
        <button class="btn btn-sm btn-primary" data-act="run">▶ 执行 <span style="opacity:0.7;font-size:10px">⌘⏎</span></button>
        <span class="tb-sep"></span>
        <span class="tb-label">库</span>
        <select data-ref="db" style="padding:3px 6px;max-width:180px"></select>
        <span class="tb-sep"></span>
        <span class="tb-label">上限</span>
        <select data-ref="maxrows" style="padding:3px 5px">
          <option>100</option><option selected>500</option><option>1000</option>
          <option>5000</option><option>50000</option>
        </select>
        <span class="tb-sep"></span>
        <button class="btn btn-sm" data-act="save">保存 <span style="opacity:0.7;font-size:10px">⌘S</span></button>
        <button class="btn btn-sm" data-act="saveas">另存为</button>
        <button class="btn btn-sm" data-act="export">导出结果</button>
        <button class="btn btn-sm" data-act="history">历史 ▾</button>
        <button class="btn btn-sm" data-act="clear">清空</button>
        <span class="spacer" style="flex:1"></span>
        <span class="tb-label" data-ref="saved" title="已保存的查询名称"></span>
        <span class="tb-label" data-ref="elapsed"></span>
      </div>
      <div class="cm-editor-wrap" data-ref="editor"></div>
      <div class="query-splitter" data-ref="splitter" title="拖动调整编辑器高度 · 双击复位"></div>
      <div class="query-results" data-ref="results"></div>
    </div>`

  const R = (n) => panel.querySelector(`[data-ref="${n}"]`)
  const A = (n) => panel.querySelector(`[data-act="${n}"]`)
  let lastResults = []

  // ---- 库选择 ----
  const dbSel = R('db')
  const session = store.sessions.get(tab.connId)
  const dbs = session?.databases || []
  dbSel.innerHTML = dbs
    .map((d) => `<option value="${escapeHtml(d.name)}" ${d.name === tab.db ? 'selected' : ''}>${escapeHtml(d.name)}</option>`)
    .join('')
  if (!dbs.find((d) => d.name === tab.db) && tab.db) {
    dbSel.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(tab.db)}" selected>${escapeHtml(tab.db)}</option>`)
  }
  const currentDb = () => dbSel.value || ''

  // ---- CodeMirror ----
  const schemaTables = getSchemaTables(tab)
  const view = createSqlViewer(R('editor'), {
    doc: initialSql,
    schema: schemaTables.schema,
    onChange: (text) => { tab.sql = text },
    extraKeymap: [
      { key: 'Mod-Enter', run: () => { A('run').click(); return true } },
      { key: 'Shift-Enter', run: () => { A('run').click(); return true } },
      // ⌘S 保存为命名查询
      { key: 'Mod-s', run: () => { A('save').click(); return true } },
    ],
  })
  tab.sql = initialSql
  setTimeout(() => view.focus(), 60)

  // ---- 编辑器/结果区分隔条：拖动调高（按百分比记忆）、双击复位、结果区可整体隐藏 ----
  const editorWrap = R('editor')
  const splitter = R('splitter')
  const qpanel = panel.querySelector('.query-panel')
  const SPLIT_KEY = 'mysql-studio-query-editor-h'
  const savedPct = parseFloat(localStorage.getItem(SPLIT_KEY))
  if (savedPct > 5 && savedPct < 95) editorWrap.style.height = savedPct + '%'

  let drag = null
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault()
    drag = { startY: e.clientY, startH: editorWrap.getBoundingClientRect().height }
    splitter.classList.add('dragging')
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  })
  document.addEventListener('mousemove', (e) => {
    if (!drag) return
    // 上限：至少给结果区留 60px
    const maxH = panel.clientHeight - 40 - 6 - 60
    const h = Math.min(Math.max(drag.startH + e.clientY - drag.startY, 80), maxH)
    editorWrap.style.height = h + 'px'
  })
  document.addEventListener('mouseup', () => {
    if (!drag) return
    drag = null
    splitter.classList.remove('dragging')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    // 存百分比：窗口缩放/最大化后比例保持，始终充满
    const pctNew = (editorWrap.getBoundingClientRect().height / panel.clientHeight) * 100
    editorWrap.style.height = pctNew.toFixed(2) + '%'
    localStorage.setItem(SPLIT_KEY, pctNew.toFixed(2))
  })
  splitter.addEventListener('dblclick', () => {
    editorWrap.style.height = '38%'
    localStorage.removeItem(SPLIT_KEY)
  })

  A('results-toggle').onclick = () => {
    const hidden = qpanel.classList.toggle('results-hidden')
    A('results-toggle').textContent = hidden ? '结果 ▴' : '结果 ▾'
    if (!hidden) view.requestMeasure()
  }

  // ---- 执行 ----
  async function run() {
    const sqlText = view.state.doc.toString()
    if (!sqlText.trim()) return
    const maxRows = parseInt(R('maxrows').value)
    A('run').disabled = true
    R('elapsed').textContent = '执行中…'
    try {
      const results = await api.executeSql({
        session: tab.connId, db: currentDb(), sql: sqlText, maxRows,
      })
      lastResults = results
      pushHistory(sqlText)
      renderResults(results)
      const totalMs = results.reduce((s, r) => s + r.elapsed_ms, 0)
      const hasErr = results.some((r) => r.error)
      R('elapsed').innerHTML = hasErr
        ? `<span style="color:var(--danger)">执行出错</span>`
        : `完成 · ${results.length} 条语句 · <b>${totalMs}</b> ms`
      setStatusText(hasErr ? 'SQL 执行出错' : `SQL 执行完成（${results.length} 条）`)
    } catch (e) {
      toast(String(e), 'error', 5000)
      R('elapsed').textContent = '执行失败'
    } finally {
      A('run').disabled = false
    }
  }

  function setStatusText(t) {
    document.getElementById('status-text').textContent = t
  }

  function renderResults(results) {
    const box = R('results')
    box.innerHTML = ''
    results.forEach((r, i) => {
      const block = document.createElement('div')
      block.className = 'result-block'
      const status = r.error
        ? '<span class="err">✕ 错误</span>'
        : `<span class="ok">✓ 成功</span> · ${r.columns.length ? `返回 <b>${r.rows.length}</b> 行${r.truncated ? '(截断)' : ''}` : `影响 <b>${r.affected}</b> 行`}${r.last_insert_id ? ` · 自增ID ${r.last_insert_id}` : ''}`
      const sqlPreview = (r.sql || '').replace(/\s+/g, ' ').trim()
      block.innerHTML = `<div class="result-head">
          <span class="tb-label">#${i + 1}</span>
          <span class="rsql" title="${escapeHtml(r.sql)}"><code>${highlightSqlToHtml(sqlPreview.slice(0, 240))}</code></span>
          <span>${status}</span>
          <span style="margin-left:auto"><b>${r.elapsed_ms}</b> ms</span>
        </div>` +
        (r.error
          ? `<div class="result-error">${escapeHtml(r.error)}</div>`
          : `<div class="result-grid-wrap" data-ri="${i}"></div>`)
      box.appendChild(block)
      if (!r.error) {
        const gridWrap = block.querySelector('.result-grid-wrap')
        renderReadonlyTable(gridWrap, r.columns, r.rows, r.truncated)
        bindResultContextMenu(gridWrap, r)
      }
    })
  }

  /** 查询结果单元格右键：复制值 / 复制行 TSV / 复制列名 */
  function bindResultContextMenu(wrap, r) {
    wrap.querySelectorAll('tbody tr').forEach((tr) => {
      tr.oncontextmenu = (e) => {
        e.preventDefault()
        const ci = [...tr.children].indexOf(e.target.closest('td'))
        if (ci < 0) return
        const colName = r.columns[ci]?.name ?? `#${ci + 1}`
        const rowVals = [...tr.children].map((td) => td.textContent)
        const v = rowVals[ci]
        showContextMenu(e.clientX, e.clientY, [
          { label: `复制值${v ? `（${v.slice(0, 30)}${v.length > 30 ? '…' : ''}）` : ''}`, action: () => copyText(v) },
          { label: '复制行（制表符分隔）', action: () => copyText(rowVals.join('\t')) },
          { label: `复制列名（${colName}）`, action: () => copyText(colName) },
          '-',
          { label: '复制整行为 JSON', action: () => {
            const obj = {}
            r.columns.forEach((c, i) => { obj[c.name ?? `#${i + 1}`] = rowVals[i] })
            copyText(JSON.stringify(obj, null, 2))
          } },
        ])
      }
    })
  }

  // ---- 保存查询 ----
  function refreshSavedLabel() {
    R('saved').textContent = tab.savedQuery ? `📌 ${tab.savedQuery.name}` : ''
  }
  refreshSavedLabel()

  async function saveQuery({ forceNewName = false } = {}) {
    const sql = view.state.doc.toString()
    if (!sql.trim()) { toast('没有可保存的 SQL', 'error'); return }
    let q = tab.savedQuery
      ? { ...tab.savedQuery, sql, db: currentDb() }
      : { id: '', conn_id: tab.connId, db: currentDb(), name: '', sql, created_at: 0, updated_at: 0 }

    if (!q.name || forceNewName) {
      const suggested = q.name || (tab.title && !tab.title.startsWith('查询') ? tab.title : '') ||
        sql.split('\n')[0].slice(0, 40).trim()
      const name = await promptBox(q.name ? '另存为' : '保存查询', suggested)
      if (name == null) return
      if (!name.trim()) { toast('名称不能为空', 'error'); return }
      q = { ...q, name: name.trim() }
      // 另存为 = 新记录
      if (forceNewName) q = { ...q, id: '' }
    }
    try {
      const saved = await api.saveQuery(q)
      tab.savedQuery = saved
      tab.title = saved.name
      tab.btn.querySelector('.tab-label').textContent = saved.name
      refreshSavedLabel()
      toast(`已保存「${saved.name}」`, 'ok')
    } catch (e) {
      toast(String(e), 'error', 5000)
    }
  }

  A('save').onclick = () => saveQuery()
  A('saveas').onclick = () => saveQuery({ forceNewName: true })

  // ---- 导出 / 历史 / 清空 ----
  A('run').onclick = run
  A('clear').onclick = () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }) }

  A('export').onclick = async () => {
    const first = lastResults.find((r) => !r.error && r.columns.length)
    if (!first) { toast('没有可导出的结果集，请先执行查询'); return }
    const path = await save({
      title: '导出查询结果为 CSV',
      defaultPath: 'query-result.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (!path) return
    try {
      // 导出完整结果（不受 max_rows 限制）——重新执行第一条 SELECT
      const stmt = first.sql
      const n = await api.exportCsv({ session: tab.connId, db: currentDb(), sql: stmt, path })
      toast(`已导出 ${n} 行到 ${path}`, 'ok')
    } catch (e) {
      toast(String(e), 'error', 6000)
    }
  }

  A('history').onclick = (e) => {
    const h = getHistory()
    const menu = document.createElement('div')
    menu.className = 'ctxmenu'
    menu.style.position = 'fixed'
    menu.style.maxHeight = '360px'
    menu.style.overflow = 'auto'
    menu.style.minWidth = '320px'
    const rect = e.target.getBoundingClientRect()
    menu.style.left = rect.left + 'px'
    menu.style.top = rect.bottom + 4 + 'px'
    if (!h.length) {
      menu.innerHTML = '<div class="result-msg" style="text-align:center">暂无历史</div>'
    } else {
      for (const s of h) {
        const item = document.createElement('div')
        item.className = 'ctxmenu-item'
        item.style.fontFamily = 'var(--mono)'
        item.style.fontSize = '11.5px'
        item.textContent = s.length > 80 ? s.slice(0, 80) + '…' : s
        item.title = s
        item.onclick = () => {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s } })
          menu.remove()
        }
        menu.appendChild(item)
      }
    }
    document.getElementById('ctxmenu-root').appendChild(menu)
    setTimeout(() => {
      const close = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close) }
      }
      document.addEventListener('mousedown', close)
    }, 0)
  }
}

/** 从会话缓存拼 schema（表名 -> 列），供补全 */
function getSchemaTables(tab) {
  const key = `${tab.connId}/${tab.db}`
  let schema = store.schemaCache.get(key)
  if (!schema) {
    schema = { schema: {}, tables: [] }
    store.schemaCache.set(key, schema)
  }
  if (schema.schema && Object.keys(schema.schema).length) return schema
  // 尝试从树状态拿表列表
  try {
    const dbKey = `${tab.connId}/${tab.db}`
    const st = store.treeState[dbKey]
    const tables = st?.tables || []
    schema.tables = tables.map((t) => t.name)
    schema.schema = Object.fromEntries(tables.map((t) => [t.name, []]))
  } catch { /* ignore */ }
  return schema
}

/** 刷新 schema 缓存（在数据页加载 meta 后调用可选） */
export function refreshSchemaCache(tab, tables) {
  const key = `${tab.connId}/${tab.db}`
  store.schemaCache.set(key, { schema: Object.fromEntries(tables.map((t) => [t, []])), tables })
}
