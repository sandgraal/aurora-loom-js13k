// Submission build for js13kgames: bundle + minify the game, run it through
// Roadroller (a context-modeling packer that beats DEFLATE), inline the result into
// ONE self-contained index.html (no external fonts / CDNs / services — nothing but
// the file itself), zip it with maximum deflate, and fail loudly if the zip is over
// the 13,312-byte limit. Run with `npm run build`.
//
// It builds BOTH the plain-minified and the Roadroller-packed variants, zips each,
// and keeps whichever zip is smaller — so the pack can never make things worse, and
// the build still works if Roadroller can't be fetched (offline: falls back to min).
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync, renameSync } from 'node:fs'

const LIMIT = 13312 // 13 * 1024
mkdirSync('dist', { recursive: true })

// wrap a JS body in the minimal HTML shell — same markup/styles as index.html, with
// no <script src> and no external references of any kind
function makeHtml(body) {
  return '<!doctype html><html lang=en><head><meta charset=utf-8><title>Aurora Loom</title>' +
    '<meta name=viewport content="width=device-width,initial-scale=1"><style>' +
    'html,body{margin:0;height:100%;background:#05040a;overflow:hidden}' +
    'canvas{display:block;width:100vw;height:100vh;touch-action:none}' +
    '#log{position:fixed;left:8px;bottom:8px;color:#9aa;font:11px monospace;' +
    'text-shadow:0 0 4px #000;pointer-events:none;max-width:60vw;line-height:1.4}' +
    '</style></head><body><canvas id=c></canvas><div id=log></div><script>' +
    body +
    '</script></body></html>'
}
// write the given html to dist/index.html and zip it to dist/<name>.zip; return bytes.
// After `zip -9` we re-deflate the archive with advzip (zopfli-based): same zip
// format, better-searched DEFLATE stream — typically recovers 30–100 free bytes.
// Wrapped in try/catch so a machine without advzip still builds.
function zipHtml(html, name) {
  writeFileSync('dist/index.html', html)
  rmSync(`dist/${name}.zip`, { force: true })
  execSync(`cd dist && zip -9 -X ${name}.zip index.html`, { stdio: 'ignore' })
  try { execSync(`npx --yes advzip-bin -z -4 -i 64 dist/${name}.zip`, { stdio: 'ignore' }) } catch (e) { /* keep plain zip */ }
  return statSync(`dist/${name}.zip`).size
}

// 1. bundle src/main.js (which imports src/net.js) into a single minified IIFE
let js = execSync('npx --yes esbuild src/main.js --bundle --minify --format=iife', {
  encoding: 'utf8',
  maxBuffer: 1 << 24,
})

// 1b. second minifier pass: terser squeezes 1–3% past esbuild (multi-pass compress,
// unsafe-but-sound-here transforms; no property mangling — canvas/DOM names must
// survive). Falls back to the esbuild output if terser can't run.
try {
  writeFileSync('dist/_bundle.js', js)
  execSync('npx --yes terser dist/_bundle.js -o dist/_terser.js -c passes=3,unsafe=true,pure_getters=true -m', { stdio: 'inherit' })
  const t = readFileSync('dist/_terser.js', 'utf8')
  if (t.length && t.length < js.length) js = t
  rmSync('dist/_terser.js', { force: true })
} catch (e) {
  console.warn('  (terser unavailable — using esbuild minify only:', e.message, ')')
}

// 2. candidate A — plain minified
let best = { html: makeHtml(js), zip: zipHtml(makeHtml(js), 'min'), packer: 'minify' }
renameSync('dist/min.zip', 'dist/aurora-loom.zip')
best.zipPath = 'dist/aurora-loom.zip'

// 3. candidate B — Roadroller-packed (self-evaluating). Skipped gracefully if it
//    can't run. Only adopted if its zip actually comes out smaller.
//    Default is -O1 (seconds, for iteration). `RR=2 npm run build` runs the full
//    -O2 parameter search (minutes) — use for release/submission builds only.
const rrOpt = process.env.RR === '2' ? '-O2' : '-O1'
try {
  writeFileSync('dist/_bundle.js', js)
  execSync(`npx --yes roadroller dist/_bundle.js -o dist/_packed.js ${rrOpt}`, { stdio: 'inherit' })
  const packed = readFileSync('dist/_packed.js', 'utf8')
  if (packed.length) {
    const rrHtml = makeHtml(packed)
    const rrZip = zipHtml(rrHtml, '_rr')
    if (rrZip < best.zip) {
      rmSync('dist/aurora-loom.zip', { force: true })
      renameSync('dist/_rr.zip', 'dist/aurora-loom.zip')
      best = { html: rrHtml, zip: rrZip, packer: 'roadroller', zipPath: 'dist/aurora-loom.zip' }
    } else {
      rmSync('dist/_rr.zip', { force: true })
    }
  }
} catch (e) {
  console.warn('  (roadroller unavailable — using plain minified build:', e.message, ')')
}
rmSync('dist/_bundle.js', { force: true })
rmSync('dist/_packed.js', { force: true })

// 4. make dist/index.html match the winning candidate
writeFileSync('dist/index.html', best.html)

// 5. size gate
const htmlBytes = statSync('dist/index.html').size
const spare = LIMIT - best.zip
console.log(`\n  packer       : ${best.packer}`)
console.log(`  inlined html : ${htmlBytes} bytes`)
console.log(`  zip (submit) : ${best.zip} bytes`)
console.log(`  limit        : ${LIMIT} bytes  ->  ${spare >= 0 ? spare + ' to spare ✓' : (-spare) + ' OVER ✗'}\n`)
if (best.zip > LIMIT) process.exit(1)
