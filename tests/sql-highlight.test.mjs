// 静态 SQL 高亮单测（纯函数，node 直接跑）
import { highlightSqlToHtml } from '../src/sql-highlight.js'

let fail = 0
const check = (name, cond, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  ' + extra}`)
}

const html = highlightSqlToHtml(
  "SELECT `id`, 'a''b' FROM users WHERE age >= 18 -- 注释\n/* block */ AND name LIKE '张%';",
)

check('关键字被标注', /<span class="sh-kw">SELECT<\/span>/.test(html), html.slice(0, 160))
check('字符串被标注', /class="sh-str"/.test(html), html)
check('数字被标注', /class="sh-num">18</.test(html), html)
check('行注释被标注', /class="sh-cmt">-- 注释</.test(html), html)
check('块注释被标注', /class="sh-cmt">\/\* block \*\//.test(html), html)
check('换行保留', html.split('\n').length === 2, JSON.stringify(html.split('\n').length))
check('HTML 被转义', highlightSqlToHtml('SELECT "<b>"').includes('&lt;b&gt;'), highlightSqlToHtml('SELECT "<b>"'))
check('空串返回空', highlightSqlToHtml('') === '')
check('null 返回空', highlightSqlToHtml(null) === '')

// 中文/反引号不应破坏结构
const cn = highlightSqlToHtml('SELECT `姓名` FROM `订单` WHERE 状态 = \'完成\'')
check('中文标识符可用', cn.includes('姓名') && cn.includes('订单'), cn)

console.log(fail ? `\n${fail} 个失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
