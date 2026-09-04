import { api } from './api.js'
import { escapeHtml, toast } from './ui.js'
import { openTabs } from './main.js'
import { createSqlViewer } from './sql-view.js'

const RULE_TEXT = {
  CASCADE: 'CASCADE',
  RESTRICT: 'RESTRICT',
  'SET NULL': 'SET NULL',
  'NO ACTION': 'NO ACTION',
  'SET DEFAULT': 'SET DEFAULT',
}

export function renderStructTab(panel, tab) {
  panel.innerHTML = `
    <div class="struct-panel">
      <div class="subtabs">
        <div class="subtab active" data-sub="cols">列</div>
        <div class="subtab" data-sub="indexes">索引</div>
        <div class="subtab" data-sub="fks">外键 <span data-ref="fk-count" class="subtab-badge" hidden>0</span></div>
        <div class="subtab" data-sub="ddl">DDL</div>
        <span class="spacer" style="flex:1"></span>
        <button class="btn btn-sm" data-act="design" title="打开可视化表设计器" style="margin-right:8px">✏ 设计</button>
      </div>
      <div class="subtab-body" data-ref="body"><div class="grid-empty">加载中…</div></div>
    </div>`

  const body = panel.querySelector('[data-ref="body"]')
  let meta = null
  let ddlView = null

  const views = {
    cols() {
      const rows = meta.columns
        .map((c) => {
          const tags = [
            c.is_pk ? '<span class="tag gold">PK</span>' : '',
            c.is_auto_inc ? '<span class="tag blue">自增</span>' : '',
          ].join('')
          return `<tr>
            <td class="mono"><b>${escapeHtml(c.name)}</b></td>
            <td class="mono">${escapeHtml(c.column_type)}</td>
            <td>${c.nullable ? 'NULL' : 'NOT NULL'}</td>
            <td>${tags}</td>
            <td class="mono">${escapeHtml(c.default ?? '—')}</td>
            <td>${escapeHtml(c.comment || '—')}</td>
            <td class="mono">${escapeHtml(c.collation || '—')}</td>
          </tr>`
        })
        .join('')
      body.innerHTML = `<table class="struct-grid">
        <thead><tr><th>字段</th><th>类型</th><th>可空</th><th>标记</th><th>默认值</th><th>注释</th><th>排序规则</th></tr></thead>
        <tbody>${rows}</tbody></table>`
    },
    indexes() {
      // 聚合同名索引的列
      const byName = new Map()
      for (const idx of meta.indexes) {
        if (!byName.has(idx.name)) {
          byName.set(idx.name, { columns: [], non_unique: idx.non_unique, index_type: idx.index_type })
        }
        const e = byName.get(idx.name)
        e.columns[idx.seq - 1] = idx.column
        e.non_unique = e.non_unique && idx.non_unique
      }
      const rows = [...byName.entries()]
        .map(([name, e]) => `<tr>
          <td class="mono"><b>${escapeHtml(name)}</b></td>
          <td class="mono">${e.columns.map(escapeHtml).join(', ')}</td>
          <td>${e.non_unique ? '<span class="tag">普通</span>' : '<span class="tag blue">唯一</span>'}</td>
          <td class="mono">${escapeHtml(e.index_type)}</td>
        </tr>`)
        .join('')
      body.innerHTML = `<table class="struct-grid">
        <thead><tr><th>索引名</th><th>列</th><th>类型</th><th>方法</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="color:var(--muted)">无索引</td></tr>'}</tbody></table>`
    },
    fks() {
      const out = meta.foreign_keys || []
      const inc = meta.referenced_by || []
      const rule = (r) => RULE_TEXT[r] || r || '—'

      // 本表 -> 父表
      const outRows = out
        .map(
          (fk) => `<tr>
          <td class="mono"><b>${escapeHtml(fk.name)}</b></td>
          <td class="mono">${escapeHtml(fk.column)}</td>
          <td class="mono"><a class="link" data-jump="${escapeHtml(fk.ref_db)}|${escapeHtml(fk.ref_table)}">${escapeHtml(fk.ref_db === tab.db ? fk.ref_table : `${fk.ref_db}.${fk.ref_table}`)}.${escapeHtml(fk.ref_column)}</a></td>
          <td class="mono">${escapeHtml(rule(fk.on_update))}</td>
          <td class="mono">${escapeHtml(rule(fk.on_delete))}</td>
        </tr>`
        )
        .join('')

      // 子表 -> 本表
      const incRows = inc
        .map(
          (fk) => `<tr>
          <td class="mono"><b>${escapeHtml(fk.name)}</b></td>
          <td class="mono"><a class="link" data-jump="${escapeHtml(fk.ref_db)}|${escapeHtml(fk.ref_table)}">${escapeHtml(fk.ref_db === tab.db ? fk.ref_table : `${fk.ref_db}.${fk.ref_table}`)}</a></td>
          <td class="mono">${escapeHtml(fk.column)}</td>
          <td class="mono">${escapeHtml(fk.ref_column)}</td>
          <td class="mono">${escapeHtml(rule(fk.on_update))}</td>
          <td class="mono">${escapeHtml(rule(fk.on_delete))}</td>
        </tr>`
        )
        .join('')

      body.innerHTML = `
        <div class="section-title">本表指向其他表 <span class="muted">(${out.length})</span></div>
        <table class="struct-grid">
          <thead><tr><th>约束名</th><th>本表列</th><th>引用（父）</th><th>ON UPDATE</th><th>ON DELETE</th></tr></thead>
          <tbody>${outRows || '<tr><td colspan="5" class="muted">无外键</td></tr>'}</tbody>
        </table>
        <div class="section-title" style="margin-top:16px">其他表指向本表 <span class="muted">(${inc.length})</span></div>
        <table class="struct-grid">
          <thead><tr><th>约束名</th><th>子表</th><th>子表列</th><th>本表列</th><th>ON UPDATE</th><th>ON DELETE</th></tr></thead>
          <tbody>${incRows || '<tr><td colspan="6" class="muted">没有被其他表引用</td></tr>'}</tbody>
        </table>`

      body.querySelectorAll('[data-jump]').forEach((a) => {
        a.onclick = () => {
          const [db, tbl] = a.dataset.jump.split('|')
          openTabs.openData(tab.connId, db, tbl)
        }
      })
    },
    ddl() {
      ddlView?.destroy()
      body.innerHTML = ''
      const wrap = document.createElement('div')
      wrap.className = 'ddl-editor'
      body.appendChild(wrap)
      // 用 CodeMirror 只读查看器渲染，获得与查询页一致的 SQL 高亮（含行号、可折叠）
      const ddlText = meta.ddl || '-- 无 DDL'
      ddlView = createSqlViewer(wrap, {
        doc: ddlText,
        readOnly: true,
        showLineNumbers: false,
        fold: true,
      })
      const bar = document.createElement('div')
      bar.className = 'ddl-actions'
      bar.innerHTML = `<button class="btn btn-sm" data-act="copy-ddl">复制 DDL</button>
        <span class="muted" style="margin-left:8px">${escapeHtml((meta.ddl || '').split('\n').length)} 行</span>`
      body.appendChild(bar)
      bar.querySelector('[data-act="copy-ddl"]').onclick = async () => {
        try { await navigator.clipboard.writeText(ddlText); toast('已复制 DDL', 'ok') }
        catch { toast('复制失败', 'error') }
      }
    },
  }

  async function load() {
    try {
      meta = await api.getTableMeta(tab.connId, tab.db, tab.table)
      tab.title = tab.table
      const badge = panel.querySelector('[data-ref="fk-count"]')
      const n = (meta.foreign_keys?.length || 0) + (meta.referenced_by?.length || 0)
      if (badge) {
        badge.hidden = n === 0
        badge.textContent = String(n)
      }
      views[panel.dataset.sub || 'cols']()
    } catch (e) {
      body.innerHTML = `<div class="grid-empty" style="color:var(--danger)">${escapeHtml(String(e))}</div>`
    }
  }

  panel.querySelectorAll('.subtab').forEach((el) => {
    el.onclick = () => {
      panel.querySelectorAll('.subtab').forEach((x) => x.classList.remove('active'))
      el.classList.add('active')
      panel.dataset.sub = el.dataset.sub
      if (meta) views[el.dataset.sub]()
    }
  })
  panel.querySelector('[data-act="design"]').onclick = () => openTabs.openDesign(tab.connId, tab.db, tab.table)
  load()
  // 页面关闭时释放编辑器实例（tab 的 el 被移除即视为关闭）
  new MutationObserver((_, ob) => {
    if (!panel.isConnected) { ddlView?.destroy(); ddlView = null; ob.disconnect() }
  }).observe(panel.parentElement || panel, { childList: true })
}
