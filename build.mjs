// Submission build for js13kgames: bundle + minify the game into ONE
// self-contained index.html (no external fonts / CDNs / services — nothing but
// the file itself), zip it with maximum deflate, and fail loudly if the zip is
// over the 13,312-byte limit. Run with `npm run build`.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs'

const LIMIT = 13312 // 13 * 1024

mkdirSync('dist', { recursive: true })

// 1. bundle src/main.js (which imports src/net.js) into a single minified IIFE
const js = execSync('npx --yes esbuild src/main.js --bundle --minify --format=iife', {
  encoding: 'utf8',
  maxBuffer: 1 << 24,
})

// 2. inline into a minimal HTML shell — same markup/styles as index.html, no
//    <script src>, no external references of any kind
const html =
  '<!doctype html><html lang=en><head><meta charset=utf-8><title>Aurora Loom</title>' +
  '<meta name=viewport content="width=device-width,initial-scale=1"><style>' +
  'html,body{margin:0;height:100%;background:#05040a;overflow:hidden}' +
  'canvas{display:block;width:100vw;height:100vh;touch-action:none}' +
  '#log{position:fixed;left:8px;bottom:8px;color:#9aa;font:11px monospace;' +
  'text-shadow:0 0 4px #000;pointer-events:none;max-width:60vw;line-height:1.4}' +
  '</style></head><body><canvas id=c></canvas><div id=log></div><script>' +
  js +
  '</script></body></html>'
writeFileSync('dist/index.html', html)

// 3. zip -9 (X strips extra file attributes to save a few bytes)
rmSync('dist/aurora-loom.zip', { force: true })
execSync('cd dist && zip -9 -X aurora-loom.zip index.html', { stdio: 'inherit' })

// 4. size gate
const htmlBytes = statSync('dist/index.html').size
const zipBytes = statSync('dist/aurora-loom.zip').size
const spare = LIMIT - zipBytes
console.log(`\n  inlined html : ${htmlBytes} bytes`)
console.log(`  zip (submit) : ${zipBytes} bytes`)
console.log(`  limit        : ${LIMIT} bytes  ->  ${spare >= 0 ? spare + ' to spare ✓' : (-spare) + ' OVER ✗'}\n`)
if (zipBytes > LIMIT) process.exit(1)
