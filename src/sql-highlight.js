// SQL 语法高亮：编辑器与静态展示共用同一套 tag -> class 映射，
// 颜色只在 styles.css 里定义一处（.sh-*）。
import { sql, MySQL } from '@codemirror/lang-sql'
import { HighlightStyle } from '@codemirror/language'
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight'

/** 共享的 MySQL 语言实例（编辑器与静态高亮都用它解析） */
const langSupport = sql({ dialect: MySQL })
export const sqlLanguage = langSupport.language

/**
 * tag -> class。编辑器用 HighlightStyle 打这些 class，
 * 静态 HTML 用 tagHighlighter 打同样的 class，因此两者配色天然一致。
 */
const TAG_CLASS = [
  { tag: t.keyword, class: 'sh-kw' },
  { tag: t.operatorKeyword, class: 'sh-kw' },
  { tag: t.operator, class: 'sh-op' },
  { tag: t.string, class: 'sh-str' },
  { tag: t.special(t.string), class: 'sh-str' },
  { tag: t.number, class: 'sh-num' },
  { tag: t.bool, class: 'sh-atom' },
  { tag: t.null, class: 'sh-atom' },
  { tag: t.atom, class: 'sh-atom' },
  { tag: t.comment, class: 'sh-cmt' },
  { tag: t.typeName, class: 'sh-type' },
  { tag: t.standard(t.typeName), class: 'sh-type' },
  { tag: t.function(t.variableName), class: 'sh-fn' },
  { tag: t.function(t.propertyName), class: 'sh-fn' },
  { tag: t.propertyName, class: 'sh-ident' },
  { tag: t.variableName, class: 'sh-ident' },
  { tag: t.punctuation, class: 'sh-punc' },
  { tag: t.separator, class: 'sh-punc' },
  { tag: t.paren, class: 'sh-punc' },
  { tag: t.bracket, class: 'sh-punc' },
  { tag: t.meta, class: 'sh-meta' },
]

/** 给 CodeMirror 编辑器用的高亮样式（必须配合 syntaxHighlighting 使用） */
export const sqlHighlightStyle = HighlightStyle.define(TAG_CLASS)

/** 给静态 HTML 用的 highlighter（不加 all，未命中的 token 就不带 class） */
const staticHighlighter = tagHighlighter(TAG_CLASS)

/**
 * 把 SQL 文本转成带高亮 class 的 HTML（用于列表预览等不需要编辑器的地方）
 */
export function highlightSqlToHtml(code) {
  if (!code) return ''
  let html = ''
  try {
    const tree = sqlLanguage.parser.parse(code)
    highlightCode(
      code,
      tree,
      staticHighlighter,
      (text, classes) => {
        html += classes ? `<span class="${classes}">${esc(text)}</span>` : esc(text)
      },
      () => { html += '\n' },
    )
  } catch {
    return esc(code)
  }
  return html
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
