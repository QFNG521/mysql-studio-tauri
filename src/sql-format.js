// SQL 文本处理：语句切分、简化（压缩成一行）、美化（格式化）。
// 所有扫描都会跳过字符串字面量与注释，避免把 'a;b' 里的分号当成语句分隔，
// 或把注释里的关键字当成子句。

const QUOTE_CHARS = "'\"`"

/** 从引号 i 处扫到闭合引号之后，返回结束下标（未闭合则到结尾） */
function skipQuoted(s, i) {
  const q = s[i]
  let j = i + 1
  while (j < s.length) {
    const c = s[j]
    if (c === '\\' && q !== '`') { j += 2; continue }
    if (c === q) {
      if (s[j + 1] === q) { j += 2; continue } // '' 转义
      return j + 1
    }
    j++
  }
  return s.length
}

/** 判断 i 处是否是注释起点，是则返回结束下标，否则返回 -1 */
function commentEnd(s, i) {
  const c = s[i]
  if (c === '-' && s[i + 1] === '-') {
    const nl = s.indexOf('\n', i)
    return nl < 0 ? s.length : nl
  }
  if (c === '#') {
    const nl = s.indexOf('\n', i)
    return nl < 0 ? s.length : nl
  }
  if (c === '/' && s[i + 1] === '*') {
    const e = s.indexOf('*/', i + 2)
    return e < 0 ? s.length : e + 2
  }
  return -1
}

/**
 * 按顶层分号切分语句（忽略字符串 / 注释里的分号）
 * @returns {{start:number,end:number,text:string}[]} 已去掉首尾空白的精确范围
 */
export function splitStatements(sql) {
  const out = []
  const n = sql.length
  let start = 0
  let i = 0
  const push = (end) => {
    const raw = sql.slice(start, end)
    const lead = raw.match(/^\s*/)[0].length
    const trail = raw.match(/\s*$/)[0].length
    const s = start + lead
    const e = end - trail
    if (e > s) out.push({ start: s, end: e, text: sql.slice(s, e) })
  }
  while (i < n) {
    const c = sql[i]
    if (QUOTE_CHARS.includes(c)) { i = skipQuoted(sql, i); continue }
    const ce = commentEnd(sql, i)
    if (ce >= 0) { i = ce; continue }
    if (c === ';') { push(i); start = i + 1; i++; continue }
    i++
  }
  push(n)
  return out
}

/** 取光标位置所在的语句（找不到时退回最近的一条） */
export function statementAt(sql, pos) {
  const list = splitStatements(sql)
  if (!list.length) return null
  for (const s of list) {
    if (pos >= s.start && pos <= s.end) return s
  }
  // 落在两条语句之间的空白处：取前面最近的一条
  let prev = null
  for (const s of list) {
    if (s.end <= pos) prev = s
  }
  return prev || list[0]
}

/** 简化 SQL：去注释、压缩空白，压成一行（便于复制/贴到日志） */
export function simplifySql(sql) {
  // 代码段与字符串段分开处理：空白/标点的压缩只作用于代码段，
  // 否则 'a   b' 这种字面量会被一起压掉。
  const segs = []
  let buf = ''
  const flushCode = () => { if (buf) { segs.push({ code: true, text: buf }); buf = '' } }
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (QUOTE_CHARS.includes(c)) {
      const e = skipQuoted(sql, i)
      flushCode()
      segs.push({ code: false, text: sql.slice(i, e) })
      i = e
      continue
    }
    const ce = commentEnd(sql, i)
    if (ce >= 0) {
      if (buf && !buf.endsWith(' ')) buf += ' '
      i = ce
      continue
    }
    if (/\s/.test(c)) {
      if (buf && !buf.endsWith(' ')) buf += ' '
      i++
      continue
    }
    buf += c
    i++
  }
  flushCode()
  return segs
    .map((s) => (s.code
      ? s.text
        .replace(/\s*,\s*/g, ', ')
        .replace(/\s*\(\s*/g, '(')
        .replace(/\s*\)/g, ')')
        .replace(/\s*;\s*/g, '; ')
      : s.text))
    .join('')
    .trim()
}

// ---------------------------------------------------------------------------
// 美化（格式化）
// ---------------------------------------------------------------------------

/** 需要大写的保留字（不含函数，函数名保持原样） */
const KEYWORDS = new Set(`SELECT FROM WHERE AND OR NOT IN IS NULL LIKE BETWEEN GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET
JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AS DISTINCT UNION ALL INSERT INTO VALUES UPDATE SET DELETE
CASE WHEN THEN ELSE END EXISTS BETWEEN ASC DESC WITH RETURNING INTERVAL YEAR MONTH DAY HOUR MINUTE SECOND`
  .split(/\s+/).filter(Boolean))

/** 顶格换行的子句 */
const CLAUSES = [
  'UNION ALL', 'UNION', 'INSERT INTO', 'DELETE FROM', 'GROUP BY', 'ORDER BY',
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'UPDATE', 'SET', 'RETURNING',
]

/** 顶格换行的 JOIN */
const JOINS = ['LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'CROSS JOIN', 'JOIN']

const OP_CHARS = '=<>!+-*/%|'

/** 切成 token：字符串/注释整体保留，其余按空白与符号拆开 */
function tokenize(sql) {
  const tokens = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (QUOTE_CHARS.includes(c)) {
      const e = skipQuoted(sql, i)
      tokens.push({ kind: 'lit', value: sql.slice(i, e) })
      i = e
      continue
    }
    const ce = commentEnd(sql, i)
    if (ce >= 0) {
      tokens.push({ kind: 'cmt', value: sql.slice(i, ce) })
      i = ce
      continue
    }
    if (/\s/.test(c)) { i++; continue }
    if ('(),;'.includes(c)) {
      tokens.push({ kind: 'punc', value: c })
      i++
      continue
    }
    if (OP_CHARS.includes(c)) {
      let j = i
      while (j < n && OP_CHARS.includes(sql[j])) j++
      tokens.push({ kind: 'op', value: sql.slice(i, j) })
      i = j
      continue
    }
    let j = i
    while (j < n && !/\s/.test(sql[j]) && !'(),;'.includes(sql[j]) && !OP_CHARS.includes(sql[j]) &&
      !QUOTE_CHARS.includes(sql[j]) && commentEnd(sql, j) < 0) j++
    tokens.push({ kind: 'word', value: sql.slice(i, j) })
    i = j
  }
  return tokens
}

/** 把 "GROUP BY" / "LEFT JOIN" 这类多词短语合并成一个 token，便于整段判断换行 */
function mergePhrases(tokens, phrases) {
  const multi = phrases.filter((p) => p.includes(' ')).map((p) => p.split(' '))
  const out = []
  let i = 0
  while (i < tokens.length) {
    let matched = null
    for (const words of multi) {
      const ok = words.every((w, k) => {
        const t = tokens[i + k]
        return t && t.kind === 'word' && t.value.toUpperCase() === w
      })
      if (ok) { matched = words; break }
    }
    if (matched) {
      out.push({ kind: 'word', value: matched.join(' ') })
      i += matched.length
    } else {
      out.push(tokens[i])
      i++
    }
  }
  return out
}

/**
 * 美化 SQL：关键字大写、主要子句顶格换行、AND/OR 与 SELECT 列表缩进。
 * 不做完整的语法树解析，覆盖日常手写 SQL 的排版即可。
 */
export function formatSql(sql) {
  const tokens = mergePhrases(tokenize(sql), [...CLAUSES, ...JOINS])
  const lines = []
  let cur = ''
  let depth = 0
  let section = ''
  let indent = 0

  const flush = () => {
    if (cur.trim()) lines.push(cur.replace(/\s+$/, ''))
    cur = ''
  }
  const newline = (pad) => {
    flush()
    cur = ' '.repeat(pad)
    indent = pad
  }
  const upper = (t) => (t.kind === 'word' && KEYWORDS.has(t.value.toUpperCase()) ? t.value.toUpperCase() : t.value)

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const v = upper(t)

    if (t.kind === 'lit' || t.kind === 'cmt') {
      if (cur && !/\s$/.test(cur) && !cur.endsWith('(') && !cur.endsWith('.')) cur += ' '
      cur += t.value
      continue
    }

    if (t.kind === 'punc') {
      if (v === '(') {
        cur = cur.replace(/\s+$/, '') + '('
        depth++
        continue
      }
      if (v === ')') {
        depth = Math.max(0, depth - 1)
        cur = cur.replace(/[\s,]+$/, '') + ')'
        continue
      }
      if (v === ',') {
        cur = cur.replace(/\s+$/, '') + ','
        if (depth === 0 && section === 'SELECT') newline(2)
        else cur += ' '
        continue
      }
      if (v === ';') {
        cur = cur.replace(/\s+$/, '') + ';'
        flush()
        section = ''
        continue
      }
    }

    if (t.kind === 'op') {
      if (cur && !/[\s(.]$/.test(cur)) cur += ' '
      cur += v + ' '
      continue
    }

    // 词
    const up = v.toUpperCase()
    if (depth === 0) {
      if (CLAUSES.includes(up)) {
        newline(0)
        cur += up
        section = up.split(' ')[0]
        continue
      }
      if (JOINS.includes(up)) {
        newline(0)
        cur += up + ' '
        section = 'JOIN'
        continue
      }
      if (up === 'AND' || up === 'OR') {
        newline(2)
        cur += up + ' '
        continue
      }
    }

    // 普通词：补一个空格（括号后 / 点号 / 行首除外）
    if (cur && !/[\s(.]$/.test(cur)) cur += ' '
    cur += v
    if (up === 'SELECT' && depth === 0 && section !== 'SELECT') section = 'SELECT'
  }
  flush()

  return lines
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, idx, arr) => l.trim() !== '' || (idx > 0 && arr[idx - 1].trim() !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
