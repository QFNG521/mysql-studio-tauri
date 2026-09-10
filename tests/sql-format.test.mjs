import assert from 'node:assert/strict'
import { splitStatements, statementAt, simplifySql, formatSql } from '../src/sql-format.js'

let pass = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS ' + name) }
  catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1 }
}

t('切分：忽略字符串与注释里的分号', () => {
  const sql = "SELECT 'a;b' FROM t; -- x;y\nSELECT 2;"
  const list = splitStatements(sql)
  assert.equal(list.length, 2)
  assert.equal(list[0].text, "SELECT 'a;b' FROM t")
  // 语句前的注释归属它后面那条语句
  assert.equal(list[1].text, '-- x;y\nSELECT 2')
})

t('切分：最后一条没有分号也要收进来', () => {
  const list = splitStatements('SELECT 1; SELECT 2')
  assert.equal(list.length, 2)
  assert.equal(list[1].text, 'SELECT 2')
})

t('statementAt：光标落在第二条语句上', () => {
  const sql = 'SELECT 1;\nSELECT 2 FROM t;'
  const s = statementAt(sql, sql.indexOf('SELECT 2') + 3)
  assert.equal(s.text, 'SELECT 2 FROM t')
})

t('简化：去注释、压缩空白', () => {
  const sql = `-- 注释\nSELECT   a, b\nFROM t  /* 块注释 */ WHERE a = 'x   y';`
  const out = simplifySql(sql)
  assert.equal(out, "SELECT a, b FROM t WHERE a = 'x   y';")
  assert.ok(!out.includes('--'))
})

t('简化：保留字符串内部内容不变', () => {
  assert.equal(simplifySql("SELECT  'a ,  b'"), "SELECT 'a ,  b'")
})

t('美化：子句顶格换行 + 关键字大写', () => {
  const out = formatSql("select u.id,u.name,count(o.id) cnt from users u where o.status='paid' and o.amount>100 group by u.id order by cnt desc limit 10;")
  const lines = out.split('\n')
  assert.equal(lines[0], 'SELECT u.id,')
  assert.equal(lines[1], '  u.name,')
  assert.equal(lines[2], '  count(o.id) cnt')
  assert.equal(lines[3], 'FROM users u')
  assert.ok(out.includes("\nWHERE o.status = 'paid'"))
  assert.ok(out.includes('\n  AND o.amount > 100'))
  assert.ok(out.includes('\nGROUP BY u.id'))
  assert.ok(out.includes('\nORDER BY cnt DESC'))
  assert.ok(out.endsWith('LIMIT 10;'))
})

t('美化：LEFT JOIN 不被拆成两行', () => {
  const out = formatSql('select * from users u left join orders o on o.user_id=u.id')
  assert.ok(out.includes('\nLEFT JOIN orders o ON o.user_id = u.id'), out)
})

t('美化：子查询（括号内）不额外换行', () => {
  const out = formatSql('select id from t where id in (select tid from x) and ok=1')
  assert.ok(out.includes('IN(SELECT tid FROM x)'), out)
})

t('美化：字符串原样保留', () => {
  const out = formatSql("select 'a -- b' from t")
  assert.ok(out.includes("'a -- b'"), out)
})

console.log(`\n${pass} 通过`)
