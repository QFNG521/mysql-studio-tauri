// 通用 UI：toast / 确认框 / 模态框 / 右键菜单

export function toast(msg, type = 'info', ms = 2600) {
  const root = document.getElementById('toast-root')
  const el = document.createElement('div')
  el.className = `toast toast-${type}`
  el.textContent = msg
  root.appendChild(el)
  setTimeout(() => el.classList.add('show'), 10)
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 250)
  }, ms)
}

export function setStatus(text) {
  const el = document.getElementById('status-text')
  if (el) el.textContent = text
}

/** 确认框，返回 Promise<boolean> */
export function confirmBox(title, message, opts = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root')
    const mask = document.createElement('div')
    mask.className = 'modal-mask'
    const okText = opts.okText || '确定'
    const danger = opts.danger ? ' btn-danger' : ''
    mask.innerHTML = `
      <div class="modal confirm-modal" style="width:${opts.width || 480}px">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body confirm-msg"></div>
        <div class="modal-foot">
          <label class="chk"><input type="checkbox" id="cf-skip"/> 不再确认</label>
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn-primary${danger}" data-act="ok">${escapeHtml(okText)}</button>
        </div>
      </div>`
    mask.querySelector('.confirm-msg').innerHTML = message
    const done = (val, skip) => {
      mask.remove()
      resolve({ ok: val, skip })
    }
    mask.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act
      if (act === 'ok') done(true, mask.querySelector('#cf-skip').checked)
      else if (act === 'cancel' || e.target === mask) done(false, false)
    })
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true, mask.querySelector('#cf-skip').checked)
      if (e.key === 'Escape') done(false, false)
    })
    root.appendChild(mask)
    mask.querySelector('[data-act="ok"]').focus()
  })
}

/** 模态框骨架，返回 { mask, body, close } */
export function openModal(title, opts = {}) {
  const root = document.getElementById('modal-root')
  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.innerHTML = `
    <div class="modal" style="width:${opts.width || 480}px">
      <div class="modal-title"><span></span><button class="modal-x" title="关闭">✕</button></div>
      <div class="modal-body"></div>
    </div>`
  mask.querySelector('.modal-title span').textContent = title
  const close = () => mask.remove()
  mask.querySelector('.modal-x').onclick = close
  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask) close()
  })
  const body = mask.querySelector('.modal-body')
  root.appendChild(mask)
  return { mask, body, close }
}

/**
 * 单行输入弹窗，返回字符串；取消/关闭返回 null
 */
export function promptBox(title, value = '', opts = {}) {
  return new Promise((resolve) => {
    const { mask, body, close } = openModal(title, { width: opts.width || 420 })
    let done = false
    const finish = (v) => { if (done) return; done = true; close(); resolve(v) }
    body.innerHTML = `
      ${opts.message ? `<div class="confirm-msg" style="margin-bottom:10px">${opts.message}</div>` : ''}
      <input class="where-input" style="width:100%;padding:6px 8px" value="${escapeHtml(value)}" spellcheck="false" placeholder="${escapeHtml(opts.placeholder || '')}"/>
      <div class="modal-foot">
        <button class="btn btn-sm" data-act="cancel">取消</button>
        <button class="btn btn-sm btn-primary" data-act="ok">${escapeHtml(opts.okText || '确定')}</button>
      </div>`
    const input = body.querySelector('input')
    body.querySelector('[data-act="cancel"]').onclick = () => finish(null)
    body.querySelector('[data-act="ok"]').onclick = () => finish(input.value)
    input.onkeydown = (e) => {
      if (e.key === 'Enter') finish(input.value)
      if (e.key === 'Escape') finish(null)
    }
    // 点遮罩或 ✕ 关闭时同样要 resolve，否则 Promise 永远挂起
    mask.querySelector('.modal-x').onclick = () => finish(null)
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(null) })
    input.focus()
    input.select()
  })
}

/** 自定义右键菜单 */
export function showContextMenu(x, y, items) {
  closeContextMenu()
  const root = document.getElementById('ctxmenu-root')
  const menu = document.createElement('div')
  menu.className = 'ctxmenu'
  menu.id = 'ctxmenu'
  for (const it of items) {
    if (it === '-') {
      const hr = document.createElement('div')
      hr.className = 'ctxmenu-sep'
      menu.appendChild(hr)
      continue
    }
    const btn = document.createElement('div')
    btn.className = 'ctxmenu-item' + (it.disabled ? ' disabled' : '')
    btn.textContent = it.label
    if (!it.disabled) btn.onclick = () => { closeContextMenu(); it.action() }
    menu.appendChild(btn)
  }
  root.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px'
  setTimeout(() => {
    document.addEventListener('mousedown', closeOnOutside, { once: true })
  }, 0)
}

function closeOnOutside(e) {
  if (!e.target.closest('.ctxmenu')) closeContextMenu()
  else document.addEventListener('mousedown', closeOnOutside, { once: true })
}

export function closeContextMenu() {
  document.getElementById('ctxmenu')?.remove()
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}
