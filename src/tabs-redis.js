import { api } from './api.js'
import { toast, escapeHtml, showContextMenu, promptBox } from './ui.js'
import { openTabs } from './main.js'
import { copyText } from './tree.js'
import { redisHistory } from './store.js'

// ================= 键查询页（关键词优先，不在树里展开） =================

function normPattern(q) {
  const s = (q || '').trim()
  if (!s) return null // 空 = 查全部（后端 SCAN 不带 MATCH）
  if (s.includes('*') || s.includes('?')) return s // 已经是 SCAN MATCH 模式
  return `*${s}*` // 普通关键词按“包含”匹配
}

export function renderRedisKeysTab(panel, tab) {
  const st = (tab.state = {
    keys: [], cursor: '0', done: false, loading: false,
    norm: null, searched: false, sel: null,
  })

  panel.innerHTML = `
    <div class="list-panel">
      <div class="list-toolbar">
        <button class="btn btn-sm btn-primary" data-act="search">🔍 搜索</button>
        <span class="tb-sep"></span>
        <span class="tb-label"><b>db${tab.db}</b></span>
        <span class="tb-sep"></span>
        <input class="list-search" data-ref="pattern"
          placeholder="输入关键词查询，如 user 或 user:*（自动按包含匹配）" spellcheck="false" style="width:320px"/>
        <span class="spacer" style="flex:1"></span>
        <button class="btn btn-sm" data-act="new">＋ 新建键</button>
      </div>
      <div class="redis-history" data-ref="history"></div>
      <div class="rk-body">
        <div class="rk-results" data-ref="results">
          <div class="grid-empty" style="color:var(--muted)">
            输入关键词后点击「搜索」，或点击上方的历史关键词<br/>
            （支持 Redis SCAN MATCH 通配符 <b>*</b> / <b>?</b>）
          </div>
        </div>
        <div class="rk-detail" data-ref="detail">
          <div class="grid-empty" style="color:var(--muted)">点击左侧键名，值会显示在这里</div>
        </div>
      </div>
    </div>`

  const R = (n) => panel.querySelector(`[data-ref="${n}"]`)
  const A = (n) => panel.querySelector(`[data-act="${n}"]`)

  function renderHistory() {
    const hist = redisHistory.get(tab.connId, tab.db)
    if (!hist.length) { R('history').innerHTML = ''; return }
    R('history').innerHTML =
      `<span class="rh-label">历史：</span>` +
      hist.map((h) => `<span class="rh-chip" data-kw="${escapeHtml(h)}">${escapeHtml(h)}<span class="rh-x" data-x="1" title="删除该记录">×</span></span>`).join('') +
      `<span class="rh-clear" data-act="clearhist">清除全部</span>`
    R('history').querySelectorAll('.rh-chip').forEach((c) => {
      c.onclick = (e) => {
        if (e.target.dataset.x === '1') { // 单条删除
          e.stopPropagation()
          redisHistory.remove(tab.connId, tab.db, c.dataset.kw)
          renderHistory()
          return
        }
        R('pattern').value = c.dataset.kw
        runSearch()
      }
    })
    R('history').querySelector('[data-act="clearhist"]').onclick = (e) => {
      e.stopPropagation()
      redisHistory.clear(tab.connId, tab.db)
      renderHistory()
    }
  }

  async function runSearch() {
    const q = R('pattern').value.trim()
    st.norm = normPattern(q)
    if (q) redisHistory.add(tab.connId, tab.db, q)
    st.searched = true
    st.keys = []; st.cursor = '0'; st.done = false; st.sel = null
    renderHistory()
    await load()
  }

  async function load() {
    if (st.loading) return
    st.loading = true
    R('results').innerHTML = '<div class="grid-empty" style="color:var(--muted)">查询中…</div>'
    try {
      const res = await api.redisScan({
        id: tab.connId, db: tab.db, cursor: st.cursor, pattern: st.norm, count: 200,
      })
      st.keys.push(...res.keys)
      st.cursor = res.cursor
      st.done = res.cursor === '0'
      renderRows()
    } catch (e) {
      R('results').innerHTML = `<div class="grid-empty" style="color:var(--danger)">${escapeHtml(String(e))}</div>`
    } finally {
      st.loading = false
    }
  }

  function renderRows() {
    const rows = st.keys
      .map((k) => {
        const icon = typeIcon(k.rtype)
        const ttl = k.ttl < 0 ? '∞' : `${k.ttl}s`
        const sel = st.sel === k.key ? ' sel' : ''
        return `<tr class="rk-row${sel}" data-key="${escapeHtml(k.key)}">
          <td class="c-icon">${icon}</td>
          <td class="c-name mono"><b>${escapeHtml(k.key)}</b></td>
          <td><span class="tag blue">${escapeHtml(k.rtype)}</span></td>
          <td class="num">${ttl}</td>
        </tr>`
      })
      .join('')

    const patTxt = st.norm ? `模式 <b>${escapeHtml(st.norm)}</b> · ` : ''
    R('results').innerHTML = `
      <table class="list-grid">
        <thead><tr>
          <th class="c-icon"></th>
          <th>键名</th>
          <th>类型</th>
          <th class="num">TTL</th>
        </tr></thead>
        <tbody>
          ${rows || '<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">没有匹配的键</td></tr>'}
        </tbody>
      </table>
      ${st.done ? '' : '<div class="list-more"><button class="btn btn-sm" data-act="more">加载更多…</button></div>'}`

    R('results').querySelectorAll('tbody tr.rk-row').forEach((tr) => {
      const key = tr.dataset.key
      tr.onclick = () => openDetail(key, tr)
      tr.oncontextmenu = (e) => {
        e.preventDefault()
        showContextMenu(e.clientX, e.clientY, [
          { label: '在右侧查看值', action: () => openDetail(key, tr) },
          { label: '新标签页打开', action: () => openTabs.openRedisKey(tab.connId, tab.db, key) },
          { label: '复制键名', action: () => copyText(key) },
          '-',
          { label: '删除键', danger: true, action: () => deleteKey(key) },
        ])
      }
    })
    const moreBtn = R('results').querySelector('[data-act="more"]')
    if (moreBtn) moreBtn.onclick = () => load()

    panel.querySelector('.redis-info')?.remove?.()
    const info = document.createElement('div')
    info.className = 'redis-info'
    info.textContent = `${patTxt}共 ${st.keys.length} 个键${st.done ? '' : '（还有更多，点“加载更多”）'}`
    panel.querySelector('.list-toolbar').after(info)
  }

  function openDetail(key, tr) {
    st.sel = key
    R('results').querySelectorAll('tbody tr.rk-row').forEach((r) => r.classList.toggle('sel', r === tr))
    mountKeyViewer(R('detail'), {
      connId: tab.connId, db: tab.db, key,
      closeable: true,
      onClose: clearDetail,
      onDelete: () => {
        st.keys = st.keys.filter((x) => x.key !== key)
        st.sel = null
        clearDetail()
        renderRows()
      },
    })
  }

  function clearDetail() {
    R('detail').innerHTML = '<div class="grid-empty" style="color:var(--muted)">点击左侧键名，值会显示在这里</div>'
    R('results').querySelectorAll('tbody tr.rk-row').forEach((r) => r.classList.remove('sel'))
  }

  async function deleteKey(key) {
    const { confirmBox } = await import('./ui.js')
    const { ok } = await confirmBox('删除键', `确定删除键「${key}」？<br/>此操作不可恢复。`, { danger: true, okText: '删除' })
    if (!ok) return
    try {
      await api.redisDel({ id: tab.connId, db: tab.db, key })
      st.keys = st.keys.filter((x) => x.key !== key)
      if (st.sel === key) { st.sel = null; clearDetail() }
      renderRows()
      toast('已删除', 'ok')
    } catch (e) {
      toast(String(e), 'error')
    }
  }

  async function newKey() {
    const key = await promptBox('新建键', '', { placeholder: '键名', okText: '下一步' })
    if (key == null || !key.trim()) return
    const type = await promptBox('键类型', 'string', { message: '类型：string / list / set / zset / hash', placeholder: 'string', okText: '创建' })
    if (type == null) return
    const rtype = (type.trim() || 'string').toLowerCase()
    if (!['string', 'list', 'set', 'zset', 'hash'].includes(rtype)) {
      toast(`不支持的类型：${rtype}`, 'error')
      return
    }
    try {
      await api.redisSet({ id: tab.connId, db: tab.db, key: key.trim(), rtype, string: rtype === 'string' ? '' : null, list: null, set: null, zset: null, hash: null, ttl: null })
      openTabs.openRedisKey(tab.connId, tab.db, key.trim())
      toast('已创建空键', 'ok')
    } catch (e) {
      toast(String(e), 'error')
    }
  }

  // 搜索：按钮 / 回车 立即执行；输入时 600ms 防抖自动查询（清空则不查全部）
  A('search').onclick = runSearch
  R('pattern').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch() }
  })
  let dt
  R('pattern').addEventListener('input', () => {
    clearTimeout(dt)
    const v = R('pattern').value.trim()
    if (!v) {
      st.keys = []; st.searched = false; st.norm = null; st.sel = null
      R('results').innerHTML = '<div class="grid-empty" style="color:var(--muted)">输入关键词后点击「搜索」，或点击上方的历史关键词</div>'
      panel.querySelector('.redis-info')?.remove?.()
      return
    }
    dt = setTimeout(runSearch, 600)
  })

  A('new').onclick = newKey
  tab.onShow = () => { R('pattern').focus() }
  renderHistory()
}

// ================= 键值查看 / 编辑面板（可切换展示类型，可内联/独立复用） =================

function typeIcon(rtype) {
  switch (rtype) {
    case 'string': return '🔤'
    case 'list': return '📜'
    case 'set': return '🎯'
    case 'zset': return '📊'
    case 'hash': return '🗂'
    default: return '❓'
  }
}

const HINTS = {
  string: '直接编辑字符串内容。',
  list: '每行一个元素。',
  set: '每行一个成员（空行忽略）。',
  zset: '每行：member<TAB>score，例如 item1\\t10',
  hash: '每行：field<TAB>value，例如 name\\tTom',
}

function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 把某个 Redis 键的查看/编辑面板挂载到 root 容器。
 * ctx: { connId, db, key, closeable?, onClose?, onDelete? }
 * 返回 { reload } 以便宿主在 onShow 时刷新。
 */
export function mountKeyViewer(root, ctx) {
  const { connId, db, key } = ctx
  const st = { data: null, loading: false, view: 'text' }

  root.innerHTML = `
    <div class="redis-bar">
      <span class="tb-label">键 <b class="mono">${escapeHtml(key)}</b></span>
      <span class="tb-sep"></span>
      <span class="tag blue" data-ref="type">—</span>
      <span class="tb-label" data-ref="size"></span>
      <span class="tb-label" data-ref="ttl"></span>
      <span class="tb-sep"></span>
      <label class="tb-label">展示</label>
      <select class="redis-view" data-ref="view"></select>
      <span class="spacer" style="flex:1"></span>
      <button class="btn btn-sm" data-act="copy">复制键名</button>
      ${ctx.closeable ? '<button class="btn btn-sm" data-act="close">✕ 关闭</button>' : ''}
      <button class="btn btn-sm btn-danger" data-act="del">删除键</button>
    </div>
    <div class="redis-edit">
      <div class="redis-edit-hint" data-ref="hint"></div>
      <textarea class="value-editor mono" data-ref="editor" spellcheck="false" style="display:none"></textarea>
      <pre class="value-json mono" data-ref="json" style="display:none"></pre>
      <div class="value-table" data-ref="table" style="display:none"></div>
      <div class="redis-ttl">
        <label>TTL(秒)</label>
        <input type="number" class="redis-ttl-input" data-ref="ttl" placeholder="如 3600；-1 表示永不过期" />
        <button class="btn btn-sm" data-act="setttl">设置过期</button>
        <button class="btn btn-sm" data-act="persist">持久化</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn btn-sm btn-primary" data-act="save">保存值</button>
      </div>
    </div>`

  const R = (n) => root.querySelector(`[data-ref="${n}"]`)
  const A = (n) => root.querySelector(`[data-act="${n}"]`)

  async function load() {
    if (st.loading) return
    st.loading = true
    try {
      const v = await api.redisGet({ id: connId, db, key })
      st.data = v
      R('type').textContent = v.rtype
      R('size').textContent = v.rtype === 'string' ? `${v.size} 字节` : `${v.size} 个元素`
      R('ttl').textContent = v.ttl < 0 ? '永不过期' : `剩余 ${v.ttl}s`
      R('ttl').dataset.cur = String(v.ttl)

      const collection = ['list', 'set', 'zset', 'hash'].includes(v.rtype)
      R('view').innerHTML =
        `<option value="text">文本</option><option value="json">JSON</option>` +
        (collection ? `<option value="table">表格</option>` : '')
      st.view = collection ? 'table' : 'text'
      R('view').value = st.view
      applyView()
    } catch (e) {
      toast(String(e), 'error', 5000)
    } finally {
      st.loading = false
    }
  }

  function applyView() {
    const v = st.data
    const showText = st.view === 'text'
    const showJson = st.view === 'json'
    const showTable = st.view === 'table'
    R('editor').style.display = showText ? '' : 'none'
    R('json').style.display = showJson ? '' : 'none'
    R('table').style.display = showTable ? '' : 'none'
    A('save').disabled = showJson
    if (showText) R('editor').value = valueToText(v)
    if (showJson) R('json').textContent = valueToJson(v)
    if (showTable) renderTable(v)
    R('hint').textContent = showJson ? 'JSON 预览（只读）' : (HINTS[v.rtype] || '')
  }

  function valueToText(v) {
    switch (v.rtype) {
      case 'string': return v.string ?? ''
      case 'list': return (v.list || []).join('\n')
      case 'set': return (v.set || []).join('\n')
      case 'zset': return (v.zset || []).map((m) => `${m.member}\t${m.score}`).join('\n')
      case 'hash': return (v.hash || []).map((h) => `${h.field}\t${h.value}`).join('\n')
      default: return ''
    }
  }

  function valueToJson(v) {
    try {
      if (v.rtype === 'string') {
        const raw = v.string ?? ''
        try {
          return JSON.stringify(JSON.parse(raw), null, 2)
        } catch {
          return raw
        }
      }
      if (v.rtype === 'list') return JSON.stringify(v.list || [], null, 2)
      if (v.rtype === 'set') return JSON.stringify(v.set || [], null, 2)
      if (v.rtype === 'zset') return JSON.stringify(v.zset || [], null, 2)
      if (v.rtype === 'hash') {
        const o = {}
        for (const h of (v.hash || [])) o[h.field] = h.value
        return JSON.stringify(o, null, 2)
      }
      return JSON.stringify({ rtype: v.rtype, note: '暂不支持预览' }, null, 2)
    } catch (e) {
      return String(e)
    }
  }

  function renderTable(v) {
    const cont = R('table')
    let html = ''
    if (v.rtype === 'list' || v.rtype === 'set') {
      const rows = v.rtype === 'list' ? (v.list || []) : (v.set || [])
      html = `<table class="vt"><thead><tr><th class="vt-idx">#</th><th>值</th><th></th></tr></thead><tbody>` +
        rows.map((val, i) => `<tr><td class="vt-idx">${i + 1}</td><td><input class="vt-input" data-r="val" value="${escAttr(val)}"/></td><td><button class="vt-del" data-act="delrow">✕</button></td></tr>`).join('') +
        `</tbody></table><button class="btn btn-sm vt-add" data-act="addrow">＋ 添加行</button>`
    } else if (v.rtype === 'zset') {
      const rows = v.zset || []
      html = `<table class="vt"><thead><tr><th class="vt-idx">#</th><th>member</th><th>score</th><th></th></tr></thead><tbody>` +
        rows.map((m, i) => `<tr><td class="vt-idx">${i + 1}</td><td><input class="vt-input" data-r="member" value="${escAttr(m.member)}"/></td><td><input class="vt-input vt-score" data-r="score" value="${escAttr(m.score)}"/></td><td><button class="vt-del" data-act="delrow">✕</button></td></tr>`).join('') +
        `</tbody></table><button class="btn btn-sm vt-add" data-act="addrow">＋ 添加行</button>`
    } else if (v.rtype === 'hash') {
      const rows = v.hash || []
      html = `<table class="vt"><thead><tr><th class="vt-idx">#</th><th>field</th><th>value</th><th></th></tr></thead><tbody>` +
        rows.map((h, i) => `<tr><td class="vt-idx">${i + 1}</td><td><input class="vt-input" data-r="field" value="${escAttr(h.field)}"/></td><td><input class="vt-input" data-r="value" value="${escAttr(h.value)}"/></td><td><button class="vt-del" data-act="delrow">✕</button></td></tr>`).join('') +
        `</tbody></table><button class="btn btn-sm vt-add" data-act="addrow">＋ 添加行</button>`
    }
    cont.innerHTML = html
    cont.querySelector('[data-act="addrow"]').onclick = () => addTableRow(v.rtype)
    cont.querySelectorAll('[data-act="delrow"]').forEach((b) => {
      b.onclick = () => { b.closest('tr').remove(); reindexTable() }
    })
  }

  function addTableRow(rtype) {
    const tbody = R('table').querySelector('tbody')
    const i = tbody.children.length + 1
    const tr = document.createElement('tr')
    if (rtype === 'list' || rtype === 'set') {
      tr.innerHTML = `<td class="vt-idx">${i}</td><td><input class="vt-input" data-r="val" value=""/></td><td><button class="vt-del" data-act="delrow">✕</button></td>`
    } else if (rtype === 'zset') {
      tr.innerHTML = `<td class="vt-idx">${i}</td><td><input class="vt-input" data-r="member" value=""/></td><td><input class="vt-input vt-score" data-r="score" value="0"/></td><td><button class="vt-del" data-act="delrow">✕</button></td>`
    } else {
      tr.innerHTML = `<td class="vt-idx">${i}</td><td><input class="vt-input" data-r="field" value=""/></td><td><input class="vt-input" data-r="value" value=""/></td><td><button class="vt-del" data-act="delrow">✕</button></td>`
    }
    tbody.appendChild(tr)
    tr.querySelector('[data-act="delrow"]').onclick = () => { tr.remove(); reindexTable() }
  }

  function reindexTable() {
    R('table').querySelectorAll('tbody tr').forEach((tr, idx) => {
      tr.querySelector('.vt-idx').textContent = String(idx + 1)
    })
  }

  function parseTable() {
    const v = st.data
    const rows = [...R('table').querySelectorAll('tbody tr')]
    if (v.rtype === 'list') {
      return { string: null, list: rows.map((tr) => tr.querySelector('[data-r="val"]').value), set: null, zset: null, hash: null }
    }
    if (v.rtype === 'set') {
      const set = rows.map((tr) => tr.querySelector('[data-r="val"]').value).map((s) => s.trim()).filter((s) => s !== '')
      return { string: null, list: null, set, zset: null, hash: null }
    }
    if (v.rtype === 'zset') {
      const zset = rows.map((tr) => ({
        member: tr.querySelector('[data-r="member"]').value,
        score: parseFloat(tr.querySelector('[data-r="score"]').value) || 0,
      }))
      return { string: null, list: null, set: null, zset, hash: null }
    }
    if (v.rtype === 'hash') {
      const hash = rows
        .map((tr) => ({ field: tr.querySelector('[data-r="field"]').value, value: tr.querySelector('[data-r="value"]').value }))
        .filter((h) => h.field !== '')
      return { string: null, list: null, set: null, zset: null, hash }
    }
    return null
  }

  function parseEditor() {
    const text = R('editor').value
    const v = st.data
    switch (v.rtype) {
      case 'string':
        return { string: text, list: null, set: null, zset: null, hash: null }
      case 'list':
        return { string: null, list: text.split('\n'), set: null, zset: null, hash: null }
      case 'set': {
        const items = text.split('\n').map((s) => s.trim()).filter((s) => s !== '')
        return { string: null, list: null, set: items, zset: null, hash: null }
      }
      case 'zset': {
        const items = text.split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
          .map((l) => {
            const i = l.lastIndexOf('\t')
            const member = i < 0 ? l : l.slice(0, i)
            const score = i < 0 ? 0 : parseFloat(l.slice(i + 1)) || 0
            return { member, score }
          })
        return { string: null, list: null, set: null, zset: items, hash: null }
      }
      case 'hash': {
        const items = text.split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
          .map((l) => {
            const i = l.indexOf('\t')
            return i < 0 ? { field: l, value: '' } : { field: l.slice(0, i), value: l.slice(i + 1) }
          })
        return { string: null, list: null, set: null, zset: null, hash: items }
      }
      default:
        return null
    }
  }

  A('save').onclick = async () => {
    try {
      const parsed = st.view === 'table' ? parseTable() : parseEditor()
      if (!parsed) { toast('当前展示方式不可保存（请切到 文本 / 表格）', 'error'); return }
      await api.redisSet({
        id: connId, db, key, rtype: st.data.rtype,
        ttl: st.data ? st.data.ttl : null,
        ...parsed,
      })
      toast('已保存', 'ok')
      await load()
    } catch (e) {
      toast(String(e), 'error')
    }
  }

  async function applyTtl(ttl) {
    try {
      await api.redisExpire({ id: connId, db, key, ttl })
      toast(ttl > 0 ? `已设置过期 ${ttl}s` : '已设为永不过期', 'ok')
      await load()
    } catch (e) {
      toast(String(e), 'error')
    }
  }
  A('setttl').onclick = () => {
    const n = parseInt(R('ttl').value)
    if (!n || n <= 0) { toast('请输入大于 0 的秒数', 'error'); return }
    applyTtl(n)
  }
  A('persist').onclick = () => applyTtl(0)
  A('copy').onclick = () => copyText(key)
  A('del').onclick = async () => {
    const { confirmBox } = await import('./ui.js')
    const { ok } = await confirmBox('删除键', `确定删除键「${key}」？`, { danger: true, okText: '删除' })
    if (!ok) return
    try {
      await api.redisDel({ id: connId, db, key })
      toast('已删除', 'ok')
      ctx.onDelete?.()
    } catch (e) {
      toast(String(e), 'error')
    }
  }
  if (ctx.closeable) A('close').onclick = () => ctx.onClose?.()
  R('view').onchange = () => { st.view = R('view').value; applyView() }

  load()
  return { reload: load }
}

// ================= 键值独立标签页（从树右键 / 新标签页打开） =================

export function renderRedisKeyTab(panel, tab) {
  const host = document.createElement('div')
  host.style.height = '100%'
  host.style.display = 'flex'
  host.style.flexDirection = 'column'
  host.style.minHeight = '0'
  panel.innerHTML = ''
  panel.appendChild(host)
  const viewer = mountKeyViewer(host, {
    connId: tab.connId, db: tab.db, key: tab.key,
    closeable: false,
    onDelete: () => tab.close(),
  })
  tab.onShow = () => viewer.reload()
}
