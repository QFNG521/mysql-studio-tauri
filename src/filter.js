import { escapeHtml } from './ui.js'
import { q, sqlLiteral } from './sql-util.js'

// 操作符定义：arity = 0 无值 / 1 单值 / 2 双值 / N 多值（逗号分隔）
const OPS = [
  { v: '=', label: '=', arity: 1 },
  { v: '<>', label: '≠', arity: 1 },
  { v: '>', label: '>', arity: 1 },
  { v: '<', label: '<', arity: 1 },
  { v: '>=', label: '≥', arity: 1 },
  { v: '<=', label: '≤', arity: 1 },
  { v: 'LIKE', label: 'LIKE', arity: 1, hint: '支持 % _ 通配' },
  { v: 'NOT LIKE', label: 'NOT LIKE', arity: 1, hint: '支持 % _ 通配' },
  { v: 'IN', label: 'IN', arity: 'N', hint: '逗号分隔' },
  { v: 'NOT IN', label: 'NOT IN', arity: 'N', hint: '逗号分隔' },
  { v: 'BETWEEN', label: 'BETWEEN', arity: 2, hint: '范围' },
  { v: 'IS NULL', label: 'IS NULL', arity: 0 },
  { v: 'IS NOT NULL', label: 'IS NOT NULL', arity: 0 },
]

const opOf = (v) => OPS.find((o) => o.v === v) || OPS[0]

/** 单条条件 -> SQL 片段；不合法返回 null */
function condSql(c) {
  if (!c.column) return null
  const op = opOf(c.op)
  const col = q(c.column)
  if (op.arity === 0) return `${col} ${op.v}`
  if (op.arity === 1) {
    if (c.value === '' || c.value == null) return null
    return `${col} ${op.v} ${sqlLiteral(c.value)}`
  }
  if (op.arity === 2) {
    if (c.value === '' || c.value2 === '') return null
    return `${col} BETWEEN ${sqlLiteral(c.value)} AND ${sqlLiteral(c.value2)}`
  }
  // arity N
  const parts = String(c.value || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (!parts.length) return null
  return `${col} ${op.v} (${parts.map(sqlLiteral).join(', ')})`
}

/** 条件数组 -> WHERE 内容 */
export function buildWhere(conds) {
  const out = []
  conds.forEach((c, i) => {
    const s = condSql(c)
    if (!s) return
    if (out.length) out.push(c.and ? 'AND' : 'OR')
    // 多值 BETWEEN 等自身含空格时加括号，避免与 OR/AND 混淆
    out.push(s)
  })
  return out.join(' ')
}

/**
 * 打开可视化筛选面板
 * @param {HTMLElement} anchor 定位锚点（按钮）
 * @param {{name:string}[]} columns 可选列
 * @param {{column:string,op:string,value:string,value2:string,and:boolean}[]} initial 初始条件
 * @param {(sql:string, conds:object[])=>void} onApply
 */
export function openFilterPanel(anchor, columns, initial, onApply) {
  document.getElementById('filter-panel')?.remove()

  let conds = (initial && initial.length ? initial : [{ column: columns[0]?.name || '', op: '=', value: '', value2: '', and: true }])
    .map((c) => ({ ...c }))

  const panel = document.createElement('div')
  panel.id = 'filter-panel'
  panel.className = 'filter-panel'
  panel.innerHTML = `
    <div class="fp-head">
      <b>筛选条件</b>
      <span class="spacer"></span>
      <button class="btn btn-sm" data-act="add">＋ 条件</button>
      <button class="btn btn-sm" data-act="clear">清空</button>
      <button class="btn btn-sm" data-act="close">✕</button>
    </div>
    <div class="fp-rows" data-ref="rows"></div>
    <div class="fp-preview" data-ref="preview"></div>
    <div class="fp-foot">
      <label class="chk"><input type="checkbox" data-ref="auto" checked/> 自动应用</label>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" data-act="apply">应用</button>
    </div>`

  const rowsEl = panel.querySelector('[data-ref="rows"]')
  const previewEl = panel.querySelector('[data-ref="preview"]')
  const autoEl = panel.querySelector('[data-ref="auto"]')

  const colOptions = (sel) =>
    columns
      .map((c) => `<option value="${escapeHtml(c.name)}"${c.name === sel ? ' selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('')
  const opOptions = (sel) =>
    OPS.map((o) => `<option value="${escapeHtml(o.v)}"${o.v === sel ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')

  function render() {
    rowsEl.innerHTML = conds
      .map((c, i) => {
        const op = opOf(c.op)
        const logic = i === 0
          ? '<span class="fp-logic fp-logic-empty">WHERE</span>'
          : `<select class="fp-logic" data-i="${i}" data-k="and">
               <option value="1"${c.and ? ' selected' : ''}>AND</option>
               <option value="0"${!c.and ? ' selected' : ''}>OR</option>
             </select>`
        const val =
          op.arity === 0
            ? '<span class="fp-noval">（无需值）</span>'
            : op.arity === 2
              ? `<input class="fp-val" data-i="${i}" data-k="value" placeholder="起始" value="${escapeHtml(c.value || '')}"/>
                 <span class="fp-and">~</span>
                 <input class="fp-val" data-i="${i}" data-k="value2" placeholder="结束" value="${escapeHtml(c.value2 || '')}"/>`
              : `<input class="fp-val" data-i="${i}" data-k="value" placeholder="${escapeHtml(op.hint || '值')}" value="${escapeHtml(c.value || '')}"/>`
        return `<div class="fp-row">
          ${logic}
          <select class="fp-col" data-i="${i}" data-k="column">${colOptions(c.column)}</select>
          <select class="fp-op" data-i="${i}" data-k="op">${opOptions(c.op)}</select>
          ${val}
          <button class="btn btn-sm fp-del" data-i="${i}" title="删除该条件">✕</button>
        </div>`
      })
      .join('')

    rowsEl.querySelectorAll('select[data-k], input[data-k]').forEach((el) => {
      el.onchange = () => {
        const i = Number(el.dataset.i)
        const k = el.dataset.k
        conds[i][k] = k === 'and' ? el.value === '1' : el.value
        if (k === 'op') {
          // 切换操作符时清掉不再适用的值
          const arity = opOf(conds[i].op).arity
          if (arity === 0) { conds[i].value = ''; conds[i].value2 = '' }
          if (arity !== 2) conds[i].value2 = ''
        }
        render()
        if (autoEl.checked) apply()
      }
      if (el.tagName === 'INPUT') {
        el.oninput = () => {
          const i = Number(el.dataset.i)
          conds[i][el.dataset.k] = el.value
          updatePreview()
          if (autoEl.checked) debouncedApply()
        }
      }
    })
    rowsEl.querySelectorAll('.fp-del').forEach((b) => {
      b.onclick = () => {
        conds.splice(Number(b.dataset.i), 1)
        if (!conds.length) conds = [{ column: columns[0]?.name || '', op: '=', value: '', value2: '', and: true }]
        render()
        if (autoEl.checked) apply()
      }
    })

    rowsEl.querySelector('input.fp-val')?.focus()
    updatePreview()
  }

  function updatePreview() {
    const sql = buildWhere(conds)
    previewEl.innerHTML = sql
      ? `<span class="muted">WHERE</span> <code>${escapeHtml(sql)}</code>`
      : '<span class="muted">（条件不完整，将不施加筛选）</span>'
  }

  let timer = null
  function debouncedApply() {
    clearTimeout(timer)
    timer = setTimeout(apply, 400)
  }

  function apply() {
    const sql = buildWhere(conds)
    onApply(sql, conds.map((c) => ({ ...c })))
  }

  panel.querySelector('[data-act="add"]').onclick = () => {
    conds.push({ column: columns[0]?.name || '', op: '=', value: '', value2: '', and: true })
    render()
  }
  panel.querySelector('[data-act="clear"]').onclick = () => {
    conds = [{ column: columns[0]?.name || '', op: '=', value: '', value2: '', and: true }]
    render()
    apply()
  }
  panel.querySelector('[data-act="close"]').onclick = close
  panel.querySelector('[data-act="apply"]').onclick = apply

  function close() {
    panel.remove()
    document.removeEventListener('mousedown', onOutside)
  }
  function onOutside(e) {
    if (!panel.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close()
  }
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0)

  document.body.appendChild(panel)
  const r = anchor.getBoundingClientRect()
  panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8)) + 'px'
  panel.style.top = r.bottom + 4 + 'px'
  render()
  return { close }
}
