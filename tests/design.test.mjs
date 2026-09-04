// 表设计器 DDL 生成逻辑单测（纯函数，不依赖 DOM / Tauri）
// 运行：npm test
import assert from 'node:assert/strict'
import {
  buildCreateSql,
  buildAlterSql,
  collectDanger,
  columnDefChanged,
  columnDefFragment,
  groupIndexes,
  groupForeignKeys,
} from '../src/tabs-design.js'

let pass = 0
function ok(name, fn) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e) { console.log('FAIL', name, '\n  ', e.message) }
}

// ---------- 建表 ----------
ok('建表：主键+自增+注释', () => {
  const sql = buildCreateSql('testdb', {
    table: 't1', engine: 'InnoDB', charset: 'utf8mb4', comment: '用户扩展表',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, isPk: true, autoInc: true, comment: '主键', defaultMode: '', defaultValue: '' },
      { name: 'nick', type: 'varchar(50)', nullable: true, isPk: false, autoInc: false, comment: '昵称', defaultMode: 'NULL', defaultValue: '' },
    ],
    indexes: [], fks: [],
  })
  assert.ok(sql.includes('CREATE TABLE `testdb`.`t1` ('), sql)
  assert.ok(sql.includes('`id` bigint NOT NULL AUTO_INCREMENT COMMENT \'主键\''), sql)
  assert.ok(sql.includes('`nick` varchar(50) NULL DEFAULT NULL COMMENT \'昵称\''), sql)
  assert.ok(sql.includes('PRIMARY KEY (`id`)'), sql)
  assert.ok(sql.includes("COMMENT '用户扩展表'"), sql)
  assert.ok(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT '用户扩展表';$/.test(sql), sql)
})

ok('建表：默认值为数字不加引号、字符串加引号', () => {
  const sql = buildCreateSql('db', {
    table: 't', engine: 'InnoDB', charset: 'utf8mb4', comment: '',
    columns: [
      { name: 'cnt', type: 'int', nullable: false, isPk: false, autoInc: false, comment: '', defaultMode: 'VALUE', defaultValue: '0' },
      { name: 'st', type: 'varchar(10)', nullable: false, isPk: false, autoInc: false, comment: '', defaultMode: 'VALUE', defaultValue: "O'Brien" },
    ],
    indexes: [], fks: [],
  })
  assert.ok(sql.includes('`cnt` int NOT NULL DEFAULT 0'), sql)
  assert.ok(sql.includes("`st` varchar(10) NOT NULL DEFAULT 'O''Brien'"), sql)
})

ok('建表：索引与外键', () => {
  const sql = buildCreateSql('testdb', {
    table: 'orders2', engine: 'InnoDB', charset: 'utf8mb4', comment: '',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, isPk: true, autoInc: true, comment: '', defaultMode: '', defaultValue: '' },
      { name: 'user_id', type: 'int', nullable: false, isPk: false, autoInc: false, comment: '', defaultMode: '', defaultValue: '' },
    ],
    indexes: [{ origName: null, name: 'idx_user', columns: 'user_id', unique: false, method: 'BTREE' }],
    fks: [{ origName: null, name: 'fk_o_user', column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE', onUpdate: 'RESTRICT' }],
  })
  assert.ok(sql.includes('KEY `idx_user` (`user_id`)'), sql)
  assert.ok(sql.includes('CONSTRAINT `fk_o_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT'), sql)
})

ok('建表：多列主键、列名反引号转义', () => {
  const sql = buildCreateSql('db', {
    table: 'we`ird', engine: 'InnoDB', charset: 'utf8mb4', comment: '',
    columns: [
      { name: 'a`b', type: 'int', nullable: false, isPk: true, autoInc: false, comment: '', defaultMode: '', defaultValue: '' },
      { name: 'c', type: 'int', nullable: false, isPk: true, autoInc: false, comment: '', defaultMode: '', defaultValue: '' },
    ],
    indexes: [], fks: [],
  })
  assert.ok(sql.includes('`a``b`'), sql)
  assert.ok(sql.includes('`we``ird`'), sql)
  assert.ok(sql.includes('PRIMARY KEY (`a``b`,`c`)'), sql)
})

// ---------- 改表 ----------
const ORIG = {
  columns: [
    { name: 'id', column_type: 'bigint', data_type: 'bigint', nullable: false, is_pk: true, is_auto_inc: true, default: null, comment: '主键', charset: null, collation: null },
    { name: 'name', column_type: 'varchar(50)', data_type: 'varchar', nullable: true, is_pk: false, is_auto_inc: false, default: null, comment: '', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
    { name: 'old_col', column_type: 'int', data_type: 'int', nullable: true, is_pk: false, is_auto_inc: false, default: null, comment: '', charset: null, collation: null },
  ],
  indexes: [
    { name: 'PRIMARY', non_unique: false, seq: 1, column: 'id', index_type: 'BTREE' },
    { name: 'idx_name', non_unique: true, seq: 1, column: 'name', index_type: 'BTREE' },
  ],
  foreign_keys: [],
  pk_columns: ['id'],
  engine: 'InnoDB', comment: '',
}

function col(name, type, over = {}) {
  return { origName: name, name, type, nullable: true, isPk: false, autoInc: false, comment: '', defaultMode: '', defaultValue: '', ...over }
}

ok('改表：无变化生成空串', () => {
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [
      col('id', 'bigint', { nullable: false, isPk: true, autoInc: true, comment: '主键' }),
      col('name', 'varchar(50)'),
      col('old_col', 'int'),
    ],
    indexes: groupIndexes(ORIG.indexes),
    fks: [],
  }
  assert.equal(buildAlterSql('db', spec, ORIG), '')
  assert.deepEqual(collectDanger(spec, ORIG), [])
})

ok('改表：改类型生成 MODIFY', () => {
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [col('id', 'bigint', { nullable: false, isPk: true, autoInc: true, comment: '主键' }), col('name', 'varchar(100)'), col('old_col', 'int')],
    indexes: groupIndexes(ORIG.indexes), fks: [],
  }
  const sql = buildAlterSql('db', spec, ORIG)
  assert.ok(sql.includes('ALTER TABLE `db`.`t`'), sql)
  assert.ok(sql.includes('MODIFY COLUMN `name` varchar(100) NULL'), sql)
  assert.ok(!sql.includes('DROP'), sql)
})

ok('改表：加列 / 删列 / 危险提示', () => {
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [
      col('id', 'bigint', { nullable: false, isPk: true, autoInc: true, comment: '主键' }),
      col('name', 'varchar(50)'),
      col('new_col', 'datetime', { origName: null, defaultMode: 'CURRENT_TIMESTAMP' }),
    ],
    indexes: groupIndexes(ORIG.indexes), fks: [],
  }
  const sql = buildAlterSql('db', spec, ORIG)
  assert.ok(sql.includes('ADD COLUMN `new_col` datetime NULL DEFAULT CURRENT_TIMESTAMP'), sql)
  assert.ok(sql.includes('DROP COLUMN `old_col`'), sql)
  assert.deepEqual(collectDanger(spec, ORIG), ['删除列 `old_col`（该列数据将丢失）'])
})

ok('改表：改名生成 CHANGE', () => {
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [
      col('id', 'bigint', { nullable: false, isPk: true, autoInc: true, comment: '主键' }),
      col('username', 'varchar(50)', { origName: 'name' }),
      col('old_col', 'int'),
    ],
    indexes: groupIndexes(ORIG.indexes), fks: [],
  }
  const sql = buildAlterSql('db', spec, ORIG)
  assert.ok(sql.includes('CHANGE COLUMN `name` `username` varchar(50) NULL'), sql)
  assert.ok(!sql.includes('DROP COLUMN `name`'), sql)
})

ok('改表：主键变化', () => {
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [
      col('id', 'bigint', { nullable: true }), // 撤掉主键
      col('name', 'varchar(50)', { isPk: true, nullable: false }),
      col('old_col', 'int'),
    ],
    indexes: groupIndexes(ORIG.indexes), fks: [],
  }
  const sql = buildAlterSql('db', spec, ORIG)
  assert.ok(sql.includes('DROP PRIMARY KEY'), sql)
  assert.ok(sql.includes('ADD PRIMARY KEY (`name`)'), sql)
  assert.ok(collectDanger(spec, ORIG).some((s) => s.includes('主键')), sql)
})

ok('改表：索引增删改', () => {
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [col('id', 'bigint', { nullable: false, isPk: true, autoInc: true, comment: '主键' }), col('name', 'varchar(50)'), col('old_col', 'int')],
    indexes: [
      { origName: 'idx_name', name: 'idx_name', columns: 'name', unique: true, method: 'BTREE' }, // 普通变唯一
      { origName: null, name: 'idx_new', columns: 'old_col', unique: false, method: 'BTREE' },
    ],
    fks: [],
  }
  const sql = buildAlterSql('db', spec, ORIG)
  assert.ok(sql.includes('DROP INDEX `idx_name`'), sql)
  assert.ok(sql.includes('ADD UNIQUE KEY `idx_name` (`name`)'), sql)
  assert.ok(sql.includes('ADD KEY `idx_new` (`old_col`)'), sql)
})

ok('改表：索引没变不生成子句', () => {
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [col('id', 'bigint', { nullable: false, isPk: true, autoInc: true, comment: '主键' }), col('name', 'varchar(50)'), col('old_col', 'int')],
    indexes: groupIndexes(ORIG.indexes),
    fks: [],
  }
  const sql = buildAlterSql('db', spec, ORIG)
  assert.ok(!sql.includes('INDEX'), sql)
})

ok('改表：外键增删', () => {
  const orig = {
    ...ORIG,
    foreign_keys: [{ name: 'fk_old', column: 'old_col', ref_db: 'testdb', ref_table: 'users', ref_column: 'id', on_update: 'CASCADE', on_delete: 'CASCADE' }],
  }
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [col('id', 'bigint', { nullable: false, isPk: true, autoInc: true, comment: '主键' }), col('name', 'varchar(50)'), col('old_col', 'int')],
    indexes: [],
    fks: [{ origName: null, name: 'fk_new', column: 'name', refTable: 'users', refColumn: 'name', onDelete: 'SET NULL', onUpdate: 'CASCADE' }],
  }
  const sql = buildAlterSql('db', spec, orig)
  assert.ok(sql.includes('DROP FOREIGN KEY `fk_old`'), sql)
  assert.ok(sql.includes('ADD CONSTRAINT `fk_new` FOREIGN KEY (`name`) REFERENCES `users` (`name`) ON DELETE SET NULL ON UPDATE CASCADE'), sql)
})

ok('改表：groupForeignKeys 载入后不变不生成子句', () => {
  const orig = {
    ...ORIG,
    foreign_keys: [{ name: 'fk1', column: 'name', ref_db: 'testdb', ref_table: 'users', ref_column: 'name', on_update: 'CASCADE', on_delete: 'SET NULL' }],
  }
  const spec = {
    table: 't', engine: 'InnoDB', comment: '',
    columns: [col('id', 'bigint', { nullable: false, isPk: true, autoInc: true, comment: '主键' }), col('name', 'varchar(50)'), col('old_col', 'int')],
    indexes: groupIndexes(ORIG.indexes),
    fks: groupForeignKeys(orig.foreign_keys),
  }
  assert.equal(buildAlterSql('db', spec, orig), '')
})

ok('columnDefChanged：语义比较不误报', () => {
  const orig = { column_type: 'VARCHAR(50)', nullable: true, is_auto_inc: false, comment: '', default: null }
  assert.equal(columnDefChanged(col('name', 'varchar(50)'), orig), false) // 类型大小写不同但等价
  assert.equal(columnDefChanged(col('name', 'varchar(50)', { nullable: false }), orig), true)
  assert.equal(columnDefChanged(col('name', 'varchar(50)', { defaultMode: 'VALUE', defaultValue: 'abc' }), { ...orig, default: 'abc' }), false)
  assert.equal(columnDefChanged(col('name', 'varchar(50)', { defaultMode: 'VALUE', defaultValue: 'x' }), { ...orig, default: 'abc' }), true)
})

ok('主键列强制 NOT NULL（MySQL 要求）', () => {
  const frag = columnDefFragment(col('nick', 'varchar(80)', { isPk: true, nullable: true }))
  assert.ok(frag.includes('NOT NULL'), frag)
  assert.ok(!/(^| )NULL( |$)/.test(frag.replace('NOT NULL', '')), frag)
})

console.log(`\n${pass} 通过`)
const TOTAL = 15
if (pass !== TOTAL) { console.log('有失败用例！'); process.exit(1) }
