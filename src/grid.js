import { escapeHtml, confirmBox, toast } from './ui.js'
import { fmtNum } from './tree.js'

// 列 flags（mysql 协议）
const F = {
  NOT_NULL: 1, PRIMARY_KEY: 2, UNIQUE: 4, BLOB: 16,
  UNSIGNED: 32, BINARY: 128, AUTO_INC: 512,
}

export function isNumCol(col) {
  // mysql column_type: 1 tinyint 2 smallint 3 int 8 bigint 5 double 4 float 0 decimal 9/10 year 等
  const t = col.column_type
  return [0, 1, 2, 3, 4, 5, 8, 9, 13, 14].includes(t) && !(col.flags & F.BINARY)
}

export function isBlobCol(col) {
  // 仅真正的二进制列（BLOB / BINARY / VARBINARY / GEOMETRY，协议上无字符集、
  // 带 BINARY 标志）才不可作为文本编辑；varchar / char / text / enum / set / json
  // 等文本列都应可直接编辑。MySQL 中 TEXT 与 BLOB 共用类型码(252等)，需靠
  // BINARY 标志区分：TEXT 不带 BINARY 标志，BLOB 带。
  return (col.flags & F.BINARY) !== 0
}

/**
 * 渲染只读结果表格（查询结果用）
 * cols: [{name}], rows: [[str|null]]
 */
export function renderReadonlyTable(container, cols, rows, truncated) {
  if (!cols.length) {
    container.innerHTML = '<div class="result-msg">执行成功，无结果集。</div>'
    return
  }
  const numCols = new Set(cols.map((c, i) => (isNumCol(c) ? i : -1)).filter((i) => i >= 0))
  const thead = `<tr><th class="rowhead">#</th>${cols
    .map((c) => `<th><div class="th-inner"><span class="col-name">${escapeHtml(c.name)}</span></div></th>`)
    .join('')}</tr>`
  const tbody = rows
    .map((r, ri) => {
      const tds = r
        .map((v, ci) => {
          const cls = ['cell']
          if (numCols.has(ci)) cls.push('num')
          if (v === null) cls.push('null')
          else if (v.startsWith('(BLOB')) cls.push('blob')
          const text = v === null ? 'NULL' : v
          return `<td class="${cls.join(' ')}" title="${escapeAttr(text)}"><span class="cell-text">${escapeHtml(v === null ? 'NULL' : trunc(v, 200))}</span></td>`
        })
        .join('')
      return `<tr><td class="rowhead">${ri + 1}</td>${tds}</tr>`
    })
    .join('')
  container.innerHTML = `<table class="grid"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`
  if (truncated) {
    const div = document.createElement('div')
    div.className = 'result-msg'
    div.textContent = `仅显示前 ${rows.length} 行（可在工具栏调整行数上限）`
    container.appendChild(div)
  }
}

function trunc(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/\n/g, '⏎')
}

/**
 * 可编辑数据网格（数据页用）
 * opts:
 *   columns: ColMeta[]  rows: [[str|null]]
 *   pkColumns: [string]  orderBy, onSort(col,dir)
 *   editable: boolean
 *   onEdit(rowIdx, colIdx, oldValue, newValue|null(表示NULL)) -> Promise
 */
export function renderEditableGrid(container, opts) {
  const { columns, rows } = opts
  const numCols = new Set(columns.map((c, i) => (isNumCol(c) ? i : -1)).filter((i) => i >= 0))
  const blobCols = new Set(columns.map((c, i) => (isBlobCol(c) ? i : -1)).filter((i) => i >= 0))
  const pkIdx = new Set(columns.map((c, i) => (opts.pkColumns.includes(c.org_name || c.name) ? i : -1)).filter((i) => i >= 0))
  const selected = new Set()
  let sortState = opts.sortState || null // { idx, dir }

  const table = document.createElement('table')
  table.className = 'grid'
  container.innerHTML = ''
  container.appendChild(table)

  // ---------- 表头 ----------
  const thead = document.createElement('thead')
  const hr = document.createElement('tr')
  hr.innerHTML = `<th class="rowhead"><input type="checkbox" id="grid-check-all"/></th>`
  columns.forEach((c, i) => {
    const th = document.createElement('th')
    const isPk = pkIdx.has(i)
    const sorted = sortState?.idx === i
    th.innerHTML = `<div class="th-inner">
      ${isPk ? '<span class="pk-key">🔑</span>' : ''}
      <span class="col-name">${escapeHtml(c.name)}</span>
      ${sorted ? `<span class="sort-mark">${sortState.dir === 'DESC' ? '▼' : '▲'}</span>` : ''}
      <span class="col-type">${mysqlTypeNice(c.column_type)}</span>
    </div>`
    th.querySelector('.th-inner').onclick = () => {
      if (!opts.onSort) return
      let dir = 'ASC'
      if (sorted && sortState.dir === 'ASC') dir = 'DESC'
      else if (sorted) { sortState = null; opts.onSort(null); return }
      sortState = { idx: i, dir }
      opts.onSort({ column: c.name, dir })
    }
    hr.appendChild(th)
  })
  thead.appendChild(hr)
  table.appendChild(thead)

  const checkAll = hr.querySelector('#grid-check-all')
  // 注意：必须限定在本表格的 tbody 内。用 document.querySelectorAll 会把其它
  // （隐藏的）标签页里的行一起勾上，切回去就变成"莫名其妙全被选中"。
  checkAll.onchange = () => {
    selected.clear()
    tbody.querySelectorAll('tr[data-ri]').forEach((tr) => {
      tr.classList.toggle('selected', checkAll.checked)
      const cb = tr.querySelector('input[type=checkbox]')
      if (cb) cb.checked = checkAll.checked
      if (checkAll.checked) selected.add(tr.dataset.ri)
    })
  }

  // ---------- 数据行 ----------
  const tbody = document.createElement('tbody')
  table.appendChild(tbody)

  const cellClass = (v, ci) => {
    const cls = ['cell']
    if (numCols.has(ci)) cls.push('num')
    if (v === null) cls.push('null')
    else if (v.startsWith('(BLOB')) cls.push('blob')
    return cls.join(' ')
  }

  rows.forEach((r, ri) => {
    const tr = document.createElement('tr')
    tr.dataset.ri = ri
    const rowhead = document.createElement('td')
    rowhead.className = 'rowhead'
    rowhead.innerHTML = `<input type="checkbox"/>`
    rowhead.querySelector('input').onchange = (e) => {
      tr.classList.toggle('selected', e.target.checked)
      if (e.target.checked) selected.add(String(ri))
      else selected.delete(String(ri))
    }
    tr.appendChild(rowhead)

    r.forEach((v, ci) => {
      const td = document.createElement('td')
      td.className = cellClass(v, ci)
      const span = document.createElement('span')
      span.className = 'cell-text'
      span.textContent = v === null ? 'NULL' : trunc(v, 400)
      td.appendChild(span)
      td.title = v === null ? 'NULL（双击编辑）' : v
      if (opts.editable) {
        td.ondblclick = () => startEdit(td, ri, ci, v)
      } else {
        // 只读（表无主键）时双击以前完全没反应，容易让人以为卡住了
        td.ondblclick = () => toast('该表没有主键，无法安全定位到行，请用 SQL 修改', 'error', 3200)
      }
      if (opts.onCellContextMenu) {
        td.oncontextmenu = (e) => {
          e.preventDefault()
          e.stopPropagation()
          opts.onCellContextMenu(ri, ci, e, v)
        }
      }
      tr.appendChild(td)
    })
    tbody.appendChild(tr)
  })

  if (!rows.length) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td class="grid-empty" colspan="${columns.length + 1}">表中没有数据</td>`
    tbody.appendChild(tr)
  }

  // ---------- 单元格编辑 ----------
  async function startEdit(td, ri, ci, oldVal) {
    if (td.querySelector('.cell-editor')) return
    const col = columns[ci]
    if (blobCols.has(ci) && oldVal && oldVal.startsWith('(BLOB')) {
      toast('二进制列不支持在表格中编辑', 'error')
      return
    }
    td.classList.add('editing')
    const oldText = td.querySelector('.cell-text')?.textContent ?? ''
    const input = document.createElement('input')
    input.className = 'cell-editor'
    input.value = oldVal === null ? '' : oldVal
    td.innerHTML = ''
    td.appendChild(input)
    input.focus()
    input.select()

    let cancelled = false
    const finish = async (commit) => {
      if (cancelled) return
      cancelled = true
      td.classList.remove('editing')
      const nv = input.value
      const isNull = commit && input.dataset.nullMode === '1'
      // 恢复展示
      td.innerHTML = ''
      const span = document.createElement('span')
      span.className = 'cell-text'
      td.appendChild(span)
      const restore = (val) => {
        td.className = cellClass(val, ci)
        span.textContent = val === null ? 'NULL' : trunc(val, 400)
        td.title = val === null ? 'NULL（双击编辑）' : val
      }
      restore(commit ? (isNull ? null : nv) : oldVal)
      if (!commit) return
      if (!isNull && nv === oldVal) return
      try {
        await opts.onEdit(ri, ci, oldVal, isNull ? null : nv)
        restore(isNull ? null : nv)
      } catch (e) {
        restore(oldVal)
        toast(String(e), 'error', 5000)
      }
    }

    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
      else if (e.key === 'Tab') { e.preventDefault(); finish(true).then(() => focusNextCell(tbody, ri, ci, e.shiftKey ? -1 : 1)) }
    }
    input.onblur = () => finish(false)
  }

  function focusNextCell(tbody, ri, ci, delta) {
    const tr = tbody.children[ri]
    const next = tr?.children[ci + 1 + delta]
    if (next && next.classList.contains('cell')) next.dispatchEvent(new MouseEvent('dblclick'))
  }

  return {
    getSelectedRowIdxs: () => [...selected].map(Number).sort((a, b) => a - b),
    rows,
    columns,
    clearSelection: () => {
      selected.clear()
      tbody.querySelectorAll('tr.selected').forEach((tr) => {
        tr.classList.remove('selected')
        const cb = tr.querySelector('input[type=checkbox]')
        if (cb) cb.checked = false
      })
      checkAll.checked = false
    },
  }
}

export function mysqlTypeNice(t) {
  const names = {
    0: 'DECIMAL', 1: 'TINY', 2: 'SHORT', 3: 'LONG', 4: 'FLOAT', 5: 'DOUBLE',
    6: 'NULL', 7: 'TIMESTAMP', 8: 'LONGLONG', 9: 'INT24', 10: 'DATE', 11: 'TIME',
    12: 'DATETIME', 13: 'YEAR', 14: 'NEWDATE', 15: 'VARCHAR', 16: 'BIT',
    245: 'JSON', 246: 'NEWDECIMAL', 247: 'ENUM', 248: 'SET', 249: 'TINY_BLOB',
    250: 'MEDIUM_BLOB', 251: 'LONG_BLOB', 252: 'BLOB', 253: 'VAR_STRING', 254: 'STRING', 255: 'GEOMETRY',
  }
  return names[t] || String(t)
}

/** 编辑确认框 */
export async function confirmEdit({ table, column, oldValue, newValue, skipRef }) {
  const from = oldValue === null ? '<i>NULL</i>' : `<code>${escapeHtml(oldValue)}</code>`
  const to = newValue === null ? '<i>NULL</i>' : `<code>${escapeHtml(newValue)}</code>`
  const { ok, skip } = await confirmBox(
    '确认修改',
    `<div>将 <code>${escapeHtml(table)}</code> 中该行的 <code>${escapeHtml(column)}</code>：<br/><br/>${from} → ${to}</div>`,
    { okText: '执行 UPDATE' },
  )
  if (skip) skipRef.skip = true
  return ok
}
