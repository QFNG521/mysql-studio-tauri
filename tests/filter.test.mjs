import { buildWhere } from '../src/filter.js'

let fail = 0
const eq = (name, got, want) => {
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n   got : ${got}\n   want: ${want}`)
}

eq('单条件 =', buildWhere([{ column: 'age', op: '=', value: '18' }]), '`age` = 18')
eq('字符串加引号', buildWhere([{ column: 'name', op: '=', value: "O'Brien" }]), "`name` = 'O''Brien'")
eq('数值不加引号', buildWhere([{ column: 'id', op: '>', value: '10' }]), '`id` > 10')
eq('IS NULL 无值', buildWhere([{ column: 'age', op: 'IS NULL', value: '' }]), '`age` IS NULL')
eq('BETWEEN', buildWhere([{ column: 'age', op: 'BETWEEN', value: '10', value2: '20' }]),
   '`age` BETWEEN 10 AND 20')
eq('IN 多值', buildWhere([{ column: 'status', op: 'IN', value: 'paid, pending ,, cancelled' }]),
   "`status` IN ('paid', 'pending', 'cancelled')")
eq('AND 组合', buildWhere([
  { column: 'age', op: '>', value: '18', and: true },
  { column: 'name', op: 'LIKE', value: 'a%', and: true },
]), "`age` > 18 AND `name` LIKE 'a%'")
eq('OR 组合', buildWhere([
  { column: 'age', op: '<', value: '18', and: true },
  { column: 'vip', op: '=', value: '1', and: false },
]), '`age` < 18 OR `vip` = 1')
eq('条件不完整被跳过', buildWhere([
  { column: 'age', op: '>', value: '18', and: true },
  { column: 'name', op: '=', value: '', and: true },
  { column: 'city', op: '=', value: 'BJ', and: false },
]), "`age` > 18 OR `city` = 'BJ'")
eq('全部不完整 -> 空', buildWhere([{ column: 'age', op: '=', value: '' }]), '')
eq('反引号转义', buildWhere([{ column: 'we`ird', op: '=', value: 'x' }]), '`we``ird` = \'x\'')
eq('反斜杠转义', buildWhere([{ column: 'p', op: '=', value: 'a\\b' }]), "`p` = 'a\\\\b'")

console.log(fail ? `\n${fail} 个失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
