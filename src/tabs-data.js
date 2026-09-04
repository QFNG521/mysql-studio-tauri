import { api } from './api.js'
import { store } from './store.js'
import { toast, setStatus, escapeHtml, confirmBox, showContextMenu } from './ui.js'
import { renderEditableGrid, isBlobCol, mysqlTypeNice } from './grid.js'
import { fmtNum } from './tree.js'
import { openTabs } from './main.js'
import { q, eqCond } from './sql-util.js'
import { openFilterPanel } from './filter.js'
import { save } from '@tauri-apps/plugin-dialog'

let editConfirmSkip = false

export function renderDataTab(panel, tab) {
  const st = (tab.state = {
    page: 1,
    pageSize: 200,
    whereSql: tab.whereSql || '',
    orderBy: null,
    meta: null,
    loading: false,
  })

  panel.innerHTML = `
    <div class="data-toolbar">
      <button class="btn btn-sm btn-primary" data-act="refresh">⟳ 刷新</button>
      <span class="tb-sep"></span>
      <span class="tb-label" data-ref="table-label"></span>
      <span class="tb-sep"></span>
      <button class="btn btn-sm" data-act="filter" title="可视化构建筛选条件">🔍 筛选器</button>
      <input class="where-input" data-ref="where" placeholder='筛选条件，如 age > 18 AND name LIKE "a%"' spellcheck="false" title="直接填写 WHERE 内容"/>
      <button class="btn btn-sm" data-act="apply-where">应用</button>
      <span class="tb-sep"></span>
      <span class="tb-label">每页</span>
      <select data-ref="pagesize" style="padding:3px 5px">
        <option>50</option><option>100</option><option selected>200</option>
        <option>500</option><option>1000</option><option>2000</option>
      </select>
      <span class="tb-sep"></span>
      <button class="btn btn-sm" data-act="first" title="第一页">⏮</button>
      <button class="btn btn-sm" data-act="prev" title="上一页">◀</button>
      <span class="tb-label">第 <input class="page-input" data-ref="page-input" value="1"/> / <span data-ref="page-total">?</span> 页</span>
      <button class="btn btn-sm" data-act="next" title="下一页">▶</button>
      <button class="btn btn-sm" data-act="last" title="最后一页">⏭</button>
    </div>
    <div class="grid-wrap" data-ref="grid"></div>
    <div class="data-footer">
      <button class="btn btn-sm" data-act="insert">＋ 行</button>
      <button class="btn btn-sm" data-act="delete">－ 删除选中</button>
      <span class="tb-sep"></span>
      <button class="btn btn-sm" data-act="export">导出 CSV</button>
      <button class="btn btn-sm" data-act="export-sql" title="导出为 SQL INSERT 脚本，可直接在其他库执行">导出 SQL</button>
      <span class="tb-sep"></span>
      <label class="chk"><input type="checkbox" data-ref="confirm-edit" checked/> 编辑前确认</label>
      <span class="spacer"></span>
      <span data-ref="footer-info">加载中…</span>
    </div>`

  const R = (name) => panel.querySelector(`[data-ref="${name}"]`)
  const A = (name) => panel.querySelector(`[data-act="${name}"]`)
  R('table-label').innerHTML = `<b>${escapeHtml(tab.db)}</b> . <b>${escapeHtml(tab.table)}</b>`
  R('pagesize').value = String(st.pageSize)
  R('where').value = st.whereSql

  // 供外部（如外键跳转）直接改筛选条件并刷新
  tab.applyWhere = (w) => {
    st.whereSql = w
    R('where').value = w
    st.page = 1
    loadData()
  }

  async function loadMeta(force = false) {
    if (!st.meta || force) {
      try {
        st.meta = await api.getTableMeta(tab.connId, tab.db, tab.table)
        st.pkColumns = st.meta.pk_columns
      } catch (e) {
        toast(String(e), 'error', 5000)
      }
    }
    return st.meta
  }

  async function loadData() {
    if (st.loading) return
    st.loading = true
    R('footer-info').textContent = '加载中…'
    try {
      const res = await api.fetchRows({
        session: tab.connId, db: tab.db, table: tab.table,
        page: st.page, pageSize: st.pageSize,
        orderBy: st.orderBy ? [st.orderBy] : null,
        whereSql: st.whereSql || null,
      })
      st.columns = res.columns
      st.rows = res.rows
      st.total = res.total
      renderGrid()
      const totalPages = Math.max(1, Math.ceil(res.total / st.pageSize))
      R('page-total').textContent = totalPages
      R('page-input').value = st.page
      R('footer-info').innerHTML =
        `共 <b>${fmtNum(res.total)}</b> 行 · 本页 <b>${res.rows.length}</b> 行 · 耗时 <b>${res.elapsed_ms}</b> ms` +
        (st.pkColumns?.length ? '' : ' · <span style="color:var(--warn)">表无主键，只读</span>')
    } catch (e) {
      R('grid').innerHTML = `<div class="grid-empty" style="color:var(--danger)">${escapeHtml(String(e))}</div>`
      R('footer-info').textContent = '加载失败'
    } finally {
      st.loading = false
    }
  }

  function renderGrid() {
    const editable = (st.pkColumns?.length || 0) > 0
    st.grid = renderEditableGrid(R('grid'), {
      columns: st.columns,
      rows: st.rows,
      pkColumns: st.pkColumns || [],
      sortState: st.orderBy ? { idx: st.columns.findIndex((c) => c.name === st.orderBy.column), dir: st.orderBy.dir } : null,
      onSort: (col) => {
        st.orderBy = col
        st.page = 1
        loadData()
      },
      editable,
      onEdit: async (ri, ci, oldVal, newVal) => {
        const col = st.columns[ci]
        if (!R('confirm-edit').checked || editConfirmSkip) {
          return doUpdate(ri, ci, newVal)
        }
        const from = oldVal === null ? 'NULL' : oldVal
        const to = newVal === null ? 'NULL' : newVal
        const { ok, skip } = await confirmBox(
          '确认修改',
          `<div>修改 <code>${escapeHtml(tab.table)}</code> 该行的 <code>${escapeHtml(col.name)}</code>：</div>
           <div class="sql-preview">${escapeHtml(from)}  →  ${escapeHtml(to)}</div>`,
          { okText: '执行 UPDATE' },
        )
        if (skip) editConfirmSkip = true
        if (!ok) throw new Error('cancelled')
        return doUpdate(ri, ci, newVal)
      },
      onCellContextMenu: (ri, ci, e, v) => showCellMenu(ri, ci, e, v),
    })
  }

  // ---------- 单元格右键菜单（外键跳转等） ----------
  const colIndexOf = (name) => st.columns.findIndex((c) => c.name === name || c.org_name === name)

  /** 按约束名分组，同一约束的多列合成 AND 条件 */
  function groupFks(list, keyFn) {
    const m = new Map()
    for (const fk of list || []) {
      const k = keyFn(fk)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(fk)
    }
    return [...m.values()]
  }

  function showCellMenu(ri, ci, e, v) {
    const col = st.columns[ci]
    const colName = col.org_name || col.name
    const items = []

    // 本列属于外键 → 跳到父表对应记录
    for (const grp of groupFks(st.meta?.foreign_keys, (f) => f.name)) {
      if (!grp.some((f) => f.column === colName)) continue
      const cond = grp.map((f) => eqCond(f.ref_column, st.rows[ri][colIndexOf(f.column)])).join(' AND ')
      const f = grp[0]
      const target = f.ref_db === tab.db ? f.ref_table : `${f.ref_db}.${f.ref_table}`
      items.push({
        label: `查看父表 ${target} 中这条记录`,
        action: () => openTabs.openData(tab.connId, f.ref_db, f.ref_table, cond),
      })
    }

    // 本列被别的表引用 → 跳到子表的关联记录
    for (const grp of groupFks(st.meta?.referenced_by, (f) => `${f.ref_db}.${f.ref_table}.${f.name}`)) {
      if (!grp.some((f) => f.ref_column === colName)) continue
      const cond = grp.map((f) => eqCond(f.column, st.rows[ri][colIndexOf(f.ref_column)])).join(' AND ')
      const f = grp[0]
      const target = f.ref_db === tab.db ? f.ref_table : `${f.ref_db}.${f.ref_table}`
      items.push({
        label: `查看子表 ${target} 中的关联记录`,
        action: () => openTabs.openData(tab.connId, f.ref_db, f.ref_table, cond),
      })
    }

    if (items.length) items.push('-')
    items.push(
      {
        label: '仅显示该值',
        action: () => { tab.applyWhere(eqCond(colName, v)); toast(`已筛选 ${colName} = ${v}`) },
      },
      { label: '复制值', action: () => copyText(v ?? '') },
      { label: '复制列名', action: () => copyText(colName) },
    )

    showContextMenu(e.clientX, e.clientY, items)
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      toast('已复制', 'ok', 1200)
    } catch {
      // file:// 下 navigator.clipboard 可能不可用，退回 execCommand
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

  async function doUpdate(ri, ci, newVal) {
    const col = st.columns[ci]
    const row = st.rows[ri]
    const pkVals = (st.pkColumns || []).map((pkName) => {
      const idx = st.columns.findIndex((c) => c.name === pkName || c.org_name === pkName)
      return { column: pkName, value: idx >= 0 ? row[idx] : null }
    })
    if (!pkVals.length) throw new Error('无法定位主键')
    await api.updateCell({
      session: tab.connId, db: tab.db, table: tab.table,
      pkVals, column: col.name, value: newVal,
    })
    // 本地同步
    row[ci] = newVal
    setStatus(`已更新 ${tab.table}.${col.name}`)
  }

  async function renderInsertRow() {
    if (!st.pkColumns?.length) { toast('表无主键，请用 SQL 插入', 'error'); return }
    const table = R('grid').querySelector('table')
    if (!table) return
    if (table.querySelector('tr.insert-row')) { toast('已有待插入行，请先保存或取消'); return }
    const tr = document.createElement('tr')
    tr.className = 'insert-row'
    tr.innerHTML = `<td class="rowhead">
        <button class="btn btn-sm btn-primary" data-act="save-insert">存</button>
        <button class="btn btn-sm" data-act="cancel-insert">✕</button>
      </td>` +
      st.columns
        .map((c, i) => {
          const auto = st.meta?.columns.find((x) => x.name === c.name)?.is_auto_inc
          return `<td class="cell" data-ci="${i}">${
            auto
              ? '<span class="cell-text" style="color:#b0b6bf;font-style:italic">自增</span>'
              : `<input class="cell-editor" style="border:1px dashed var(--border-strong)" placeholder="NULL"/>`
          }</td>`
        })
        .join('')
    table.querySelector('tbody').appendChild(tr)
    tr.scrollIntoView({ block: 'nearest' })

    tr.querySelector('[data-act="cancel-insert"]').onclick = () => tr.remove()
    tr.querySelector('[data-act="save-insert"]').onclick = async () => {
      const values = {}
      st.columns.forEach((c, i) => {
        const td = tr.querySelector(`td[data-ci="${i}"]`)
        const input = td.querySelector('input')
        if (!input) return // 自增列
        const v = input.value
        if (v === '') return // 空串跳过该列（用默认值）
        values[c.name] = v === '\x00NULL' ? null : v
      })
      if (!Object.keys(values).length) { toast('请至少填写一列（留空 = 使用默认值）'); return }
      try {
        await api.insertRow({ session: tab.connId, db: tab.db, table: tab.table, values })
        toast('插入成功', 'ok')
        loadData()
      } catch (e) {
        toast(String(e), 'error', 5000)
      }
    }
    tr.querySelector('input')?.focus()
  }

  async function deleteSelected() {
    const idxs = st.grid?.getSelectedRowIdxs() || []
    if (!idxs.length) { toast('请先勾选要删除的行'); return }
    if (!st.pkColumns?.length) { toast('表无主键，无法安全删除，请使用 SQL', 'error'); return }
    const keys = idxs.map((ri) =>
      st.pkColumns.map((pkName) => {
        const idx = st.columns.findIndex((c) => c.name === pkName || c.org_name === pkName)
        return { column: pkName, value: st.rows[ri][idx] }
      }),
    )
    const { ok } = await confirmBox(
      '删除确认',
      `将从 <code>${escapeHtml(tab.table)}</code> 中删除 <b>${keys.length}</b> 行，且不可恢复！`,
      { danger: true, okText: '删除' },
    )
    if (!ok) return
    try {
      const n = await api.deleteRows({ session: tab.connId, db: tab.db, table: tab.table, keys })
      toast(`已删除 ${n} 行`, 'ok')
      st.grid.clearSelection()
      loadData()
    } catch (e) {
      toast(String(e), 'error', 5000)
    }
  }

  async function exportCsv() {
    const path = await save({
      title: '导出 CSV',
      defaultPath: `${tab.table}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (!path) return
    try {
      const sql = `SELECT * FROM \`${tab.db.replace(/`/g, '``')}\`.\`${tab.table.replace(/`/g, '``')}\`` +
        (st.whereSql ? ` WHERE ${st.whereSql}` : '')
      const n = await api.exportCsv({ session: tab.connId, db: tab.db, sql, path })
      toast(`已导出 ${n} 行到 ${path}`, 'ok')
    } catch (e) {
      toast(String(e), 'error', 6000)
    }
  }

  /** 导出当前筛选下的数据为 INSERT 脚本（无筛选则导全表） */
  async function exportInserts() {
    const path = await save({
      title: '导出 SQL INSERT',
      defaultPath: `${tab.table}.sql`,
      filters: [{ name: 'SQL', extensions: ['sql'] }],
    })
    if (!path) return
    try {
      const n = await api.exportInserts({
        session: tab.connId, db: tab.db, table: tab.table, path,
        whereSql: st.whereSql || '',
      })
      toast(`已导出 ${n} 行 INSERT 到 ${path}`, 'ok')
    } catch (e) {
      toast(String(e), 'error', 6000)
    }
  }

  // 工具栏事件
  A('refresh').onclick = () => { loadMeta(true).then(loadData) }
  A('apply-where').onclick = () => { st.whereSql = R('where').value.trim(); st.page = 1; loadData() }
  A('filter').onclick = async () => {
    await loadMeta()
    const cols = st.meta?.columns?.length
      ? st.meta.columns.map((c) => ({ name: c.name }))
      : (st.columns || []).map((c) => ({ name: c.org_name || c.name }))
    if (!cols.length) { toast('列信息尚未加载', 'error'); return }
    openFilterPanel(A('filter'), cols, st.filterConds, (sql, conds) => {
      st.filterConds = conds
      st.whereSql = sql
      R('where').value = sql
      st.page = 1
      loadData()
    })
  }
  R('where').onkeydown = (e) => { if (e.key === 'Enter') A('apply-where').click() }
  R('pagesize').onchange = () => { st.pageSize = parseInt(R('pagesize').value); st.page = 1; loadData() }
  A('first').onclick = () => { st.page = 1; loadData() }
  A('prev').onclick = () => { if (st.page > 1) { st.page--; loadData() } }
  A('next').onclick = () => { if (st.page * st.pageSize < st.total) { st.page++; loadData() } }
  A('last').onclick = () => { st.page = Math.max(1, Math.ceil((st.total || 0) / st.pageSize)); loadData() }
  R('page-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const p = parseInt(R('page-input').value)
      if (p >= 1) { st.page = p; loadData() }
    }
  }
  A('insert').onclick = renderInsertRow
  A('delete').onclick = deleteSelected
  A('export').onclick = exportCsv
  A('export-sql').onclick = exportInserts

  // 首次加载
  loadMeta().then(loadData)
}
