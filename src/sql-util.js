/** 反转义/转义标识符与字面量的小工具（拼 WHERE 条件用） */

export function q(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

/** 把单元格的字符串值转成 SQL 字面量 */
export function sqlLiteral(v) {
  if (v === null || v === undefined || v === '') return "''"
  if (/^-?\d+(\.\d+)?$/.test(v)) return v // 数值不加引号
  const escaped = v.replace(/\\/g, '\\\\').replace(/'/g, "''")
  return `'${escaped}'`
}

/** `col` = 值；NULL 要用 IS NULL（= NULL 永远不成立） */
export function eqCond(colName, v) {
  return v === null || v === undefined
    ? `${q(colName)} IS NULL`
    : `${q(colName)} = ${sqlLiteral(v)}`
}
