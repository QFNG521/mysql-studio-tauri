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
  '&': { backgroundColor: '#ffffff', color: '#1f2328' },
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

/** 创建一个 SQL 编辑器/查看器 */
export function createSqlViewer(parent, opts = {}) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc || '',
      extensions: baseExtensions(opts),
    }),
  })
  return view
}

/** 替换整个文档内容 */
export function setDoc(view, text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text ?? '' } })
}

export function getDoc(view) {
  return view.state.doc.toString()
}
