// CodeMirror 工厂：编辑器（查询页）与只读查看器（DDL 等）共用同一套扩展，
// 保证高亮配置只写一处。
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { indentUnit, syntaxHighlighting, foldGutter, bracketMatching } from '@codemirror/language'
import { sql, MySQL } from '@codemirror/lang-sql'
import { sqlHighlightStyle } from './sql-highlight.js'

const lightTheme = EditorView.theme({
  // 常规文本用纯黑，与 Navicat 默认一致（关键字/字符串等由 .sh-* 决定）
  '&': { backgroundColor: '#ffffff', color: '#000000' },
  '.cm-content': { caretColor: '#2f6feb', padding: '10px 0' },
  '.cm-gutters': { backgroundColor: '#f7f8fa', color: '#9aa0aa', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(47,111,235,0.05)' },
  '.cm-activeLineGutter': { backgroundColor: '#eef1f5', color: '#555' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#b4d5fe' },
  '.cm-cursor': { borderLeftWidth: '2px' },
  '.cm-panels': { backgroundColor: '#f7f8fa' },
}, { dark: false })

/**
 * 基础扩展集合
 * @param {object} o
 * @param {string} o.doc 初始内容
 * @param {boolean} o.readOnly 是否只读
 * @param {object} [o.schema] SQL 补全用的 schema（{table: [cols]}）
 * @param {(text:string)=>void} [o.onChange]
 * @param {import('@codemirror/view').Keymap} [o.extraKeymap]
 * @param {boolean} [o.showLineNumbers]
 */
export function baseExtensions(o = {}) {
  const {
    readOnly = false, schema, onChange, extraKeymap = [],
    showLineNumbers = true, fold = false,
  } = o
  const exts = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    indentUnit.of('  '),
    sql({ dialect: MySQL, schema: schema || {}, upperCaseKeywords: true }),
    syntaxHighlighting(sqlHighlightStyle), // 关键：缺了它就不会生成高亮 class
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab, ...extraKeymap]),
    lightTheme,
  ]
  if (showLineNumbers) exts.unshift(lineNumbers())
  if (fold) exts.unshift(foldGutter())
  if (!readOnly) exts.push(autocompletion({ activateOnTyping: true }))
  if (readOnly) {
    exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
  }
  if (onChange) {
    exts.push(EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString()) }))
  }
  return exts
}

/**
 * 滚动保护：WKWebView（Tauri）在 contenteditable 获得焦点时会「把插入符滚到可见区」，
 * 于是出现「用滚动条/滚轮滚到别处 → 点一下页面 → 内容跳回光标所在位置」的现象。
 * 光在 focus / mouseup 上还原一次是不够的：CodeMirror 自己的 measure 也会在之后
 * 一两帧里写 scrollTop，所以这里在「鼠标按下 + 聚焦」后的一个小窗口内钉住滚动位置，
 * 并用 rAF + 定时器多次重试，直到窗口结束。
 */
function installScrollGuard(view) {
  const scroller = view.scrollDOM
  if (!scroller) return

  let top = scroller.scrollTop
  let left = scroller.scrollLeft
  let guardUntil = 0 // 该时间点之前发生的滚动一律视为「异常跳动」
  let pinning = false
  let timer = 0

  const remember = () => {
    top = scroller.scrollTop
    left = scroller.scrollLeft
  }
  const restore = () => {
    if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top
    if (Math.abs(scroller.scrollLeft - left) > 1) scroller.scrollLeft = left
  }
  const releaseGuard = () => { guardUntil = 0 }

  function pin() {
    if (pinning) return
    pinning = true
    const step = () => restore()
    step()
    requestAnimationFrame(() => {
      step()
      requestAnimationFrame(step)
    })
    clearTimeout(timer)
    timer = setTimeout(() => {
      step()
      pinning = false
    }, 140)
  }

  scroller.addEventListener('scroll', () => {
    if (pinning) return // 自己还原产生的滚动，忽略
    if (performance.now() < guardUntil) { pin(); return } // 窗口内的跳动 → 还原
    remember()
  }, { passive: true })

  // 鼠标交互才需要保护：键盘操作（方向键/输入）本来就该让视图跟随光标
  view.dom.addEventListener('mousedown', () => {
    remember()
    guardUntil = performance.now() + 220
  }, true)
  view.dom.addEventListener('focus', () => {
    if (performance.now() < guardUntil) pin()
  }, true)
  view.dom.addEventListener('mouseup', () => {
    if (performance.now() < guardUntil) pin()
  }, true)
  view.dom.addEventListener('keydown', releaseGuard, true)
  view.dom.addEventListener('wheel', releaseGuard, { capture: true, passive: true })
  view.dom.addEventListener('touchstart', releaseGuard, { capture: true, passive: true })

  // 反向的一种情况：编辑器滚到别处后点页面其它位置（编辑器失焦），
  // WebKit 有时会在失焦时把内容重新按光标对齐 —— 这里同样兜一次。
  view.dom.addEventListener('blur', () => {
    const before = scroller.scrollTop
    requestAnimationFrame(() => {
      if (performance.now() < guardUntil) return
      if (Math.abs(scroller.scrollTop - before) > 1) scroller.scrollTop = before
    })
  }, true)
}

/** 创建一个 SQL 编辑器/查看器 */
export function createSqlViewer(parent, opts = {}) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc || '',
      extensions: baseExtensions(opts),
    }),
  })
  installScrollGuard(view)
  return view
}

/** 替换整个文档内容 */
export function setDoc(view, text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text ?? '' } })
}

export function getDoc(view) {
  return view.state.doc.toString()
}
