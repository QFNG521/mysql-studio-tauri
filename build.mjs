// 用 esbuild 打包前端（vite 在本机内存受限环境易被杀，esbuild 更轻量）
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'

mkdirSync('dist', { recursive: true })

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: 'es2021',
  minify: true,
  outfile: 'dist/assets/app.js',
  logLevel: 'info',
})

let html = readFileSync('index.html', 'utf8')
html = html.replace(
  '<script type="module" src="/src/main.js"></script>',
  '    <link rel="stylesheet" href="./assets/app.css" />\n    <script type="module" src="./assets/app.js"></script>',
)
writeFileSync('dist/index.html', html)
console.log('dist/index.html written')
