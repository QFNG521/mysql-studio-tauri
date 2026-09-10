/**
 * 守卫测试：页面模板里的 data-act / data-ref 与代码里 A('x') / R('x') 必须一一对应。
 *
 * 背景：查询页曾经因为改布局时删掉了「结果 ▾」按钮的 HTML，而 A('results-toggle').onclick
 * 仍在，赋值到 null 上抛 TypeError，导致该按钮之后的所有按钮绑定全部中断（点击无反应）。
 * 这类问题在运行时才暴露，这里用静态扫描提前拦住。
 */
import { readFileSync, readdirSync } from 'node:fs'

const FILES = [
  'tabs-query.js',
  'tabs-queries.js',
  'tabs-data.js',
  'tabs-design.js',
  'tabs-struct.js',
  'tabs-tables.js',
  'conn.js',
]

const collect = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]))

let failed = 0
const fail = (msg) => { console.error('  ✗ ' + msg); failed++ }

for (const f of FILES) {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  const acts = collect(src, /data-act="([\w-]+)"/g)
  const refs = collect(src, /data-ref="([\w-]+)"/g)
  const usedActs = collect(src, /\bA\(['"`]([\w-]+)['"`]\)/g)
  const usedRefs = collect(src, /\bR\(['"`]([\w-]+)['"`]\)/g)

  for (const a of usedActs) {
    if (!acts.has(a)) fail(`${f}: 代码绑定了 A('${a}')，但模板里没有 data-act="${a}"`)
  }
  for (const r of usedRefs) {
    if (!refs.has(r)) fail(`${f}: 代码取用了 R('${r}')，但模板里没有 data-ref="${r}"`)
  }
  console.log(`  ${f}: act ${acts.size}(绑定 ${usedActs.size}) / ref ${refs.size}(取用 ${usedRefs.size})`)
}

// 同样的思路：用了 Tauri 插件 API 却忘了 import，运行时会抛 ReferenceError，
// 而 async 函数里的 rejection 又会被静默吞掉 —— 表现为「点了按钮没反应」。
const PLUGIN_APIS = [
  { pkg: '@tauri-apps/plugin-dialog', names: ['open', 'save', 'ask', 'confirm', 'message'] },
  { pkg: '@tauri-apps/api/core', names: ['invoke'] },
]

const ALL_JS = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'))

for (const f of ALL_JS) {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  for (const { pkg, names } of PLUGIN_APIS) {
    const imported = new Set(
      [...src.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${pkg.replace('/', '\\/')}'`, 'g'))]
        .flatMap((m) => m[1].split(','))
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean),
    )
    for (const n of names) {
      const used = new RegExp(`(?<![\\w.$])${n}\\s*\\(`).test(src)
      // 文件里自己声明了同名函数/变量时是合法用法（例如 tree.js 里有个本地 open()）
      const declaredLocally =
        new RegExp(`function\\s+${n}\\b`).test(src) ||
        new RegExp(`(?:const|let|var)\\s+${n}\\s*=`).test(src) ||
        new RegExp(`[(,]\\s*${n}\\s*[,)]`).test(src) // 函数参数同名（tree.js 的 renderGroupNode(..., open)）
      if (used && !imported.has(n) && !declaredLocally) {
        fail(`${f}: 调用了 ${n}() 但没有从 '${pkg}' 导入它`)
      }
    }
  }
}

if (failed) {
  console.error(`\ndom-refs: ${failed} 处不匹配`)
  process.exit(1)
}
console.log('dom-refs: OK（data-act / data-ref 与插件 API 导入均已就位）')
