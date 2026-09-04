import { api } from './api.js'
import { toast, escapeHtml, confirmBox } from './ui.js'
import { q, sqlLiteral } from './sql-util.js'
import { highlightSqlToHtml } from './sql-highlight.js'

/**
 * 表设计器：create 模式生成 CREATE TABLE，alter 模式对比原元数据生成 ALTER TABLE。
 * DDL 生成是纯函数（buildCreateSql / buildAlterSql），可独立单测。
 */

const COMMON_TYPES = [
  'int', 'bigint', 'tinyint(1)', 'smallint', 'decimal(10,2)', 'double',
  'varchar(255)', 'char(36)', 'text', 'longtext', 'date', 'datetime',
  'timestamp', 'time', 'json', 'blob', "enum('a','b')",
]
const FK_RULES = ['CASCADE', 'RESTRICT', 'SET NULL', 'NO ACTION']

// ================= DDL 生成（纯函数） =================

/** 默认值 → SQL 片段。mode: '' 无 | 'NULL' | 'CURRENT_TIMESTAMP' | 'VALUE' */
function defaultClause(col) {
  if (col.defaultMode === 'NULL') return 'DEFAULT NULL'
  if (col.defaultMode === 'CURRENT_TIMESTAMP') return 'DEFAULT CURRENT_TIMESTAMP'
  if (col.defaultMode === 'VALUE' && String(col.defaultValue ?? '').trim() !== '') {
    return `DEFAULT ${sqlLiteral(String(col.defaultValue))}`
  }
  return ''
}

/** 单列定义片段：`name` type [NOT NULL] [DEFAULT ..] [AUTO_INCREMENT] [COMMENT '..'] */
export function columnDefFragment(col) {
  // 主键列必须 NOT NULL（MySQL 要求），即使用户勾了 NULL 也强制修正
  const nullable = col.nullable && !col.isPk
  const parts = [
    q(col.name),
    col.type.trim(),
    nullable ? 'NULL' : 'NOT NULL',
    defaultClause(col),
  ]
  if (col.autoInc) parts.push('AUTO_INCREMENT')
  if (col.comment && col.comment.trim()) parts.push(`COMMENT ${sqlLiteral(col.comment)}`)
  return parts.filter(Boolean).join(' ')
}

/** 把 information_schema 的默认值表示归一化为设计器的 mode/value */
function origDefaultRepr(defaultValue) {
  if (defaultValue === null || defaultValue === undefined || defaultValue === '') return ''
  const v = String(defaultValue).trim()
  if (v.toUpperCase() === 'NULL') return 'NULL'
  if (v.toUpperCase() === 'CURRENT_TIMESTAMP') return 'CURRENT_TIMESTAMP'
  return 'VALUE:' + v
}
function curDefaultRepr(col) {
  if (col.defaultMode === 'VALUE') {
    const v = String(col.defaultValue ?? '').trim()
    return v === '' ? '' : 'VALUE:' + v
  }
  return col.defaultMode || ''
}

/** 判断改表时该列定义是否变化（语义比较，避免格式差异造成误改） */
export function columnDefChanged(col, orig) {
  return (
    col.type.trim().toLowerCase() !== orig.column_type.toLowerCase() ||
    col.nullable !== orig.nullable ||
    !!col.autoInc !== orig.is_auto_inc ||
    (col.comment || '') !== (orig.comment || '') ||
    curDefaultRepr(col) !== origDefaultRepr(orig.default)
  )
}

/** 从 IndexDef[]（每列一行）聚合成设计器的索引列表 */
export function groupIndexes(indexDefs) {
  const byName = new Map()
  for (const idx of indexDefs || []) {
    if (idx.name === 'PRIMARY') continue
    if (!byName.has(idx.name)) {
      byName.set(idx.name, { origName: idx.name, name: idx.name, columns: [], unique: !idx.non_unique, method: idx.index_type || 'BTREE' })
    }
    const e = byName.get(idx.name)
    e.columns[idx.seq - 1] = idx.column
    e.unique = e.unique && !idx.non_unique
  }
  for (const e of byName.values()) e.columns = e.columns.filter(Boolean).join(',')
  return [...byName.values()]
}

export function groupForeignKeys(fkDefs) {
  return (fkDefs || []).map((fk) => ({
    origName: fk.name,
    name: fk.name,
    column: fk.column,
    refTable: fk.ref_table,
    refColumn: fk.ref_column,
    onDelete: fk.on_delete || 'RESTRICT',
    onUpdate: fk.on_update || 'RESTRICT',
  }))
}

function indexFragment(idx) {
  const parts = [
    idx.unique ? 'UNIQUE KEY' : 'KEY',
    q(idx.name),
    `(${idx.columns.split(',').map((c) => q(c.trim())).filter((s) => s !== '``').join(',')})`,
  ]
  return parts.join(' ')
}

function fkFragment(fk) {
  const rule = (r) => (FK_RULES.includes(r) ? r : 'RESTRICT')
  return [
    `CONSTRAINT ${q(fk.name)}`,
    `FOREIGN KEY (${q(fk.column)})`,
    `REFERENCES ${q(fk.refTable)} (${q(fk.refColumn)})`,
    `ON DELETE ${rule(fk.onDelete)}`,
    `ON UPDATE ${rule(fk.onUpdate)}`,
  ].join(' ')
}

export function buildCreateSql(db, spec) {
  const lines = spec.columns.map((c) => '  ' + columnDefFragment(c))
  const pkCols = spec.columns.filter((c) => c.isPk).map((c) => q(c.name))
  if (pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.join(',')})`)
  for (const idx of spec.indexes) {
    if (idx.name.trim() && idx.columns.trim()) lines.push('  ' + indexFragment(idx))
  }
  for (const fk of spec.fks) {
    if (fk.name.trim() && fk.column.trim() && fk.refTable.trim() && fk.refColumn.trim()) {
      lines.push('  ' + fkFragment(fk))
    }
  }
  const opts = [`ENGINE=${spec.engine || 'InnoDB'}`, `DEFAULT CHARSET=${spec.charset || 'utf8mb4'}`]
  if (spec.comment && spec.comment.trim()) opts.push(`COMMENT ${sqlLiteral(spec.comment)}`)
  return `CREATE TABLE ${q(db)}.${q(spec.table)} (\n${lines.join(',\n')}\n) ${opts.join(' ')};`
}

/**
 * 生成 ALTER 语句。返回字符串：无变化时为 ''，有变化时为单条 ALTER（子句逗号分隔）。
 * 配合 collectDanger() 获取危险子句说明（用于 UI 确认框高亮）。
 */
export function buildAlterSql(db, spec, orig) {
  const clauses = []

  // ---- 列：以 origName 追踪增/删/改/改名 ----
  const origByName = new Map((orig.columns || []).map((c) => [c.name, c]))
  const keptOrig = new Set()
  for (const col of spec.columns) {
    const name = col.name.trim()
    if (!name || !col.type.trim()) continue
    const frag = columnDefFragment(col)
    const origCol = col.origName ? origByName.get(col.origName) : null
    if (!origCol) {
      clauses.push(`ADD COLUMN ${frag}`)
    } else {
      keptOrig.add(origCol.name)
      if (col.origName !== name) {
        // 改名（定义可能同时变了，CHANGE 一并覆盖）
        clauses.push(`CHANGE COLUMN ${q(col.origName)} ${frag}`)
      } else if (columnDefChanged(col, origCol)) {
        clauses.push(`MODIFY COLUMN ${frag}`)
      }
    }
  }
  for (const origCol of orig.columns || []) {
    if (!keptOrig.has(origCol.name)) {
      clauses.push(`DROP COLUMN ${q(origCol.name)}`)
    }
  }

  // ---- 主键 ----
  const origPk = (orig.pk_columns || []).slice().sort().join(',')
  const newPkCols = spec.columns.filter((c) => c.isPk && c.name.trim())
  const newPk = newPkCols.map((c) => c.name.trim()).sort().join(',')
  if (origPk !== newPk) {
    if (origPk) {
      clauses.push('DROP PRIMARY KEY')
    }
    if (newPk) clauses.push(`ADD PRIMARY KEY (${newPkCols.map((c) => q(c.name.trim())).join(',')})`)
  }

  // ---- 索引 ----
  const origIdx = groupIndexes(orig.indexes || [])
  const origIdxByName = new Map(origIdx.map((i) => [i.origName, i]))
  const keptIdx = new Set()
  for (const idx of spec.indexes) {
    if (!idx.name.trim() || !idx.columns.trim()) continue
    const norm = (s) => s.split(',').map((x) => x.trim()).filter(Boolean).join(',')
    const o = idx.origName ? origIdxByName.get(idx.origName) : null
    if (!o) {
      clauses.push(`ADD ${indexFragment(idx)}`)
    } else {
      keptIdx.add(o.origName)
      if (o.name !== idx.name || norm(o.columns) !== norm(idx.columns) || o.unique !== !!idx.unique || o.method.toUpperCase() !== (idx.method || 'BTREE').toUpperCase()) {
        clauses.push(`DROP INDEX ${q(o.origName)}`)
        clauses.push(`ADD ${indexFragment(idx)}`)
      }
    }
  }
  for (const o of origIdx) {
    if (!keptIdx.has(o.origName)) {
      clauses.push(`DROP INDEX ${q(o.origName)}`)
    }
  }

  // ---- 外键 ----
  const origFks = groupForeignKeys(orig.foreign_keys || [])
  const origFkByName = new Map(origFks.map((f) => [f.origName, f]))
  const keptFk = new Set()
  for (const fk of spec.fks) {
    if (!fk.name.trim() || !fk.column.trim() || !fk.refTable.trim() || !fk.refColumn.trim()) continue
    const o = fk.origName ? origFkByName.get(fk.origName) : null
    if (!o) {
      clauses.push(`ADD ${fkFragment(fk)}`)
    } else {
      keptFk.add(o.origName)
      const rule = (r) => (FK_RULES.includes(r) ? r : 'RESTRICT')
      if (o.column !== fk.column || o.refTable !== fk.refTable || o.refColumn !== fk.refColumn ||
          rule(o.onDelete) !== rule(fk.onDelete) || rule(o.onUpdate) !== rule(fk.onUpdate)) {
        clauses.push(`DROP FOREIGN KEY ${q(o.origName)}`)
        clauses.push(`ADD ${fkFragment(fk)}`)
      }
    }
  }
  for (const o of origFks) {
    if (!keptFk.has(o.origName)) {
      clauses.push(`DROP FOREIGN KEY ${q(o.origName)}`)
    }
  }

  // ---- 表选项 ----
  if (orig.engine && spec.engine && orig.engine.toUpperCase() !== spec.engine.toUpperCase()) {
    clauses.push(`ENGINE=${spec.engine}`)
  }
  if (orig.comment !== undefined && (orig.comment || '') !== (spec.comment || '')) {
    clauses.push(`COMMENT ${sqlLiteral(spec.comment || '')}`)
  }

  if (!clauses.length) return ''
  const body = clauses.join(',\n  ')
  return `ALTER TABLE ${q(db)}.${q(spec.table)}\n  ${body};`
}

/** 收集改表的危险操作说明（删列/删主键），供确认框展示 */
export function collectDanger(spec, orig) {
  const notes = []
  const kept = new Set(spec.columns.map((c) => c.origName).filter(Boolean))
  for (const origCol of orig.columns || []) {
    if (!kept.has(origCol.name)) notes.push(`删除列 ${q(origCol.name)}（该列数据将丢失）`)
  }
  const origPk = (orig.pk_columns || []).slice().sort().join(',')
  const newPk = spec.columns.filter((c) => c.isPk && c.name.trim()).map((c) => c.name.trim()).sort().join(',')
  if (origPk && origPk !== newPk) notes.push('删除原主键（若被其他表外键引用可能失败）')
  return notes
}

// ================= UI =================

export function renderDesignTab(panel, tab) {
  const isCreate = !tab.table
  const st = (tab.state = {
    spec: {
      table: isCreate ? '' : tab.table,
      engine: 'InnoDB',
      charset: 'utf8mb4',
      comment: '',
      columns: [],
      indexes: [],
      fks: [],
    },
    orig: null,
    executing: false,
  })

  panel.innerHTML = `
    <div class="design-panel">
      <div class="design-toolbar">
        <span class="tb-label">${isCreate ? '新建表（库' : '设计表'} <b>${escapeHtml(tab.db)}</b>${isCreate ? '）' : ` . <b>${escapeHtml(tab.table)}</b>`}</span>
        <span class="tb-sep"></span>
        ${isCreate ? `<input data-ref="tname" placeholder="表名" style="width:180px" spellcheck="false"/>` : ''}
        <label class="tb-label">引擎</label>
        <select data-ref="engine"><option>InnoDB</option><option>MyISAM</option><option>MEMORY</option></select>
        <label class="tb-label">字符集</label>
        <select data-ref="charset"><option>utf8mb4</option><option>utf8</option><option>latin1</option><option>gbk</option></select>
        <input data-ref="tcomment" placeholder="表注释（可选）" style="width:200px" spellcheck="false"/>
        <span class="spacer" style="flex:1"></span>
        <button class="btn btn-sm btn-primary" data-act="apply">执行 ${isCreate ? '建表' : '修改'}</button>
      </div>
      <div class="design-body" data-ref="body"></div>
      <div class="design-sql">
        <div class="section-title">SQL 预览</div>
        <pre class="design-preview" data-ref="preview"></pre>
      </div>
    </div>`

  const R = (n) => panel.querySelector(`[data-ref="${n}"]`)
  const A = (n) => panel.querySelector(`[data-act="${n}"]`)

  const datalistId = `dl-types-${Math.random().toString(36).slice(2, 8)}`
  const datalist = `<datalist id="${datalistId}">${COMMON_TYPES.map((t) => `<option value="${t}">`).join('')}</datalist>`

  function emptyCol() {
    return { origName: null, name: '', type: '', nullable: true, autoInc: false, isPk: false, comment: '', defaultMode: '', defaultValue: '' }
  }
  function emptyIdx() { return { origName: null, name: '', columns: '', unique: false, method: 'BTREE' } }
  function emptyFk() { return { origName: null, name: '', column: '', refTable: '', refColumn: '', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' } }

  // ---- 渲染 ----
  function render() {
    const s = st.spec
    const colRows = s.columns.map((c, i) => `
      <tr data-ci="${i}">
        <td class="d-idx">${i + 1}</td>
        <td><input data-f="name" value="${escapeHtml(c.name)}" placeholder="列名" spellcheck="false"/></td>
        <td><input data-f="type" value="${escapeHtml(c.type)}" list="${datalistId}" placeholder="类型，如 varchar(255)" spellcheck="false"/></td>
        <td class="d-check"><input type="checkbox" data-f="nullable" ${c.nullable ? 'checked' : ''}/><span>NULL</span></td>
        <td class="d-check"><input type="checkbox" data-f="isPk" ${c.isPk ? 'checked' : ''}/><span>PK</span></td>
        <td class="d-check"><input type="checkbox" data-f="autoInc" ${c.autoInc ? 'checked' : ''}/><span>自增</span></td>
        <td>
          <select data-f="defaultMode">
            <option value="" ${!c.defaultMode ? 'selected' : ''}>无默认</option>
            <option value="NULL" ${c.defaultMode === 'NULL' ? 'selected' : ''}>NULL</option>
            <option value="CURRENT_TIMESTAMP" ${c.defaultMode === 'CURRENT_TIMESTAMP' ? 'selected' : ''}>当前时间</option>
            <option value="VALUE" ${c.defaultMode === 'VALUE' ? 'selected' : ''}>自定义</option>
          </select>
          <input data-f="defaultValue" value="${escapeHtml(c.defaultValue || '')}" placeholder="默认值" spellcheck="false"
            style="width:90px;visibility:${c.defaultMode === 'VALUE' ? 'visible' : 'hidden'}"/>
        </td>
        <td><input data-f="comment" value="${escapeHtml(c.comment)}" placeholder="注释" spellcheck="false"/></td>
        <td class="d-ops">
          <button class="icon-btn" data-op="up" title="上移">↑</button>
          <button class="icon-btn" data-op="down" title="下移">↓</button>
          <button class="icon-btn d-del" data-op="del" title="删除列">✕</button>
        </td>
      </tr>`).join('')

    const idxRows = s.indexes.map((idx, i) => `
      <tr data-ii="${i}">
        <td><input data-f="name" value="${escapeHtml(idx.name)}" placeholder="索引名" spellcheck="false"/></td>
        <td><input data-f="columns" value="${escapeHtml(idx.columns)}" placeholder="列名，多个用逗号分隔" spellcheck="false" style="width:100%"/></td>
        <td class="d-check"><input type="checkbox" data-f="unique" ${idx.unique ? 'checked' : ''}/><span>唯一</span></td>
        <td><select data-f="method"><option>BTREE</option><option>HASH</option></select></td>
        <td class="d-ops"><button class="icon-btn d-del" data-op="del" title="删除索引">✕</button></td>
      </tr>`).join('')

    const colOptions = s.columns.filter((c) => c.name.trim()).map((c) => `<option value="${escapeHtml(c.name)}">`).join('')
    const fkRows = s.fks.map((fk, i) => `
      <tr data-fi="${i}">
        <td><input data-f="name" value="${escapeHtml(fk.name)}" placeholder="约束名" spellcheck="false"/></td>
        <td><input data-f="column" value="${escapeHtml(fk.column)}" list="${datalistId}-fkcols-${i}" placeholder="本表列" spellcheck="false"/>
          <datalist id="${datalistId}-fkcols-${i}">${colOptions}</datalist></td>
        <td><input data-f="refTable" value="${escapeHtml(fk.refTable)}" placeholder="父表" spellcheck="false"/></td>
        <td><input data-f="refColumn" value="${escapeHtml(fk.refColumn)}" placeholder="父表列" spellcheck="false"/></td>
        <td><select data-f="onDelete">${FK_RULES.map((r) => `<option ${fk.onDelete === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td><select data-f="onUpdate">${FK_RULES.map((r) => `<option ${fk.onUpdate === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td class="d-ops"><button class="icon-btn d-del" data-op="del" title="删除外键">✕</button></td>
      </tr>`).join('')

    R('body').innerHTML = `
      ${datalist}
      <div class="section-title">列 <button class="btn btn-sm" data-act="add-col" style="margin-left:8px">＋ 添加列</button></div>
      <table class="design-grid">
        <thead><tr><th></th><th>列名</th><th>类型</th><th>可空</th><th>主键</th><th>自增</th><th>默认值</th><th>注释</th><th></th></tr></thead>
        <tbody>${colRows || '<tr><td colspan="9" class="muted" style="text-align:center;padding:14px">还没有列，点击「＋ 添加列」</td></tr>'}</tbody>
      </table>
      <div class="section-title">索引 <button class="btn btn-sm" data-act="add-idx" style="margin-left:8px">＋ 添加索引</button></div>
      <table class="design-grid">
        <thead><tr><th>索引名</th><th>列</th><th>唯一</th><th>方法</th><th></th></tr></thead>
        <tbody>${idxRows || '<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">无二级索引（主键在列上勾选）</td></tr>'}</tbody>
      </table>
      <div class="section-title">外键 <button class="btn btn-sm" data-act="add-fk" style="margin-left:8px">＋ 添加外键</button></div>
      <table class="design-grid">
        <thead><tr><th>约束名</th><th>本表列</th><th>父表</th><th>父表列</th><th>ON DELETE</th><th>ON UPDATE</th><th></th></tr></thead>
        <tbody>${fkRows || '<tr><td colspan="7" class="muted" style="text-align:center;padding:14px">无外键</td></tr>'}</tbody>
      </table>`

    bindBody()
    updatePreview()
  }

  // ---- 输入绑定（只改状态不重渲染，避免打字丢焦点） ----
  function bindBody() {
    const body = R('body')
    const s = st.spec

    body.querySelectorAll('tr[data-ci]').forEach((tr) => {
      const i = Number(tr.dataset.ci)
      const col = s.columns[i]
      tr.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f
        const handler = () => {
          if (f === 'nullable' || f === 'isPk' || f === 'autoInc') col[f] = inp.checked
          else if (f === 'defaultMode') { col.defaultMode = inp.value; render() } // 需要显隐默认值输入框
          else col[f] = inp.value
          // 主键列必须 NOT NULL：勾选 PK 时同步取消 NULL
          if (f === 'isPk' && inp.checked) col.nullable = false
          // 自增全表唯一
          if (f === 'autoInc' && inp.checked) s.columns.forEach((c, j) => { if (j !== i) c.autoInc = false })
          if ((f === 'isPk' && inp.checked) || (f === 'autoInc' && inp.checked)) { render(); return }
          updatePreview()
        }
        if (inp.type === 'checkbox' || inp.tagName === 'SELECT') inp.onchange = handler
        else inp.oninput = handler
      })
      tr.querySelectorAll('[data-op]').forEach((btn) => {
        btn.onclick = () => {
          const op = btn.dataset.op
          if (op === 'del') { s.columns.splice(i, 1); render() }
          if (op === 'up' && i > 0) { [s.columns[i - 1], s.columns[i]] = [s.columns[i], s.columns[i - 1]]; render() }
          if (op === 'down' && i < s.columns.length - 1) { [s.columns[i + 1], s.columns[i]] = [s.columns[i], s.columns[i + 1]]; render() }
        }
      })
    })

    body.querySelectorAll('tr[data-ii]').forEach((tr) => {
      const i = Number(tr.dataset.ii)
      const idx = s.indexes[i]
      tr.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f
        const handler = () => {
          idx[f] = inp.type === 'checkbox' ? inp.checked : inp.value
          updatePreview()
        }
        if (inp.type === 'checkbox' || inp.tagName === 'SELECT') inp.onchange = handler
        else inp.oninput = handler
      })
      tr.querySelector('[data-op="del"]').onclick = () => { s.indexes.splice(i, 1); render() }
    })

    body.querySelectorAll('tr[data-fi]').forEach((tr) => {
      const i = Number(tr.dataset.fi)
      const fk = s.fks[i]
      tr.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f
        inp.onchange = inp.oninput = () => { fk[f] = inp.value; updatePreview() }
      })
      tr.querySelector('[data-op="del"]').onclick = () => { s.fks.splice(i, 1); render() }
    })

    body.querySelectorAll('[data-act="add-col"]').forEach((b) => (b.onclick = () => { s.columns.push(emptyCol()); render() }))
    body.querySelectorAll('[data-act="add-idx"]').forEach((b) => (b.onclick = () => { s.indexes.push(emptyIdx()); render() }))
    body.querySelectorAll('[data-act="add-fk"]').forEach((b) => (b.onclick = () => { s.fks.push(emptyFk()); render() }))
  }

  function currentSql() {
    const s = st.spec
    if (isCreate) {
      if (!s.table.trim() || !s.columns.some((c) => c.name.trim() && c.type.trim())) return ''
      return buildCreateSql(tab.db, s)
    }
    if (!st.orig) return ''
    return buildAlterSql(tab.db, s, st.orig)
  }

  function updatePreview() {
    const sql = currentSql().trim()
    R('preview').innerHTML = sql
      ? highlightSqlToHtml(sql) || `<span class="muted">（无变化）</span>`
      : '<span class="muted">填写内容后自动生成…</span>'
  }

  async function apply() {
    if (st.executing) return
    const sql = currentSql().trim()
    if (!sql) { toast(isCreate ? '请先填写表名和至少一个列' : '没有需要执行的修改', 'error'); return }
    if (isCreate) {
      const name = R('tname').value.trim()
      if (!name) { toast('请填写表名', 'error'); return }
      st.spec.table = name
    }
    const finalSql = currentSql().trim()
    const danger = isCreate ? [] : collectDanger(st.spec, st.orig || { columns: [], pk_columns: [] })
    const hasDrop = /DROP (COLUMN|PRIMARY KEY|INDEX|FOREIGN KEY)/.test(finalSql)
    const { ok } = await confirmBox(
      hasDrop || danger.length ? '确认执行（含删除操作）' : '确认执行',
      `即将对 <b>${escapeHtml(tab.db)}</b> 执行以下 ${isCreate ? '建表' : '改表'} SQL：` +
        `<pre class="confirm-sql">${escapeHtml(finalSql)}</pre>` +
        (danger.length ? `<span style="color:var(--danger)">⚠ ${danger.map(escapeHtml).join('；')}</span>` : ''),
      { danger: hasDrop, okText: '执行', wide: true },
    )
    if (!ok) return
    st.executing = true
    try {
      const results = await api.executeSql({ session: tab.connId, db: tab.db, sql: finalSql, maxRows: 1 })
      const err = results.find((r) => r.error)
      if (err) throw new Error(err.error)
      toast(isCreate ? `表 ${st.spec.table} 创建成功` : '表结构已更新', 'ok')
      document.dispatchEvent(new CustomEvent('table-designed', { detail: { connId: tab.connId, db: tab.db, table: st.spec.table } }))
      if (isCreate) openTabs.openData(tab.connId, tab.db, st.spec.table)
    } catch (e) {
      toast(String(e), 'error', 8000)
    } finally {
      st.executing = false
    }
  }

  A('apply').onclick = apply
  R('engine').onchange = (e) => { st.spec.engine = e.target.value; updatePreview() }
  R('charset').onchange = (e) => { st.spec.charset = e.target.value; updatePreview() }
  R('tcomment').oninput = (e) => { st.spec.comment = e.target.value; updatePreview() }
  if (isCreate) R('tname').oninput = (e) => { st.spec.table = e.target.value; updatePreview() }

  async function load() {
    if (isCreate) { st.spec.columns.push(emptyCol()); render(); return }
    try {
      const meta = await api.getTableMeta(tab.connId, tab.db, tab.table)
      st.orig = meta
      st.spec.engine = (meta.ddl.match(/ENGINE=(\w+)/) || [])[1] || 'InnoDB'
      st.spec.charset = (meta.ddl.match(/DEFAULT CHARSET=(\w+)/) || [])[1] || 'utf8mb4'
      st.spec.comment = (meta.ddl.match(/ COMMENT='((?:[^'\\]|\\.)*)'/) || ['', ''])[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
      st.spec.columns = (meta.columns || []).map((c) => {
        const dr = origDefaultRepr(c.default)
        return {
          origName: c.name,
          name: c.name,
          type: c.column_type,
          nullable: c.nullable,
          isPk: !!c.is_pk,
          autoInc: !!c.is_auto_inc,
          comment: c.comment || '',
          defaultMode: dr === '' || dr === 'NULL' || dr === 'CURRENT_TIMESTAMP' ? dr : 'VALUE',
          defaultValue: dr.startsWith('VALUE:') ? dr.slice(6) : '',
        }
      })
      st.spec.indexes = groupIndexes(meta.indexes)
      st.spec.fks = groupForeignKeys(meta.foreign_keys)
      render()
    } catch (e) {
      R('body').innerHTML = `<div class="grid-empty" style="color:var(--danger)">${escapeHtml(String(e))}</div>`
    }
  }

  load()
}
