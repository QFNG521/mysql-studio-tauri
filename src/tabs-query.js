import { api } from './api.js'
import { store } from './store.js'
import { toast, escapeHtml, promptBox, showContextMenu } from './ui.js'
import { renderReadonlyTable } from './grid.js'
import { highlightSqlToHtml } from './sql-highlight.js'
import { formatSql, simplifySql, statementAt } from './sql-format.js'
import { save, open } from '@tauri-apps/plugin-dialog'

import { createSqlViewer, setDoc } from './sql-view.js'
import { copyText } from './tree.js'
import { openTabs } from './main.js'

/** 取文件名（Windows 路径同样适用） */
function fileName(p) {
  return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
}

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
        <button class="btn btn-sm" data-act="file" title="打开 / 保存 SQL 文件、在文件管理器中显示">文件 ▾</button>
        <button class="btn btn-sm" data-act="export">导出结果</button>
        <button class="btn btn-sm" data-act="history">历史 ▾</button>
        <button class="btn btn-sm" data-act="results-toggle" title="显示/隐藏查询结果区">结果 ▾</button>
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
  // 从 SQL 文件打开的标签页：标题栏 tooltip 显示完整路径
  if (tab.filePath) tab.btn.title = tab.filePath

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
    onChange: (text) => { tab.sql = text; tab.dirty = true; updateTabLabel() },
    extraKeymap: [
      { key: 'Mod-Enter', run: () => { A('run').click(); return true } },
      { key: 'Shift-Enter', run: () => { A('run').click(); return true } },
      // ⌘S 保存为命名查询
      { key: 'Mod-s', run: () => { A('save').click(); return true } },
      // ⌘O 打开外部 SQL 文件 / ⌘⇧S 保存为 SQL 文件
      { key: 'Mod-o', run: () => { openSqlFile(); return true } },
      { key: 'Mod-Shift-s', run: () => { saveSqlFile({ saveAs: false }); return true } },
    ],
  })
  tab.sql = initialSql
  // 供标签页复用时读写内容（重复打开同一保存查询 / 同一文件时）
  tab.setSql = (text) => {
    setDoc(view, text ?? '')
    tab.sql = text ?? ''
    tab.dirty = false
    updateTabLabel()
  }
  tab.getSql = () => view.state.doc.toString()
  // 供批量关闭前判断 / 触发保存
  tab.isDirty = () => !!tab.dirty && !!view.state.doc.toString().trim()
  tab.saveNow = () => saveQuery()
  setTimeout(() => view.focus(), 60)

  // 选中内容时按钮提示变为「执行选中」，让「只跑选区」这件事可见
  const RUN_LABEL = '<span style="opacity:0.7;font-size:10px">⌘⏎</span>'
  function selectedRange() {
    const { from, to } = view.state.selection.main
    return from === to ? null : { from, to }
  }
  function refreshRunLabel() {
    const b = A('run')
    if (!b) return
    b.innerHTML = (selectedRange() ? '▶ 执行选中 ' : '▶ 执行 ') + RUN_LABEL
  }
  ;['mouseup', 'keyup', 'focus', 'select'].forEach((ev) =>
    view.dom.addEventListener(ev, () => setTimeout(refreshRunLabel, 0)))
  refreshRunLabel()

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

  // ---- 执行（有选区时只执行选区，无选区执行整篇） ----
  async function run() {
    const sel = selectedRange()
    const sqlText = sel ? view.state.doc.sliceString(sel.from, sel.to) : view.state.doc.toString()
    if (!sqlText.trim()) return
    const maxRows = parseInt(R('maxrows').value)
    A('run').disabled = true
    A('run').innerHTML = '执行中…'
    const scopeTip = sel ? ' · 仅选中部分' : ''
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
        : `完成 · ${results.length} 条语句 · <b>${totalMs}</b> ms${scopeTip}`
      setStatusText(hasErr ? 'SQL 执行出错' : `SQL 执行完成（${results.length} 条）${scopeTip}`)
    } catch (e) {
      toast(String(e), 'error', 5000)
      R('elapsed').textContent = '执行失败'
    } finally {
      A('run').disabled = false
      refreshRunLabel()
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
  /** 标签标题：未保存时后面跟一个 *；有关联文件时 tooltip 显示完整路径 */
  function updateTabLabel() {
    const base = String(
      tab.savedQuery?.name || (tab.filePath ? fileName(tab.filePath) : tab.title) || '查询',
    ).replace(/\s*\*$/, '')
    tab.title = base
    tab.btn.querySelector('.tab-label').textContent = base + (tab.dirty ? ' *' : '')
    tab.btn.title = tab.filePath || [base, tab.db].filter(Boolean).join(' · ')
  }

  function refreshSavedLabel() {
    const parts = []
    if (tab.savedQuery) parts.push(`📌 ${tab.savedQuery.name}`)
    if (tab.filePath) parts.push(`💾 ${fileName(tab.filePath)}`)
    R('saved').textContent = parts.join('   ')
    R('saved').title = tab.filePath ? tab.filePath : ''
  }
  refreshSavedLabel()
  updateTabLabel()

  // ---- SQL 文件：打开 / 保存 / 在文件管理器中显示 ----
  const SQL_FILTERS = [
    { name: 'SQL 脚本', extensions: ['sql'] },
    { name: '文本文件', extensions: ['txt'] },
    { name: '所有文件', extensions: ['*'] },
  ]

  /** 把文件内容载入当前标签页并关联文件路径 */
  function attachFile(path, text) {
    setDoc(view, text)
    tab.sql = text
    tab.filePath = path
    const name = fileName(path)
    if (!tab.savedQuery) {
      tab.title = name
      tab.btn.querySelector('.tab-label').textContent = name
    }
    tab.btn.title = path
    tab.dirty = false
    refreshSavedLabel()
    updateTabLabel()
  }

  /** 打开其他软件保存的 .sql 文件（自动识别 UTF-8 / UTF-16 / GBK 编码） */
  async function openSqlFile() {
    let picked
    try {
      picked = await open({
        title: '打开 SQL 文件',
        multiple: false,
        directory: false,
        filters: SQL_FILTERS,
      })
    } catch (e) {
      // 不吞异常：对话框打不开时要有提示，否则表现为「点了没反应」
      toast(`打开文件对话框失败：${e}`, 'error', 6000)
      return
    }
    if (!picked) return
    const path = Array.isArray(picked) ? picked[0] : picked
    if (!path) return

    // 该文件已经在别的标签页打开过 → 直接聚焦，不再重复开
    const exist = openTabs.findQueryByFile(path)
    if (exist && exist.id !== tab.id) {
      openTabs.focusTab(exist.id)
      toast('该 SQL 文件已在其他标签页中打开')
      return
    }
    let text
    try {
      text = await api.readSqlFile(path)
    } catch (e) {
      toast(String(e), 'error', 5000)
      return
    }
    // 当前页是空白查询 → 就地载入；否则新开一个标签页
    const cur = view.state.doc.toString()
    if (!cur.trim() && !tab.savedQuery && !tab.filePath) {
      attachFile(path, text)
    } else {
      openTabs.openQueryFile(tab.connId, currentDb() || tab.db, path, text)
    }
    toast(`已打开 ${fileName(path)}`, 'ok')
  }

  /** 保存为 .sql 文件；saveAs=true 时总是弹框另选位置 */
  async function saveSqlFile({ saveAs = false } = {}) {
    const text = view.state.doc.toString()
    if (!text.trim()) { toast('没有可保存的 SQL', 'error'); return }
    let path = tab.filePath
    if (!path || saveAs) {
      const suggested = `${(tab.savedQuery?.name || tab.title || 'query').replace(/\.sql$/i, '')}.sql`
      try {
        path = await save({
          title: saveAs ? 'SQL 文件另存为' : '保存为 SQL 文件',
          defaultPath: suggested,
          filters: [{ name: 'SQL 脚本', extensions: ['sql'] }],
        })
      } catch (e) {
        toast(`打开保存对话框失败：${e}`, 'error', 6000)
        return
      }
      if (!path) return
    }
    try {
      await api.writeSqlFile(path, text)
    } catch (e) {
      toast(String(e), 'error', 5000)
      return
    }
    tab.filePath = path
    tab.btn.title = path
    if (!tab.savedQuery) tab.title = fileName(path)
    tab.dirty = false
    refreshSavedLabel()
    updateTabLabel()
    toast(`已保存到 ${path}`, 'ok')
  }

  /** 在 Finder / 资源管理器中显示当前 SQL 文件 */
  async function revealSqlFile() {
    if (!tab.filePath) {
      toast('当前查询还没有关联 SQL 文件，请先「另存为 SQL 文件」', 'error', 3600)
      return
    }
    try {
      await api.revealPath(tab.filePath)
    } catch (e) {
      toast(String(e), 'error', 4500)
    }
  }

  A('file').onclick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    showContextMenu(rect.left, rect.bottom + 4, [
      { label: '📂 打开 SQL 文件…  ⌘O', action: () => openSqlFile() },
      {
        label: tab.filePath ? `💾 保存 SQL 文件  ⌘⇧S（${fileName(tab.filePath)}）` : '💾 保存为 SQL 文件…  ⌘⇧S',
        action: () => saveSqlFile({ saveAs: false }),
      },
      { label: '📄 SQL 文件另存为…', action: () => saveSqlFile({ saveAs: true }) },
      {
        label: tab.filePath ? '📍 在文件管理器中显示' : '📍 在文件管理器中显示（需先保存为文件）',
        disabled: !tab.filePath,
        action: () => revealSqlFile(),
      },
    ])
  }

  /** @returns {boolean} 是否保存成功（批量关闭时据此决定要不要关掉这个标签） */
  // ---- 编辑器右键菜单：运行 / 格式化 / 编辑 ----
  function selectCurrentStatement() {
    const pos = view.state.selection.main.head
    const st = statementAt(view.state.doc.toString(), pos)
    if (!st) { toast('没有找到可选择的语句', 'error'); return false }
    view.dispatch({ selection: { anchor: st.start, head: st.end }, scrollIntoView: true })
    view.focus()
    return true
  }

  function clearSelection() {
    const head = view.state.selection.main.head
    view.dispatch({ selection: { anchor: head, head } })
  }

  function replaceRange(from, to, text) {
    view.dispatch({ changes: { from, to, insert: text } })
    view.focus()
  }

  /** 对选区（无选区则整篇）做文本变换：美化 / 简化 */
  function transformDoc(fn, okMsg) {
    const sel = selectedRange()
    const src = sel ? view.state.doc.sliceString(sel.from, sel.to) : view.state.doc.toString()
    if (!src.trim()) { toast('没有可处理的内容', 'error'); return }
    const out = fn(src)
    if (out === src) { toast('内容没有变化', 'ok', 1500); return }
    if (sel) replaceRange(sel.from, sel.to, out)
    else replaceRange(0, view.state.doc.length, out)
    toast(okMsg, 'ok', 1600)
  }

  async function pasteFromClipboard() {
    let txt = ''
    try {
      txt = await navigator.clipboard.readText()
    } catch {
      toast('读取剪贴板失败，请用 ⌘V 粘贴', 'error', 3600)
      return
    }
    if (!txt) return
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: txt }, selection: { anchor: from + txt.length } })
    view.focus()
  }

  view.dom.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const sel = selectedRange()
    const selText = sel ? view.state.doc.sliceString(sel.from, sel.to) : ''
    showContextMenu(e.clientX, e.clientY, [
      { label: '▶ 运行已选择', disabled: !sel, action: () => run() },
      { label: '▶ 运行当前语句', action: () => { if (selectCurrentStatement()) run() } },
      { label: '▶ 运行全部', action: () => { clearSelection(); run() } },
      '-',
      { label: '选择当前语句', action: () => selectCurrentStatement() },
      '-',
      { label: '美化 SQL（格式化）', action: () => transformDoc(formatSql, '已美化') },
      { label: '简化 SQL（压缩为一行）', action: () => transformDoc(simplifySql, '已简化') },
      '-',
      {
        label: '剪切',
        disabled: !sel,
        action: () => { copyText(selText); replaceRange(sel.from, sel.to, '') },
      },
      { label: '复制', disabled: !sel, action: () => copyText(selText) },
      { label: '粘贴', action: pasteFromClipboard },
      '-',
      {
        label: '全选',
        action: () => {
          view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
          view.focus()
        },
      },
    ])
  })

  /** @returns {boolean} 是否保存成功（批量关闭时据此决定要不要关掉这个标签） */
  async function saveQuery({ forceNewName = false } = {}) {
    const sql = view.state.doc.toString()
    if (!sql.trim()) { toast('没有可保存的 SQL', 'error'); return false }
    let q = tab.savedQuery
      ? { ...tab.savedQuery, sql, db: currentDb() }
      : { id: '', conn_id: tab.connId, db: currentDb(), name: '', sql, created_at: 0, updated_at: 0 }

    if (!q.name || forceNewName) {
      const suggested = q.name || (tab.title && !tab.title.startsWith('查询') ? tab.title : '') ||
        sql.split('\n')[0].slice(0, 40).trim()
      const name = await promptBox(q.name ? '另存为' : '保存查询', suggested)
      if (name == null) return false
      if (!name.trim()) { toast('名称不能为空', 'error'); return false }
      q = { ...q, name: name.trim() }
      // 另存为 = 新记录
      if (forceNewName) q = { ...q, id: '' }
    }
    try {
      const saved = await api.saveQuery(q)
      tab.savedQuery = saved
      tab.title = saved.name
      tab.dirty = false
      refreshSavedLabel()
      updateTabLabel()
      toast(`已保存「${saved.name}」`, 'ok')
      return true
    } catch (e) {
      toast(String(e), 'error', 5000)
      return false
    }
  }

  A('save').onclick = () => saveQuery()
  A('saveas').onclick = () => saveQuery({ forceNewName: true })

  // ---- 导出 / 历史 / 清空 ----
  A('run').onclick = run
  A('clear').onclick = () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }) }

  A('export').onclick = () => {
    const first = lastResults.find((r) => !r.error && r.columns.length)
    if (!first) { toast('没有可导出的结果集，请先执行查询'); return }
    // 先弹菜单选格式，再进保存对话框（比系统对话框底部的小下拉直观）
    const rect = A('export').getBoundingClientRect()
    showContextMenu(rect.left, rect.bottom + 4, [
      { label: '📊 Excel 工作簿（.xlsx）', action: () => doExport('xlsx') },
      { label: '🧾 JSON 数据（.json）', action: () => doExport('json') },
      { label: '📄 CSV（.csv）', action: () => doExport('csv') },
    ])
  }

  async function doExport(fmt) {
    const first = lastResults.find((r) => !r.error && r.columns.length)
    if (!first) return
    const filter =
      fmt === 'xlsx' ? { name: 'Excel 工作簿', extensions: ['xlsx'] } :
      fmt === 'json' ? { name: 'JSON', extensions: ['json'] } :
      { name: 'CSV', extensions: ['csv'] }
    let path
    try {
      path = await save({
        title: '导出查询结果',
        defaultPath: `query-result.${fmt}`,
        filters: [filter],
      })
    } catch (e) {
      toast(`打开保存对话框失败：${e}`, 'error', 6000)
      return
    }
    if (!path) return
    try {
      // 导出完整结果（不受 max_rows 限制）——重新执行第一条 SELECT
      const args = { session: tab.connId, db: currentDb(), sql: first.sql, path }
      let n, kind
      if (fmt === 'xlsx') { n = await api.exportXlsx(args); kind = 'Excel' }
      else if (fmt === 'json') { n = await api.exportJson(args); kind = 'JSON' }
      else { n = await api.exportCsv(args); kind = 'CSV' }
      toast(`已导出 ${n} 行（${kind}）到 ${path}`, 'ok')
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
