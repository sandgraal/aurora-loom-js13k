import { connectRelay, todaysRoom } from './net.js'

// ---------- canvas setup ----------
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')
const logEl = document.getElementById('log')
let W, H, CX, CY
function resize() {
  W = canvas.width = innerWidth * devicePixelRatio
  H = canvas.height = innerHeight * devicePixelRatio
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  CX = innerWidth / 2; CY = innerHeight / 2
}
addEventListener('resize', resize)
resize()

// ---------- world / camera ----------
// The playfield is a world centered on the screen. As the super-piles gain
// ground it GROWS (worldScale climbs) and the camera zooms out to keep it framed,
// so the corruption visibly claims territory you used to own. Everything in the
// simulation lives in world coords; only the sky, vignette and HUD are drawn in
// raw screen space. worldScale eases toward a target set by pile pressure.
let worldScale = 1, worldScaleTarget = 1, zoom = 1
function wBounds() {
  const HW = (innerWidth / 2) * worldScale, HH = (innerHeight / 2) * worldScale
  return [CX - HW, CX + HW, CY - HH, CY + HH]
}
// screen pixel -> world coord (input lands where you actually clicked, at any zoom)
function toWorld(px, py) { return { x: CX + (px - CX) / zoom, y: CY + (py - CY) / zoom } }

// ---------- live tuning ----------
// Every knob the simulation reads lives here so the on-screen panel (buildPanel,
// bottom of file) can reshape the piece while it runs. DEFAULTS backs the reset.
const DEFAULTS = {
  floor: 8,    // never fewer than this many unicorns
  trigger: 8,  // a corner turns into a super-pile once this many die in it
  hunger: 15,  // the eye's reach — how close is fatal
  lure: 1,     // how hard the cross/horns tug the herd
  pull: 1,     // how hard super-piles drag the living in
  weep: 1,     // how often the eye weeps acid
  creep: 1,    // how far piles spread inward as they grow
  zcap: 2.4,   // how far the world is allowed to zoom out
  rot: 1,      // how fast the eye inflames (bloodshot ramp speed)
  vrate: 0.5,  // the eye's voice: speed (low = slow, laid-back drawl)
  vpitch: 0.18,// the eye's voice: pitch (low = deep/warm)
  grit: 0.6,   // gravel under the voice: growl + vinyl-crackle amount
}
const cfg = { ...DEFAULTS }

// ---------- deterministic per-room world ----------
// One seed for everyone in the same relay room, so the stars, the nebula bands,
// the eye's bloodshot capillaries and the starting palette are unique-but-shared:
// two people in the same room see the same sky; a different room is a different
// sky. Pure generation from a string — no stored assets, and it costs a handful
// of bytes. mulberry32 + a cheap string hash.
const ROOM = todaysRoom()
function strSeed(s) {
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19 }
  return h >>> 0
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rng = mulberry32(strSeed(ROOM))
// starfield: positions as viewport fractions so they survive resize
const stars = Array.from({ length: 150 }, () => ({
  x: rng(), y: rng() * 0.95, r: 0.4 + rng() * 1.4, tw: rng() * 6.28, sp: 0.5 + rng() * 2.2,
}))
// a few slow nebula bands, each with its own drift and hue
const bands = Array.from({ length: 3 }, () => ({
  hue: rng() * 360, y: 0.12 + rng() * 0.6, amp: 0.05 + rng() * 0.1,
  ph: rng() * 6.28, sp: 0.00002 + rng() * 0.00004,
}))
// the eye's capillaries — a seeded jittered walk out from the inner corner, in
// eye-local space (roughly -1..1 x, -0.5..0.5 y). Generated once so they stay put.
function genCap() {
  const pts = []
  let x = -0.9 + rng() * 0.12, y = (rng() - 0.5) * 0.12, ang = rng() * 0.8 - 0.4
  const steps = 4 + (rng() * 5 | 0)
  for (let i = 0; i < steps; i++) {
    pts.push([x, y])
    ang += (rng() - 0.5) * 0.9
    const st = 0.12 + rng() * 0.1
    x += Math.cos(ang) * st; y += Math.sin(ang) * st * 0.5
  }
  return pts
}
const caps = Array.from({ length: 6 + (rng() * 6 | 0) }, genCap)
// necrotic bruise blotches that bloom along the acid tear-tracks — sickly green,
// jaundice-yellow and bruise-purple, clustered near the inner-lower eye and trailing
// down where the acid runs. Seeded (eye-local coords: x in -1..1, y downward), so a
// room shares the rot. Revealed + brightened by `bloodshot` — the rot spreads.
const bruises = Array.from({ length: 12 + (rng() * 8 | 0) }, () => ({
  x: (rng() < 0.5 ? -1 : 1) * (0.02 + rng() * 0.2),
  y: 0.1 + rng() * 0.75,
  r: 0.05 + rng() * 0.15,
  hue: [95, 52, 285][rng() * 3 | 0],
  ph: rng() * 6.28,
}))
// small eyes that open in the dark, blink once, and are gone (cosmetic, no hitbox)
const darkEyes = []
let nextEyeT = 2600 + rng() * 5000

// ---------- shared "sky" state ----------
// charge: how lit-up the shared sky is right now (0..1), decays on its own.
// hue: the sky's current color, drifts toward whoever's actively adding charge.
// Both are local variables that get nudged by (a) your own light cursor and
// (b) deltas broadcast by other players currently in the room. There is no
// server-side store (see net.js) — this is pure "whoever's here right now"
// ambient state, which is also why it resets to calm whenever a room empties:
// the sky itself is as ephemeral as the rainbows it's made of.
const sky = { charge: 0.08, hue: rng() * 360 | 0 }
let peerCount = 0
const elderLog = []
// The Sky Elder is a real presence, not just a log: a faint watching eye drawn
// into the background (see drawSkyElder) that brightens once, briefly, every
// time this fires. It never reacts to your dragging or the herd's position —
// per the js13kgames Online-category rule, an observer bot can watch the
// shared state but never touch it. Everywhere else that's an anti-cheat
// footnote; here it's the whole point: something is watching you build this,
// and can only ever watch.
let elderPulse = 0
// where the eye is looking (eased toward your light) and how blown-open its pupil
// is (rises when you're near it, or when it's locked onto prey). This is the part
// that flips it from "aloof decoration" to "it is watching you". Visual only — it
// never touches the shared sky, so the Online-layer "watch but never touch" framing
// still holds.
const gaze = { x: innerWidth / 2, y: innerHeight * 0.2 }
let pupilDilate = 0
let eyeTarget = null
// how inflamed the eye is (0..1): eases up the whole time it watches, jumps on every
// kill, and only ebbs very slowly — the eye remembers. Drives sclera redness, vein
// count/creep, and the twitch rate.
let bloodshot = 0.06
// a brief color the iris flushes when it swallows a unicorn (it digests the hue)
let irisFlush = { hue: 0, t: 0 }
// a visual pulse shared with the audio heartbeat so the veins/glow throb in time
let heartPhase = 0
// a nictitating membrane that occasionally sweeps sideways across the eye
let memb = 0, membT = 3000 + rng() * 6000
function elder(msg) {
  elderLog.unshift(`${new Date().toLocaleTimeString()}  ${msg}`)
  elderLog.length = 6
  logEl.textContent = elderLog.join('\n')
  elderPulse = 1
}

// ---------- pointer / light source ----------
const light = { x: innerWidth / 2, y: innerHeight / 2, active: false }
function pointerPos(e) {
  const t = e.touches ? e.touches[0] : e
  return toWorld(t.clientX, t.clientY)
}
function onDown(e) { light.active = true; Object.assign(light, pointerPos(e)); startVerse() }
function onMove(e) { if (light.active) Object.assign(light, pointerPos(e)) }
function onUp() { light.active = false }
// Mouse/touch listeners alongside Pointer Events: harmless double-fire on a normal
// pointer-events browser (Chrome + Firefox both support them), and it's what
// actually matters if any input path only dispatches legacy events.
canvas.addEventListener('pointerdown', onDown)
addEventListener('pointermove', onMove)
addEventListener('pointerup', onUp)
canvas.addEventListener('mousedown', onDown)
addEventListener('mousemove', onMove)
addEventListener('mouseup', onUp)
canvas.addEventListener('touchstart', (e) => { onDown(e); e.preventDefault() }, { passive: false })
// only swallow the touch while actually dragging the light — otherwise the tuning
// panel's sliders can't be dragged on a touchscreen
addEventListener('touchmove', (e) => { onMove(e); if (light.active) e.preventDefault() }, { passive: false })
addEventListener('touchend', onUp)

// ---------- herd (boid-lite) ----------
// Never fewer than cfg.floor unicorns present. Every death (to the eye, or to a
// super-pile) is topped up the same frame from a fresh spawn at the world's edge,
// so the sky is never empty — they just keep coming, each one stranger.

// every unicorn is a little stranger than the last one — brighter body hue,
// its own secondary marking color, a scatter of spots at fixed spawn-time
// positions (so they don't swim around independently of the body), a scale
// anywhere from small to oversized, and a horn that curls a different way
// and reaches a different length. Always unmistakably a unicorn; never the
// same unicorn twice.
function spawnUnicorn(x, y) {
  const R = Math.random
  const wild = R()
  return {
    x, y, vx: 0, vy: 0,
    hue: R() * 360,
    delivered: false, sucked: false, suckT: 0, gone: false,
    scale: 0.6 + R() * 1.3,
    spotHue: R() * 360,
    hornCurl: R() < 0.5 ? 1 : -1,
    wild,
    // --- style: no two the same. build/neck reshape the body; the rest swap parts. ---
    build: 0.82 + R() * 0.5,   // 0.82 slender .. 1.32 stocky (barrel thickness)
    neck: 0.6 + R() * 0.8,     // neck length (foals short, horses long)
    mane: R() * 3 | 0,         // 0 flowing, 1 spiky, 2 short bristle
    hornType: R() * 4 | 0,     // 0 spiral, 1 straight spike, 2 curved-back, 3 branched
    tailStyle: R() * 2 | 0,    // 0 long flowing, 1 tufted
    wings: R() < 0.22,         // a few are winged (alicorn)
    gallop: R() < 0.5,         // leg pose: galloping vs standing
    gait: R() * 6.28,          // gait phase so legs don't all swing together
    beard: R() < 0.18,         // a few have a chin tuft
    marks: Array.from({ length: R() * 6 | 0 }, () => [
      -14 + R() * 30, -6 + R() * 14, 0.8 + R() * 1.6,
    ]),
  }
}
const herd = Array.from({ length: cfg.floor + 1 }, () =>
  spawnUnicorn(Math.random() * innerWidth, Math.random() * innerHeight))
let deliveredCount = 0
let lostCount = 0

// how many unicorns are actually on the board (not gone, not already delivered)
function liveCount() {
  let n = 0
  for (const u of herd) if (!u.gone && !u.delivered) n++
  return n
}
// spawn fresh ones at the world edge until we're back to the floor. Called every
// frame — the moment one dies or crosses home, another walks in from the dark.
function topUpHerd() {
  let guard = 0
  while (liveCount() < cfg.floor && guard++ < 30) {
    const [wl, wr, wt, wb] = wBounds()
    const edge = Math.random()
    const x = edge < 0.5 ? wl + 8 : wr - 8
    const y = wt + 20 + Math.random() * (wb - wt - 40)
    // reuse a gone slot if there is one, else grow the array
    const slot = herd.find((u) => u.gone)
    const born = spawnUnicorn(x, y)
    if (slot) Object.assign(slot, born); else herd.push(born)
  }
}

// ---------- lures: abstract symbols the herd drifts toward on its own ----------
// The unicorns want something even when you aren't dragging. Two abstract glyphs
// pull on them: a pale cross (call it a bible) that calms whatever nears it, and a
// dark inward-curving twin-horn (call it a devil) that agitates. Deliberately
// abstract — bars and curves of light, not icons. Seeded so a room shares them.
const lures = [
  { type: 0, x: innerWidth * (0.18 + rng() * 0.16), y: innerHeight * (0.32 + rng() * 0.32), ph: rng() * 6.28 },
  { type: 1, x: innerWidth * (0.64 + rng() * 0.16), y: innerHeight * (0.32 + rng() * 0.32), ph: rng() * 6.28 },
]
function nearestLure(x, y) {
  let best = null, bd = 1e9
  for (const L of lures) { const d = Math.hypot(L.x - x, L.y - y); if (d < bd) { bd = d; best = L } }
  return [best, bd]
}
function drawLures(now) {
  for (const L of lures) {
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.0016 + L.ph)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.translate(L.x, L.y)
    if (L.type === 0) {
      // a cross of pale light — the calm one
      ctx.strokeStyle = `hsla(48,55%,88%,${0.2 + pulse * 0.18})`
      ctx.lineWidth = 2.2
      ctx.shadowBlur = 16 + pulse * 14
      ctx.shadowColor = 'hsla(48,80%,80%,0.7)'
      ctx.beginPath()
      ctx.moveTo(0, -16); ctx.lineTo(0, 16)
      ctx.moveTo(-9, -6); ctx.lineTo(9, -6)
      ctx.stroke()
    } else {
      // two inward-curving horns — the agitating one
      ctx.strokeStyle = `hsla(${350 + pulse * 12},80%,60%,${0.2 + pulse * 0.2})`
      ctx.lineWidth = 2.4
      ctx.shadowBlur = 16 + pulse * 16
      ctx.shadowColor = 'hsla(356,85%,55%,0.7)'
      for (const s of [-1, 1]) {
        ctx.beginPath()
        ctx.moveTo(s * 3, 13)
        ctx.quadraticCurveTo(s * 15, 2, s * 9, -16)
        ctx.stroke()
      }
    }
    ctx.restore()
  }
}

// ---------- splash-blobs ----------
// The dead don't just pile in corners — the colored remains smear onto the glass
// wherever the herd slams into the edge. Each impact/death splats at that point on
// the world border; nearby splats merge into a growing blob; past a threshold a blob
// wakes into a SUPER blob that reaches out, drags the living in, eats them, and
// spreads — crusting the border organically. Blobs ride the (growing) perimeter.
const blobs = []
const MERGE_DIST = 70, MAX_BLOBS = 24
// world point + inward unit normal for a blob sitting at fraction t along its edge
function blobPos(b) {
  const [l, r, tp, bt] = wBounds()
  if (b.edge === 0) return [l + b.t * (r - l), tp, 0, 1]   // top
  if (b.edge === 1) return [l + b.t * (r - l), bt, 0, -1]  // bottom
  if (b.edge === 2) return [l, tp + b.t * (bt - tp), 1, 0] // left
  return [r, tp + b.t * (bt - tp), -1, 0]                  // right
}
// nearest point on the world border to (x,y), as [edge, t]
function toPerimeter(x, y) {
  const [l, r, tp, bt] = wBounds()
  const dl = x - l, dr = r - x, dtp = y - tp, dbt = bt - y
  const m = Math.min(dl, dr, dtp, dbt)
  const fx = (r - l) ? (x - l) / (r - l) : 0.5, fy = (bt - tp) ? (y - tp) / (bt - tp) : 0.5
  if (m === dtp) return [0, fx]
  if (m === dbt) return [1, fx]
  if (m === dl) return [2, fy]
  return [3, fy]
}
function nearestBlob(x, y) {
  let best = null, bd = MERGE_DIST
  for (const b of blobs) {
    const [ax, ay] = blobPos(b)
    const d = Math.hypot(ax - x, ay - y)
    if (d < bd) { bd = d; best = b }
  }
  return best
}
// a splash/death at (x,y): find or spawn the blob on the nearest border point, add
// one husk, mutate + grow it, wake it if it crosses the threshold
function addSplat(x, y, hue) {
  let b = nearestBlob(x, y)
  if (!b) {
    if (blobs.length >= MAX_BLOBS) { // make room: drop the smallest
      let mi = 0; for (let i = 1; i < blobs.length; i++) if (blobs[i].count < blobs[mi].count) mi = i
      blobs.splice(mi, 1)
    }
    const [edge, t] = toPerimeter(x, y)
    b = { edge, t, husks: [], count: 0, sup: false, hue, r: 0, pull: 0 }
    blobs.push(b)
  }
  const [, , nx, ny] = blobPos(b)
  const tx = -ny, ty = nx // tangent along the edge
  const spread = (8 + Math.sqrt(b.count) * 6) * cfg.creep
  const inward = 5 + Math.pow(Math.random(), 1.7) * spread
  const along = (Math.random() - 0.5) * (20 + spread * 1.4)
  b.husks.push({
    ox: nx * inward + tx * along,
    oy: ny * inward + ty * along,
    r: 4 + Math.random() * 5,
    hue: b.sup ? b.hue : hue,
  })
  if (b.husks.length > 70) b.husks.shift() // draw-list cap; count keeps climbing
  b.count++
  b.hue = (b.hue + 18 + Math.random() * 24) % 360 // replicate + change each addition
  b.r = 12 + Math.sqrt(b.count) * 7
  if (!b.sup && b.count >= cfg.trigger) {
    b.sup = true
    elder('A blot on the glass has started to move on its own.')
  }
}
// a unicorn hitting the edge — leave a mark with a chance that scales with impact speed
function splash(u, x, y) {
  const sp = Math.hypot(u.vx, u.vy)
  if (Math.random() < Math.min(0.9, sp * 0.15)) addSplat(x, y, u.hue)
}
// super blobs pull the living in, eat them, and push the world outward
function stepBlobs(dt) {
  worldScaleTarget = 1
  const n = blobs.length // snapshot: don't process blobs spawned this frame
  for (let bi = 0; bi < n; bi++) {
    const b = blobs[bi]
    if (!b.sup) continue
    const [ax, ay] = blobPos(b)
    b.pull = Math.min(1, b.pull + dt * 0.0004)
    const reach = b.r + 150
    for (const u of herd) {
      if (u.gone || u.delivered || u.sucked) continue
      const dx = ax - u.x, dy = ay - u.y
      const d = Math.hypot(dx, dy) || 1
      if (d < reach) {
        const g = (1 - d / reach) * 0.006 * b.pull * dt * cfg.pull
        u.vx += (dx / d) * g
        u.vy += (dy / d) * g
      }
      if (d < b.r + 10) { addSplat(u.x, u.y, u.hue); u.gone = true } // consumed
    }
    worldScaleTarget += Math.min(1.2, b.r / (innerWidth * 0.5)) * 0.55
  }
  if (worldScaleTarget > cfg.zcap) worldScaleTarget = cfg.zcap
}
function drawBlobs(now) {
  for (const b of blobs) {
    const [ax, ay] = blobPos(b)
    ctx.save()
    if (b.sup) {
      // a solid, wobbling mass crusting the border, not just glow
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = `hsla(${b.hue | 0},68%,30%,0.72)`
      ctx.shadowBlur = 26
      ctx.shadowColor = `hsla(${b.hue | 0},85%,48%,0.7)`
      ctx.beginPath()
      for (let k = 0; k <= 20; k++) {
        const a = (k / 20) * Math.PI * 2
        const rr = b.r * (0.72 + 0.13 * Math.sin(a * 3 + now * 0.003 + b.t * 9))
        const px = ax + Math.cos(a) * rr, py = ay + Math.sin(a) * rr
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)
      }
      ctx.closePath(); ctx.fill()
      ctx.shadowBlur = 0
    }
    // the husks themselves — a knotted cluster of colored blobs smeared on the glass
    ctx.globalCompositeOperation = 'lighter'
    for (const h of b.husks) {
      ctx.fillStyle = `hsla(${h.hue | 0},70%,${b.sup ? 58 : 46}%,${b.sup ? 0.75 : 0.5})`
      ctx.shadowBlur = b.sup ? 10 : 4
      ctx.shadowColor = `hsla(${h.hue | 0},80%,55%,0.6)`
      ctx.beginPath(); ctx.arc(ax + h.ox, ay + h.oy, h.r, 0, Math.PI * 2); ctx.fill()
    }
    ctx.restore()
  }
}

// ---------- the eye weeps acid ----------
// Sickly tears fall from the pupil; where one lands it leaves a stain that bleeds
// its color into everything underneath — the sky discolors, and any unicorn caught
// in a stain has its own hue dragged toward the rot.
const acid = []
const stains = []
let weepT = 700, weepGlow = 0
function stepAcid(dt, now) {
  const [ex, ey] = skyElderPos(now)
  weepT -= dt
  weepGlow = Math.max(0, weepGlow - dt * 0.0006)
  if (weepT <= 0) {
    // weeps faster when agitated, and scaled by the acid-weeping knob
    weepT = (500 + Math.random() * 1400 - pupilDilate * 300) / Math.max(0.05, cfg.weep)
    weepGlow = 1
    acid.push({ x: ex + (Math.random() - 0.5) * 12, y: ey + 6, vy: 0.02 + Math.random() * 0.03, hue: 70 + Math.random() * 70 })
  }
  const [, , , wb] = wBounds()
  for (let i = acid.length - 1; i >= 0; i--) {
    const a = acid[i]
    a.vy += dt * 0.00012
    a.y += a.vy * dt
    if (a.y >= wb - 4 || Math.random() < 0.005) {
      stains.push({ x: a.x, y: a.y, r: 6, mr: 24 + Math.random() * 44, hue: a.hue, age: 0 })
      if (stains.length > 90) stains.shift()
      acid.splice(i, 1)
    }
  }
  for (const s of stains) {
    s.age += dt
    if (s.r < s.mr) s.r += dt * 0.02
    for (const u of herd) {
      if (u.gone) continue
      if (Math.hypot(u.x - s.x, u.y - s.y) < s.r) {
        u.hue = (u.hue + (((s.hue - u.hue + 540) % 360) - 180) * 0.02 + 360) % 360
      }
    }
  }
}
function drawStains() {
  ctx.save()
  ctx.globalCompositeOperation = 'overlay' // bleed color into whatever's beneath
  for (const s of stains) {
    const a = Math.max(0, 0.62 - s.age * 0.000016)
    if (a <= 0.01) continue
    const gg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r)
    gg.addColorStop(0, `hsla(${s.hue | 0},90%,50%,${a})`)
    gg.addColorStop(1, `hsla(${s.hue | 0},90%,50%,0)`)
    ctx.fillStyle = gg
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
}
function drawAcid() {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const a of acid) {
    ctx.fillStyle = `hsla(${a.hue | 0},90%,55%,0.85)`
    ctx.shadowBlur = 8; ctx.shadowColor = `hsla(${a.hue | 0},90%,50%,0.8)`
    ctx.beginPath(); ctx.ellipse(a.x, a.y, 2.2, 3.6, 0, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
}

// fading rainbow ribbon behind the drag — the "paint" feedback for the light cursor
const trail = []
// short-lived rainbow bursts spawned when a unicorn is delivered
const particles = []

function spawnDeliveryBurst(x, y) {
  const n = 16
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    particles.push({
      x, y,
      vx: Math.cos(a) * (1.2 + Math.random() * 0.8),
      vy: Math.sin(a) * (1.2 + Math.random() * 0.8),
      hue: (i / n) * 360, // a full spectrum burst — a literal rainbow pop
      life: 1,
    })
  }
}

// a smaller, reddish pop — this one means the eye took a unicorn, not that
// one made it home, so it has to read as a loss rather than a celebration
function spawnVoidPop(x, y) {
  const n = 10
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    particles.push({
      x, y,
      vx: Math.cos(a) * (0.5 + Math.random() * 0.5),
      vy: Math.sin(a) * (0.5 + Math.random() * 0.5),
      hue: 4 + Math.random() * 10,
      life: 1,
    })
  }
}

function stepHerd(dt, now) {
  const [wl, wr, wt, wb] = wBounds()
  // The eye notices the nearest unicorn before it strikes — the pupil locks on and
  // dilates for a beat of dread, instead of the old no-warning grab. eyeTarget is
  // read by the render loop (gaze snap + dilation) and reset each frame.
  eyeTarget = null
  if (skyElderOpen(now) > 0.3) {
    const [ex, ey] = skyElderPos(now)
    let best = null, bd = 1e9
    for (const u of herd) {
      if (u.delivered || u.gone || u.sucked) continue
      const d = Math.hypot(ex - u.x, ey - u.y)
      if (d < bd) { bd = d; best = u }
    }
    if (best && bd < 130) eyeTarget = best
  }

  for (const u of herd) {
    if (u.delivered || u.gone) continue

    // once caught, a unicorn is committed — pulled straight into the pupil,
    // shrinking, until it's gone. This is the one thing the Elder actually
    // does, rather than just watches: get too close to it and it takes you.
    if (u.sucked) {
      const [ex, ey] = skyElderPos(now)
      u.suckT += dt * 0.0022
      u.x += (ex - u.x) * 0.16
      u.y += (ey - u.y) * 0.16
      if (u.suckT >= 1) {
        lostCount++
        spawnVoidPop(ex, ey)
        addSplat(u.x, u.y, u.hue)   // remains smear onto the nearest edge of the glass
        irisFlush = { hue: u.hue, t: 1 } // it digests the color: the iris flushes its hue
        bloodshot = Math.min(1, bloodshot + 0.06) // and the eye reddens a little more
        caps.push(genCap())         // a fresh vein bursts across the white
        if (caps.length > 30) caps.shift()
        u.gone = true               // topUpHerd() walks a stranger in to replace it
        elder(`The eye took one. Its color bleeds into the glass. (${lostCount} taken)`)
      }
      continue
    }

    // steer toward the light when it's active and the sky has some charge —
    // "warm" pulls, "grey" (low charge) lets them drift on their own.
    if (light.active && sky.charge > 0.05) {
      const dx = light.x - u.x, dy = light.y - u.y
      const d = Math.hypot(dx, dy) || 1
      const pull = Math.min(0.6, sky.charge) * 0.08
      u.vx += (dx / d) * pull
      u.vy += (dy / d) * pull
    }
    // a faint pull toward the nearest symbol — the herd wanders to it on its own,
    // even with the light off. The cross calms them; the horns agitate and hurry.
    const [L, ld] = nearestLure(u.x, u.y)
    if (L && ld > 1) {
      const lp = (L.type ? 0.02 : 0.013) * cfg.lure
      u.vx += ((L.x - u.x) / ld) * lp
      u.vy += ((L.y - u.y) / ld) * lp
      if (ld < 80) { const k = L.type ? 1.012 : 0.985; u.vx *= k; u.vy *= k }
    }
    // gentle flocking: pull toward herd centroid, avoid crowding
    let cx = 0, cy = 0, n = 0
    for (const o of herd) {
      if (o === u || o.delivered || o.sucked || o.gone) continue
      cx += o.x; cy += o.y; n++
      const dx = u.x - o.x, dy = u.y - o.y
      const d2 = dx * dx + dy * dy
      if (d2 > 0 && d2 < 900) { u.vx += dx / d2; u.vy += dy / d2 }
    }
    if (n) { u.vx += (cx / n - u.x) * 0.0008; u.vy += (cy / n - u.y) * 0.0008 }

    u.vx *= 0.96; u.vy *= 0.96
    u.x += u.vx * dt; u.y += u.vy * dt
    // wilder unicorns resist blending into the ambient sky hue — they stay
    // brilliantly, stubbornly their own color
    u.hue += (sky.hue - u.hue) * 0.02 * (1 - u.wild)

    // bounce off the (growing) world edges — and splash colored remains onto the
    // glass where it hits, harder impacts more likely to leave a mark
    if (u.x < wl) { u.x = wl; u.vx *= -1; splash(u, wl, u.y) }
    if (u.x > wr) { u.x = wr; u.vx *= -1; splash(u, wr, u.y) }
    if (u.y < wt) { u.y = wt; u.vy *= -1; splash(u, u.x, wt) }
    if (u.y > wb) { u.y = wb; u.vy *= -1; splash(u, u.x, wb) }

    // wander into the eye's open pupil and it takes you — no warning beyond
    // the eye itself being there to see
    if (skyElderOpen(now) > 0.3) {
      const [ex, ey] = skyElderPos(now)
      if (Math.hypot(ex - u.x, ey - u.y) < cfg.hunger + elderPulse * 10) {
        u.sucked = true
        u.suckT = 0
        continue
      }
    }

    // "the valley" — reaching the right edge with enough charge delivers the unicorn.
    // It leaves the board (topUpHerd walks another in), so the count never drops.
    if (u.x > wr - 24 && sky.charge > 0.5) {
      deliveredCount++
      spawnDeliveryBurst(u.x, u.y)
      u.gone = true
      elder(`A unicorn slipped across to the valley. ${deliveredCount} have made it.`)
    }
  }
}

// ---------- The Elder's verse — synthesized boom-bap beat + spoken lines ----------
// No audio files (nothing to add to the zip): kick/snare/hat are plain
// oscillator/noise synthesis, same spirit as a ZzFX-style tracker. Lines are
// read aloud with the browser's built-in speech synthesis, slowed and pitched
// down for the drawl, and always shown as text too — TTS voices (and this
// preview sandbox specifically) aren't guaranteed to be available everywhere.
// A pool of off-kilter, half-sense lines. Each verse pulls a random handful in a
// random order, so it's never quite the same twice and never quite adds up.
const LYRIC_POOL = [
  "i keep your colors in a jar behind my teeth",
  "count the legs again... you'll get it wrong again",
  "the moon still owe me seven horses and it know",
  "every rainbow is a door i already shut",
  "little light, little light, why you shakin' at me",
  "i ate a tuesday once, it tasted like your name",
  "the ground is just a lid, baby, the ground is just a lid",
  "been watchin' since before you had a face to lose",
  "don't go where the dark get thick, that's where i keep the rest",
  "your rainbow's on my tongue and it forgot the way back home",
  "i blink, and a hundred years fall off the shelf",
  "the horses know my name but they won't say it twice",
  "i'm not up in the sky... the sky is up in me",
  "you feed me pretty colors, i give you back the cold",
  "somewhere you already gone — i saw it, it was fine",
  "the stars is just the holes i left in somethin' bigger",
  "warm ones taste like tuesday, grey ones taste like you",
  "i had a body once, i left it where you can't",
  "keep draggin' that light, keep drawin' me a mouth",
  "shhh... the valley only hungry 'cause i told it to be",
]
function shuffled(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]] }
  return a
}
let verseSet = []      // the lines chosen for the current verse
let currentLine = ''
let captionTimer = 0
let actx = null
function ensureAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)()
    if (actx.state === 'suspended') actx.resume()
  } catch (e) { /* no Web Audio here — beat just won't play */ }
}
function kick(t) {
  const o = actx.createOscillator(), g = actx.createGain()
  o.frequency.setValueAtTime(130, t)
  o.frequency.exponentialRampToValueAtTime(38, t + 0.15)
  g.gain.setValueAtTime(0.9, t)
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
  o.connect(g); g.connect(actx.destination)
  o.start(t); o.stop(t + 0.2)
}
function noiseHit(t, dur, freq, gain) {
  const n = Math.max(1, actx.sampleRate * dur | 0)
  const buf = actx.createBuffer(1, n, actx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
  const src = actx.createBufferSource()
  src.buffer = buf
  const filt = actx.createBiquadFilter()
  filt.type = 'highpass'; filt.frequency.value = freq
  const g = actx.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.001, t + dur)
  src.connect(filt); filt.connect(g); g.connect(actx.destination)
  src.start(t)
}
// a generic tuned note through a lowpass — used for the bass and the eerie lead
function blip(t, freq, dur, type, gain, cutoff) {
  const o = actx.createOscillator(), g = actx.createGain(), f = actx.createBiquadFilter()
  o.type = type; o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'; f.frequency.value = cutoff
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0006, t + dur)
  o.connect(f); f.connect(g); g.connect(actx.destination)
  o.start(t); o.stop(t + dur + 0.02)
}
// warm plucked sub-bass
function bass(t, freq) { blip(t, freq, 0.3, 'triangle', 0.45, 380) }
// a fuller snare: a noise crack plus a short tonal body
function snareHit(t) {
  noiseHit(t, 0.16, 1400, 0.5)
  const o = actx.createOscillator(), g = actx.createGain()
  o.type = 'triangle'; o.frequency.setValueAtTime(190, t)
  o.frequency.exponentialRampToValueAtTime(120, t + 0.12)
  g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
  o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.16)
}
// The browser's speech API only exposes voice/rate/pitch (no distortion), so the
// "gravel" comes from three things: pick the deepest voice available, run it slow
// and low, and lay a synthesized growl + vinyl crackle underneath (those we CAN
// build in Web Audio). Voices load async, so re-pick whenever the list changes.
let theVoice = null, voiceList = [], voicePinned = false, voiceSelectRefresh = null
function loadVoices() {
  try {
    voiceList = speechSynthesis.getVoices() || []
    if (!voiceList.length) return
    if (!voicePinned) {
      // prefer US English (the vibe we're going for: a deep, warm, older male voice),
      // then any English. We can't read timbre from the API, so bias by known deep /
      // warm male voice names across platforms, then anything flagged male.
      const us = voiceList.filter((v) => /^en[-_]?us/i.test(v.lang))
      const en = voiceList.filter((v) => /^en/i.test(v.lang))
      const pool = us.length ? us : (en.length ? en : voiceList)
      const pref = ['ralph', 'reed', 'david', 'mark', 'fred', 'lee', 'rocko', 'guy',
        'christopher', 'aaron', 'arthur', 'daniel', 'bruce', 'junior', 'grandpa', 'eddy', 'male']
      theVoice = pool.find((v) => pref.some((p) => v.name.toLowerCase().includes(p))) || pool[0]
    }
    if (voiceSelectRefresh) voiceSelectRefresh() // keep the dropdown in sync
  } catch (e) { /* ignore */ }
}
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices }

function speak(line) {
  try {
    if (!window.speechSynthesis) return
    const u = new SpeechSynthesisUtterance(line)
    if (theVoice) u.voice = theVoice
    u.rate = cfg.vrate   // slow, dragging drawl
    u.pitch = cfg.vpitch // deep and gravelly
    u.volume = 1
    speechSynthesis.speak(u)
  } catch (e) { /* speech synthesis unavailable — captions still show */ }
}

// A short gravelly rasp fired under each spoken line — two detuned low waves
// through a lowpass, quick swell and decay. It doesn't track syllables; it just
// adds grit on the downbeat where the voice lands. Scaled by cfg.grit.
function growl(t) {
  if (!actx || cfg.grit <= 0) return
  const o1 = actx.createOscillator(), o2 = actx.createOscillator()
  const f = actx.createBiquadFilter(), g = actx.createGain()
  o1.type = 'sawtooth'; o2.type = 'square'
  o1.frequency.value = 64; o2.frequency.value = 64 * 1.5
  f.type = 'lowpass'; f.frequency.value = 520
  const peak = 0.16 * cfg.grit
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + 0.06)
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.55)
  o1.connect(f); o2.connect(f); f.connect(g); g.connect(actx.destination)
  o1.start(t); o2.start(t); o1.stop(t + 0.6); o2.stop(t + 0.6)
}

// A low detuned drone bed under the verse — two saws a hair apart through a
// slow-swept lowpass. Started with the verse, faded out when it ends. Pure
// synthesis; if there's no AudioContext this is simply silent.
let droneNodes = null
function droneStart() {
  if (!actx || droneNodes) return
  const g = actx.createGain(); g.gain.value = 0.0001; g.connect(actx.destination)
  g.gain.setTargetAtTime(0.05, actx.currentTime, 1.5)
  const o1 = actx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 55
  const o2 = actx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 55 * 1.008
  const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 210
  const lfo = actx.createOscillator(); lfo.frequency.value = 0.07
  const lg = actx.createGain(); lg.gain.value = 90; lfo.connect(lg); lg.connect(f.frequency)
  o1.connect(f); o2.connect(f); f.connect(g)
  o1.start(); o2.start(); lfo.start()
  // vinyl crackle: a looped buffer of sparse pops through a highpass — the dusty
  // old-tape hiss that says "90s". Volume rides cfg.grit.
  const len = actx.sampleRate * 2 | 0
  const buf = actx.createBuffer(1, len, actx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() < 0.0009 ? (Math.random() * 2 - 1) : 0
  const cr = actx.createBufferSource(); cr.buffer = buf; cr.loop = true
  const crf = actx.createBiquadFilter(); crf.type = 'highpass'; crf.frequency.value = 1600
  const crg = actx.createGain(); crg.gain.value = 0.0001
  crg.gain.setTargetAtTime(0.28 * cfg.grit, actx.currentTime, 1)
  cr.connect(crf); crf.connect(crg); crg.connect(actx.destination); cr.start()
  droneNodes = { g, o1, o2, lfo, cr }
}
function droneStop() {
  if (!droneNodes) return
  const { g, o1, o2, lfo, cr } = droneNodes
  try {
    g.gain.setTargetAtTime(0.0001, actx.currentTime, 0.6)
    o1.stop(actx.currentTime + 1.2); o2.stop(actx.currentTime + 1.2); lfo.stop(actx.currentTime + 1.2)
    cr.stop(actx.currentTime + 1.2)
  } catch (e) { /* ignore */ }
  droneNodes = null
}

// A soft double heartbeat whose tempo climbs as the eye's pupil blows open /
// locks a target: calm ~1.6s apart, hunting ~0.5s. Starts once audio exists
// (after the first drag gesture) and quietly runs under everything.
function thump(t, vol) {
  const o = actx.createOscillator(), g = actx.createGain()
  o.frequency.setValueAtTime(70, t)
  o.frequency.exponentialRampToValueAtTime(30, t + 0.14)
  g.gain.setValueAtTime(vol, t)
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
  o.connect(g); g.connect(actx.destination)
  o.start(t); o.stop(t + 0.22)
}
let hbStarted = false, hbNext = 0
function heartbeat() {
  if (!actx) return
  const now = actx.currentTime
  if (hbNext < now + 0.1) {
    const vol = 0.16 + pupilDilate * 0.5
    thump(now + 0.02, vol)
    thump(now + 0.16, vol * 0.6)
    hbNext = now + (1.6 - pupilDilate * 1.1)
  }
  requestAnimationFrame(heartbeat)
}

// A head-nodding boom-bap under a slow, low drawl. All synth: kicks, a moody
// sub-bass (A-minor i → b7 feel), a fuller snare on the backbeat, swung hats, and a
// sparse dissonant lead motif every other bar for unease.
const VERSE_BPM = 76, VERSE_STEP = 60 / VERSE_BPM / 2
const KICKS = [1, 0, 0, 0, 0, 0, 1, 0]
const BASS_HZ = [55, 0, 0, 82, 0, 0, 49, 0] // A1 . . A2 . . G1 .
const LEAD_HZ = [466, 622, 440, 587]        // Bb4 D#5 A4 D5 — deliberately unresolved
let verseOn = false, nextStep = 0, stepIdx = 0, verseLines = 0, barCount = 0, lastVerseAt = -Infinity
function scheduleVerse() {
  if (!verseOn) return
  while (nextStep < actx.currentTime + 0.15) {
    const idx = stepIdx % 8
    if (KICKS[idx]) kick(nextStep)
    if (BASS_HZ[idx]) bass(nextStep, BASS_HZ[idx])
    if (idx === 4) snareHit(nextStep) // backbeat
    if (idx % 2 === 1) noiseHit(nextStep, 0.045, 7000, (idx === 3 || idx === 7) ? 0.26 : 0.14) // hats w/ dynamics
    if (idx === 2 && barCount % 2 === 0) { // sparse eerie lead
      const f = LEAD_HZ[(barCount / 2 | 0) % LEAD_HZ.length]
      blip(nextStep, f, 0.55, 'triangle', 0.11, 3200)
      blip(nextStep, f * 1.005, 0.55, 'triangle', 0.08, 3200) // detuned twin
    }
    // start a bar's line only once the voice has finished the last one, so a slow
    // gravelly delivery never piles up or gets clipped — bars between ride the beat.
    if (idx === 0 && verseLines < verseSet.length &&
        (!window.speechSynthesis || !speechSynthesis.speaking)) {
      currentLine = verseSet[verseLines]
      verseLines++
      captionTimer = 1
      elder(currentLine)
      speak(currentLine)
      growl(nextStep)
    }
    nextStep += VERSE_STEP
    stepIdx++
    if (idx === 7) barCount++
    // end once every chosen line has been spoken and the voice has fallen silent
    if (verseLines >= verseSet.length &&
        (!window.speechSynthesis || !speechSynthesis.speaking)) { verseOn = false; droneStop(); return }
    if (stepIdx > verseSet.length * 24) { verseOn = false; droneStop(); return } // safety
  }
  requestAnimationFrame(scheduleVerse)
}
// dragging is already a user gesture, so it's the natural place to (re)start
// audio — browsers require one before AudioContext/speech will actually play
function startVerse() {
  const t = performance.now()
  if (verseOn || t - lastVerseAt < 8000) return
  lastVerseAt = t
  ensureAudio()
  if (!actx) return
  droneStart()
  if (!hbStarted) { hbStarted = true; hbNext = actx.currentTime; heartbeat() }
  verseSet = shuffled(LYRIC_POOL).slice(0, 6) // a fresh random handful, random order
  verseOn = true
  stepIdx = 0
  verseLines = 0
  barCount = 0
  nextStep = actx.currentTime + 0.05
  scheduleVerse()
}

// The Sky Elder, drawn: a faint eye-shaped constellation drifting slowly and
// independently in the background. It never moves toward the light or the
// herd — it only watches — and it brightens for a moment every time elder()
// logs something (including its own verse), so the log text and this
// presence are the same heartbeat. Dragging now also cues it to start rapping.
const EYE_POINTS = [
  [-1, 0], [-0.6, -0.35], [-0.2, -0.5], [0.2, -0.5], [0.6, -0.35], [1, 0],
  [0.6, 0.35], [0.2, 0.5], [-0.2, 0.5], [-0.6, 0.35],
]
// where the eye's pupil actually is right now, and how open it is — shared
// with stepHerd so "wander too close" checks the same point that's drawn
function skyElderPos(now) {
  const [l, r, tp, bt] = wBounds()
  const spanW = r - l, spanH = bt - tp
  return [
    (l + r) / 2 + Math.sin(now * 0.00006) * spanW * 0.18,
    tp + spanH * 0.2 + Math.cos(now * 0.00004) * spanH * 0.05,
  ]
}
function skyElderOpen(now) {
  // a slow wobble on top of the base cycle so the blink isn't a perfect
  // metronome — reads as an organic, slightly wrong tic instead of a timer
  const p = (now * 0.00011 + Math.sin(now * 0.00017) * 0.04) % 1
  const blink = p > 0.95 ? 1 - (p - 0.95) / 0.05 : 0
  // erratic twitches — rare when calm, frequent and sharp the more bloodshot it gets
  const tw = Math.sin(now * 0.013) * Math.sin(now * 0.0071 + 1.3)
  const thr = 1 - bloodshot * 0.6
  const twitch = tw > thr ? Math.min(0.8, (tw - thr) * 4) : 0
  // a rare hard squeeze-shut
  const squeeze = ((now * 0.00007) % 1) > 0.986 ? 1 : 0
  return Math.max(0.05, 1 - blink - twitch - squeeze)
}

function drawSkyElder(now) {
  const w = Math.min(innerWidth, innerHeight) * 0.72 // giant
  const [cx, cy] = skyElderPos(now)
  const pulse = elderPulse
  const openness = skyElderOpen(now)
  const bs = bloodshot
  const throb = 0.6 + 0.4 * Math.sin(heartPhase * Math.PI * 2) // beats with the heart

  ctx.save()

  // --- the eyeball: a wet sclera drawn SOLID so the reds stay red. It floods from a
  // pale veined white toward furious inflamed red as `bloodshot` climbs. ---
  ctx.beginPath()
  EYE_POINTS.forEach(([px, py], i) => {
    const x = cx + px * w, y = cy + py * w * 0.5 * openness
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  })
  ctx.closePath()
  const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, w)
  sg.addColorStop(0, `hsla(6,${55 + bs * 35}%,${72 - bs * 20}%,0.93)`)
  sg.addColorStop(0.55, `hsla(3,${65 + bs * 25}%,${52 - bs * 16}%,0.93)`)
  sg.addColorStop(1, `hsla(1,${75 + bs * 20}%,${34 - bs * 10}%,0.95)`)
  ctx.fillStyle = sg
  ctx.fill()
  ctx.strokeStyle = `hsla(2,75%,${34 - bs * 12}%,0.85)`
  ctx.lineWidth = 2
  ctx.stroke()

  // necrotic bruising along the tear-tracks: mottled sickly blotches that discolor
  // the lower sclera and trail down where the acid runs. Drawn SOLID (source-over) so
  // it rots the color rather than glowing; more of them, brighter, as it inflames.
  const shown = Math.ceil(bruises.length * (0.35 + bs * 0.65))
  for (let i = 0; i < shown; i++) {
    const b = bruises[i]
    const mottle = 0.6 + 0.4 * Math.sin(now * 0.001 + b.ph)
    const al = (0.08 + bs * 0.32 + weepGlow * 0.2) * mottle
    const bx = cx + b.x * w, by = cy + b.y * w * 0.7, br = b.r * w
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, br)
    bg.addColorStop(0, `hsla(${b.hue},55%,32%,${al})`)
    bg.addColorStop(1, `hsla(${b.hue},55%,28%,0)`)
    ctx.fillStyle = bg
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill()
  }

  // everything from here glows additively on top of the wet ball
  ctx.globalCompositeOperation = 'lighter'

  // --- bloodshot capillaries: more of them, thicker, redder, throbbing with the
  // heart as it inflames. Seeded so a room shares them; kills push fresh veins in. ---
  const capA = (0.12 + bs * 0.5 + pulse * 0.2) * (0.7 + throb * 0.3)
  ctx.lineWidth = 0.6 + bs * 1.3
  for (const cap of caps) {
    ctx.strokeStyle = `hsla(${2 + bs * 4},85%,${46 + throb * 12}%,${capA})`
    ctx.beginPath()
    cap.forEach(([px, py], i) => {
      const x = cx + px * w, y = cy + py * w * 0.5 * openness
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  // where the eyeball is turned — the pupil rides this toward your light or its prey
  const dx = gaze.x - cx, dy = gaze.y - cy
  const gx = Math.max(-1, Math.min(1, dx / (w * 0.9))) * w * 0.3
  const gy = Math.max(-1, Math.min(1, dy / (innerHeight * 0.5))) * w * 0.16 * openness
  const dil = pupilDilate

  // veins reach for prey: when it's locked onto a unicorn, engorged veins strain
  // from the pupil toward it, thickening as the pupil blows open
  if (eyeTarget) {
    ctx.strokeStyle = `hsla(2,88%,${46 + throb * 14}%,${0.28 + dil * 0.5})`
    ctx.lineWidth = 1.2 + dil * 2.4
    for (let i = 0; i < 4; i++) {
      const j = (i - 1.5) * 0.05
      ctx.beginPath()
      ctx.moveTo(cx + gx * 0.15, cy + gy * 0.15)
      ctx.quadraticCurveTo(cx + gx * 0.9 + j * w, cy + gy * 0.9, cx + gx * 1.7 + j * w * 1.3, cy + gy * 1.7)
      ctx.stroke()
    }
  }

  // iris fibers — amber, but they flush with the color of the last unicorn it ate
  const iHue = irisFlush.t > 0 ? irisFlush.hue : 30
  ctx.strokeStyle = `hsla(${iHue | 0},70%,55%,${0.3 + pulse * 0.4 + irisFlush.t * 0.5})`
  ctx.lineWidth = 1
  ctx.save()
  ctx.translate(cx + gx, cy + gy)
  ctx.scale(1, openness)
  const irisR = 9 + dil * 5 + pulse * 4
  for (let i = 0; i < 14; i++) {
    const ang = (i / 14) * Math.PI * 2
    const r0 = 5 + (i % 2) * 1.5
    ctx.beginPath()
    ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0)
    ctx.lineTo(Math.cos(ang) * irisR, Math.sin(ang) * irisR)
    ctx.stroke()
  }
  // the digested-color flush: a ring of the swallowed hue, fading
  if (irisFlush.t > 0) {
    ctx.strokeStyle = `hsla(${irisFlush.hue | 0},90%,60%,${irisFlush.t * 0.7})`
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(0, 0, irisR * 0.8, 0, Math.PI * 2); ctx.stroke()
  }
  ctx.restore()

  // the pupil — a burning red iris around an actual dark slit hole, blown wide open
  // when it's near you or hunting. The hole is drawn SOLID so it reads as a void.
  ctx.save()
  ctx.translate(cx + gx, cy + gy)
  ctx.scale(1, openness)
  const pr = 2.4 + dil * 4 + pulse * 2, prv = 8 + dil * 3 + pulse * 6
  // burning red glow around the slit (additive)
  const pg = ctx.createRadialGradient(0, 0, 0, 0, 0, prv * 1.7)
  pg.addColorStop(0, `hsla(4,90%,55%,${0.6 + pulse * 0.4})`)
  pg.addColorStop(1, 'hsla(4,90%,50%,0)')
  ctx.fillStyle = pg
  ctx.beginPath(); ctx.arc(0, 0, prv * 1.7, 0, Math.PI * 2); ctx.fill()
  // the slit itself — solid near-black, a hole in the eye
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = 'hsla(0,60%,4%,0.98)'
  ctx.beginPath(); ctx.ellipse(0, 0, pr, prv, 0, 0, Math.PI * 2); ctx.fill()
  // a wet specular glint high on the slit
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = `hsla(0,0%,100%,${0.5 + pulse * 0.35})`
  ctx.beginPath(); ctx.ellipse(-pr * 0.5, -prv * 0.35, 1.2, 2, 0, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
  ctx.globalCompositeOperation = 'lighter'

  // acid tears: sickly wet streaks weeping from the lower lid, brightening with each drop
  const tearA = 0.1 + weepGlow * 0.5
  const tg = ctx.createLinearGradient(cx, cy, cx, cy + w * 0.9)
  tg.addColorStop(0, `hsla(95,90%,62%,${tearA})`)
  tg.addColorStop(1, 'hsla(115,90%,45%,0)')
  ctx.strokeStyle = tg
  ctx.lineWidth = 1.6 + weepGlow * 2.2
  ctx.beginPath()
  ctx.moveTo(cx - w * 0.05, cy + w * 0.14 * openness)
  ctx.quadraticCurveTo(cx - w * 0.02, cy + w * 0.5, cx - w * 0.05, cy + w * 0.85)
  ctx.moveTo(cx + w * 0.05, cy + w * 0.14 * openness)
  ctx.quadraticCurveTo(cx + w * 0.085, cy + w * 0.5, cx + w * 0.06, cy + w * 0.8)
  ctx.stroke()

  // nictitating membrane: a pale film that wipes sideways across the eye now and then
  if (memb > 0 && memb < 1) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.save()
    ctx.beginPath()
    EYE_POINTS.forEach(([px, py], i) => {
      const x = cx + px * w, y = cy + py * w * 0.5 * openness
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.clip()
    const ex = cx - w + memb * 2 * w
    ctx.fillStyle = 'rgba(200,175,175,0.3)'
    ctx.fillRect(cx - w, cy - w, ex - (cx - w), w * 2)
    ctx.restore()
  }

  ctx.restore()
}

// the current line, floating under the Elder while it's being said/sung
function drawElderCaption(now) {
  const [ex, ey] = skyElderPos(now)
  ctx.save()
  ctx.globalAlpha = Math.min(1, captionTimer * 2.4)
  ctx.fillStyle = '#f4f0ff'
  ctx.font = 'italic 15px Georgia, "Times New Roman", serif'
  ctx.textAlign = 'center'
  ctx.shadowBlur = 6
  ctx.shadowColor = 'rgba(0,0,0,0.8)'
  ctx.fillText(currentLine, ex, ey + Math.min(innerWidth, innerHeight) * 0.42)
  ctx.restore()
}

// The light cursor itself IS the rainbow — a spinning conic-gradient disc —
// rather than a separate arc elsewhere on screen. One clear source of color.
function drawLightOrb(now) {
  if (!light.active) return
  const r = 12 + sky.charge * 18
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.shadowBlur = 44
  ctx.shadowColor = `hsl(${sky.hue},95%,60%)`
  const grad = ctx.createConicGradient(now * 0.0009, light.x, light.y)
  for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},95%,62%)`)
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(light.x, light.y, r, 0, Math.PI * 2)
  ctx.fill()
  // a bright white-hot core so it still reads as a light source, not just a disc
  ctx.globalAlpha = 0.7
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(light.x, light.y, r * 0.28, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// Shooting rainbow tendrils reaching from the light to every unicorn it's
// currently pulling — makes the pull mechanic visible, not just implied.
function drawTendrils(now) {
  if (!light.active || sky.charge <= 0.05) return
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const u of herd) {
    if (u.delivered || u.sucked || u.gone) continue
    const dx = light.x - u.x, dy = light.y - u.y
    const dist = Math.hypot(dx, dy) || 1
    const nx = -dy / dist, ny = dx / dist
    const wiggle = Math.sin(now * 0.004 + u.x * 0.05) * Math.min(24, dist * 0.12)
    const cx = (light.x + u.x) / 2 + nx * wiggle
    const cy = (light.y + u.y) / 2 + ny * wiggle

    const grad = ctx.createLinearGradient(u.x, u.y, light.x, light.y)
    grad.addColorStop(0, `hsla(${u.hue},90%,65%,0.08)`)
    grad.addColorStop(1, `hsla(${sky.hue},95%,65%,0.6)`)
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.6
    ctx.shadowBlur = 8
    ctx.shadowColor = `hsl(${u.hue},90%,60%)`
    ctx.beginPath()
    ctx.moveTo(u.x, u.y)
    ctx.quadraticCurveTo(cx, cy, light.x, light.y)
    ctx.stroke()

    // sparks travelling from the unicorn toward the light along the tendril
    for (let k = 0; k < 3; k++) {
      const p = (now * 0.0011 + k / 3) % 1
      const ix = (1 - p) * (1 - p) * u.x + 2 * (1 - p) * p * cx + p * p * light.x
      const iy = (1 - p) * (1 - p) * u.y + 2 * (1 - p) * p * cy + p * p * light.y
      ctx.fillStyle = `hsla(${(u.hue + p * 150) % 360},95%,72%,${0.85 * (1 - p * 0.4)})`
      ctx.beginPath(); ctx.arc(ix, iy, 2.4, 0, Math.PI * 2); ctx.fill()
    }
  }
  ctx.restore()
}

// A fading rainbow ribbon painted behind wherever you've dragged — the "you are
// making the rainbow" feedback, independent of the big arc above.
function drawTrail() {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const p of trail) {
    ctx.globalAlpha = p.life * 0.6
    ctx.fillStyle = `hsl(${p.hue},95%,65%)`
    ctx.beginPath()
    ctx.arc(p.x, p.y, 3 + p.life * 6, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

function drawParticles() {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life)
    ctx.fillStyle = `hsl(${p.hue},95%,65%)`
    ctx.beginPath()
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

// A unicorn that actually reads as a unicorn: arched body, flowing mane and
// tail, and — the part that matters most at a glance — a real head with a
// muzzle, an ear, an eye, and a twisted horn. All vector, no stored sprite.
function drawUnicorn(u) {
  const a = Math.atan2(u.vy, u.vx) || 0
  const dim = u.delivered
  const hue = dim ? 0 : u.hue
  const sat = dim ? '0%' : '90%'
  const ink = dim ? 'hsla(0,0%,90%,0.7)' : `hsla(${hue},${sat},78%,1)`
  const fill = dim ? 'hsla(0,0%,90%,0.14)' : `hsla(${hue},${sat},68%,0.26)`

  // caught by the eye: shrinks to nothing as it's dragged in; u.scale is the
  // per-unicorn "some bigger, some smaller" size.
  const base = 1.7 * u.scale
  const shrink = u.sucked ? Math.max(0.02, 1 - u.suckT) * base : base
  const b = u.build, n = u.neck
  const gait = Math.sin(performance.now() * 0.007 + u.gait) * (u.gallop ? 3.2 : 0.7)

  ctx.save()
  ctx.translate(u.x, u.y)
  ctx.rotate(a)
  ctx.scale(shrink, shrink)
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // soft presence glow first
  const gg = ctx.createRadialGradient(0, -5, 0, 0, -5, 22)
  gg.addColorStop(0, `hsla(${hue},${sat},65%,${dim ? 0.12 : 0.36})`)
  gg.addColorStop(1, 'hsla(0,0%,0%,0)')
  ctx.fillStyle = gg
  ctx.beginPath(); ctx.arc(0, -5, 22, 0, Math.PI * 2); ctx.fill()

  ctx.shadowBlur = dim ? 4 : 9
  ctx.shadowColor = `hsl(${hue},${sat},65%)`
  ctx.strokeStyle = ink
  ctx.fillStyle = fill

  // head base sits at the top of the neck; neck length shifts it up/forward
  const hbx = 8, hby = -6 - 5 * n
  const hx = hbx + 2, hy = hby

  // wings behind everything (a few unicorns are winged)
  if (u.wings && !dim) {
    ctx.lineWidth = 1.2
    ctx.fillStyle = `hsla(${(hue + 30) % 360},${sat},74%,0.16)`
    for (const s of [1, 0.72]) {
      ctx.beginPath()
      ctx.moveTo(-2, -4)
      ctx.quadraticCurveTo(-9, -15 * s - 3, -17 * s - 2, -7 * s - 7)
      ctx.quadraticCurveTo(-9, -7, -2, -4)
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }
    ctx.fillStyle = fill
  }

  // four legs with hooves, drawn first so the barrel overlaps their tops
  ctx.lineWidth = 1.8
  const leg = (x0, x1) => { ctx.beginPath(); ctx.moveTo(x0, 1); ctx.quadraticCurveTo((x0 + x1) / 2, 7, x1, 11.5); ctx.stroke() }
  const g = u.gallop ? 1 : 0
  leg(4, 4 + g * 4 + gait * 0.6)      // front far
  leg(-8, -8 - g * 5 - gait * 0.6)    // back far
  leg(5.5, 6 + g * 5 + gait)          // front near
  leg(-9.5, -10 - g * 3 + gait)       // back near

  // body barrel (filled)
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(-11, 0)
  ctx.quadraticCurveTo(-12.5, -5 * b, -5, -6.5 * b)
  ctx.quadraticCurveTo(1, -7 * b, 6, -3.5)
  ctx.quadraticCurveTo(8.5, -0.5, 5, 3.5)
  ctx.quadraticCurveTo(-2, 5.5, -8, 4)
  ctx.quadraticCurveTo(-12.5, 3, -11, 0)
  ctx.closePath()
  ctx.fill(); ctx.stroke()

  // tail
  ctx.lineWidth = 1.4
  ctx.beginPath()
  if (u.tailStyle === 0) { // long flowing
    ctx.moveTo(-11, -2); ctx.quadraticCurveTo(-18, 2, -16, 12)
    ctx.moveTo(-11, -1); ctx.quadraticCurveTo(-16, 3, -18, 8)
  } else { // tufted
    ctx.moveTo(-11, -1); ctx.quadraticCurveTo(-15, 4, -14, 10)
    ctx.moveTo(-11, -1); ctx.quadraticCurveTo(-13, 5, -12, 9)
  }
  ctx.stroke()

  // neck (filled tapered wedge from shoulder up to the head base)
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(4, -3)
  ctx.quadraticCurveTo(6, -6 - 3 * n, hbx - 1.5, hby + 1.5)
  ctx.lineTo(hbx + 3, hby + 1)
  ctx.quadraticCurveTo(9.5, -6 - 2 * n, 7.5, -1.5)
  ctx.closePath()
  ctx.fill(); ctx.stroke()

  // head — a horse muzzle reaching up-forward from the neck
  ctx.beginPath()
  ctx.moveTo(hbx - 1.5, hby + 1.5)                      // throat
  ctx.quadraticCurveTo(hx - 1, hy - 4, hx + 3, hy - 4.5) // poll / forehead
  ctx.quadraticCurveTo(hx + 7, hy - 4, hx + 8.5, hy - 0.8) // nose bridge
  ctx.quadraticCurveTo(hx + 9, hy + 1.4, hx + 6.5, hy + 1.8) // muzzle tip
  ctx.quadraticCurveTo(hx + 4, hy + 2, hx + 3, hy + 1)  // mouth / chin
  ctx.quadraticCurveTo(hx + 1, hy + 1.6, hbx + 3, hby + 1) // back to throat
  ctx.closePath()
  ctx.fill(); ctx.stroke()

  // ear
  ctx.beginPath()
  ctx.moveTo(hx + 1, hy - 4)
  ctx.lineTo(hx - 0.5, hy - 8)
  ctx.lineTo(hx + 3.2, hy - 5.5)
  ctx.closePath()
  ctx.fill(); ctx.stroke()

  // eye
  ctx.fillStyle = dim ? 'hsla(0,0%,95%,0.7)' : `hsla(${hue},40%,94%,0.95)`
  ctx.beginPath(); ctx.arc(hx + 3, hy - 1.8, 0.9, 0, Math.PI * 2); ctx.fill()

  // chin tuft (a few)
  if (u.beard && !dim) {
    ctx.strokeStyle = ink; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(hx + 4.5, hy + 1.6); ctx.quadraticCurveTo(hx + 3.5, hy + 5, hx + 5.5, hy + 6); ctx.stroke()
  }

  // mane along the back of the neck (styled)
  ctx.strokeStyle = `hsla(${(hue + 20) % 360},${sat},82%,0.9)`
  ctx.lineWidth = 1.3
  for (let i = 0; i <= 5; i++) {
    const p = i / 5
    const mx = 4.5 + (hbx - 4.5) * p, my = -3 + (hby - 1 - (-3)) * p
    ctx.beginPath(); ctx.moveTo(mx, my)
    if (u.mane === 0) ctx.quadraticCurveTo(mx - 4, my - 1, mx - 5, my + 3)      // flowing
    else if (u.mane === 1) ctx.lineTo(mx - 2 - p * 2, my - 3 - p * 2)           // spiky
    else ctx.lineTo(mx - 1, my - 3)                                            // bristle
    ctx.stroke()
  }

  // markings on the barrel (a second color, fixed at spawn)
  if (!dim) {
    ctx.fillStyle = `hsla(${u.spotHue},85%,72%,0.5)`
    for (const [mx, my, mr] of u.marks) { ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill() }
  }

  // horn — the brightest thing on it, and a different shape on each one
  ctx.save()
  ctx.shadowBlur = dim ? 5 : 16
  ctx.strokeStyle = dim ? 'hsla(0,0%,96%,0.65)' : `hsl(${(hue + 45) % 360},95%,85%)`
  ctx.lineWidth = 1.7
  const wx = hx + 2, wy = hy - 4, len = 8 + u.wild * 12
  ctx.beginPath()
  if (u.hornType === 1) { // straight spike
    ctx.moveTo(wx, wy); ctx.lineTo(wx + 4, wy - len)
  } else if (u.hornType === 2) { // curved back
    ctx.moveTo(wx, wy); ctx.quadraticCurveTo(wx + 3, wy - len * 0.6, wx - 2, wy - len)
  } else if (u.hornType === 3) { // branched / antler-ish
    ctx.moveTo(wx, wy); ctx.lineTo(wx + 3, wy - len)
    ctx.moveTo(wx + 1.6, wy - len * 0.5); ctx.lineTo(wx + 5, wy - len * 0.72)
    ctx.moveTo(wx + 2.3, wy - len * 0.72); ctx.lineTo(wx - 1, wy - len * 0.9)
  } else { // spiral (default)
    ctx.moveTo(wx, wy); ctx.lineTo(wx + 4, wy - len)
  }
  ctx.stroke()
  if (u.hornType === 0) { // spiral ticks
    ctx.lineWidth = 1
    const tx = wx + 4, ty = wy - len, curl = u.hornCurl
    for (let i = 1; i <= 3; i++) {
      const p = i / 4, bx = wx + (tx - wx) * p, by = wy + (ty - wy) * p
      ctx.beginPath(); ctx.moveTo(bx - 1.1 * curl, by + 0.5 * curl); ctx.lineTo(bx + 1.1 * curl, by - 0.5 * curl); ctx.stroke()
    }
  }
  ctx.restore()

  ctx.restore()
}

// Procedural night sky, all from the room seed: a base fill, a few slow drifting
// nebula bands, and a twinkling starfield. Replaces the old flat background — the
// depth is what makes the dark feel like it has something in it.
function drawSky(now) {
  ctx.fillStyle = '#05040a'
  ctx.fillRect(0, 0, innerWidth, innerHeight)
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const b of bands) {
    const yy = innerHeight * b.y + Math.sin(now * b.sp + b.ph) * innerHeight * 0.03
    const h = innerHeight * b.amp * 2
    const g = ctx.createLinearGradient(0, yy - h, 0, yy + h)
    g.addColorStop(0, 'hsla(0,0%,0%,0)')
    g.addColorStop(0.5, `hsla(${b.hue | 0},70%,55%,0.06)`)
    g.addColorStop(1, 'hsla(0,0%,0%,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, yy - h, innerWidth, h * 2)
  }
  for (const s of stars) {
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * 0.001 * s.sp + s.tw))
    ctx.globalAlpha = tw
    ctx.fillStyle = `hsla(${(sky.hue + 200) % 360},30%,${72 + tw * 22}%,1)`
    ctx.beginPath()
    ctx.arc(s.x * innerWidth, s.y * innerHeight, s.r * tw, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

// Small eyes that open in the dark, look at you, blink once, and are gone. Purely
// cosmetic (no hitbox) — the point is the half-second where you're not sure you
// saw it. Spawned on a random timer in the loop.
function drawDarkEyes() {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const e of darkEyes) {
    const p = e.t / 2600 // 0..1 lifetime
    let open = Math.min(1, p / 0.15) * (1 - Math.max(0, (p - 0.85) / 0.15))
    if (p > 0.55 && p < 0.68) open *= Math.abs((p - 0.615) / 0.065) // quick blink dip
    open = Math.max(0, open)
    const a = open * 0.55
    if (a <= 0.01) continue
    const w = e.s
    ctx.strokeStyle = `hsla(4,30%,82%,${a})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.ellipse(e.x, e.y, w, w * 0.5 * open, 0, 0, Math.PI * 2)
    ctx.stroke()
    // pupil turned toward where you're looking
    const ox = Math.max(-1, Math.min(1, (gaze.x - e.x) / (w * 3))) * w * 0.4
    const oy = Math.max(-1, Math.min(1, (gaze.y - e.y) / (w * 3))) * w * 0.2 * open
    ctx.fillStyle = `hsla(4,72%,60%,${a * 1.4})`
    ctx.shadowBlur = 8
    ctx.shadowColor = 'hsla(4,80%,55%,0.6)'
    ctx.beginPath()
    ctx.ellipse(e.x + ox, e.y + oy, w * 0.16, w * 0.42 * open, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  }
  ctx.restore()
}

// A breathing vignette — the edges of the frame slowly close in and ease back,
// like the dark is inhaling. Drawn under the HUD so the text stays readable.
function drawVignette(now) {
  const breath = 0.5 + 0.5 * Math.sin(now * 0.0004)
  const g = ctx.createRadialGradient(
    innerWidth / 2, innerHeight * 0.46, innerHeight * 0.2,
    innerWidth / 2, innerHeight * 0.5, Math.max(innerWidth, innerHeight) * 0.72
  )
  g.addColorStop(0, 'hsla(0,0%,0%,0)')
  g.addColorStop(1, `hsla(260,35%,2%,${0.5 + breath * 0.18})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, innerWidth, innerHeight)
}

// ---------- render ----------
function render(now) {
  // --- screen-space background: fills the viewport at any zoom ---
  drawSky(now)
  drawDarkEyes()
  // ambient eye-glow wash — remote players' contributions show up here too
  const g = ctx.createRadialGradient(
    innerWidth / 2, innerHeight * 0.2, 0,
    innerWidth / 2, innerHeight * 0.2, Math.max(innerWidth, innerHeight) * 0.8
  )
  g.addColorStop(0, `hsla(${sky.hue},90%,55%,${0.05 + sky.charge * 0.35})`)
  g.addColorStop(1, 'hsla(0,0%,0%,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, innerWidth, innerHeight)

  // --- the world, under the camera (zooms out as the piles claim ground) ---
  ctx.save()
  ctx.translate(CX, CY); ctx.scale(zoom, zoom); ctx.translate(-CX, -CY)

  drawStains()
  drawLures(now)
  drawBlobs(now)
  drawSkyElder(now)
  if (captionTimer > 0) drawElderCaption(now)
  drawTrail()
  drawTendrils(now)
  drawLightOrb(now)
  for (const u of herd) if (!u.gone) drawUnicorn(u)
  drawAcid()
  drawParticles()

  ctx.restore()

  // --- screen overlays ---
  drawVignette(now)
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = '13px monospace'
  ctx.fillText(
    `charge ${(sky.charge * 100 | 0)}%   peers ${peerCount}   alive ${liveCount()}   home ${deliveredCount}   taken ${lostCount}`,
    10, 20)
}

// ---------- loop ----------
let last = performance.now()
function loop(t) {
  const dt = Math.min(32, t - last)
  last = t
  elderPulse = Math.max(0, elderPulse - dt * 0.0012)
  captionTimer = Math.max(0, captionTimer - dt * 0.00032)

  // charge rises while actively dragging, decays otherwise — this alone is a
  // complete, satisfying solo game per the "offline-first" rule.
  if (light.active) {
    sky.charge = Math.min(1, sky.charge + dt * 0.0006)
    sky.hue = (sky.hue + dt * 0.02) % 360
    broadcastThrottled()
    trail.push({ x: light.x, y: light.y, hue: sky.hue, life: 1 })
    if (trail.length > 80) trail.shift()
  } else {
    sky.charge = Math.max(0, sky.charge - dt * 0.00015)
  }
  for (let i = trail.length - 1; i >= 0; i--) {
    trail[i].life -= dt * 0.0018
    if (trail[i].life <= 0) trail.splice(i, 1)
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.x += p.vx * dt * 0.1; p.y += p.vy * dt * 0.1
    p.vy += dt * 0.001 // gentle settle
    p.life -= dt * 0.0012
    if (p.life <= 0) particles.splice(i, 1)
  }

  stepHerd(dt, t)
  stepBlobs(dt)
  stepAcid(dt, t)
  topUpHerd() // the moment one dies or crosses home, another walks in
  // ease the world's growth and the camera zoom that trails it
  worldScale += (worldScaleTarget - worldScale) * 0.02
  zoom = 1 / worldScale

  // where the eye looks: snap toward locked prey, else ease toward your light, else
  // drift idly. The ease is what makes it feel like a heavy eyeball turning, not a
  // cursor teleporting.
  const [ex, ey] = skyElderPos(t)
  const [wl, wr, wt, wb] = wBounds()
  let tx, ty, ease
  if (eyeTarget) { tx = eyeTarget.x; ty = eyeTarget.y; ease = 0.16 }
  else if (light.active) { tx = light.x; ty = light.y; ease = 0.06 }
  else { tx = (wl + wr) / 2 + Math.sin(t * 0.0003) * (wr - wl) * 0.3; ty = (wt + wb) / 2 + Math.cos(t * 0.00023) * (wb - wt) * 0.2; ease = 0.02 }
  gaze.x += (tx - gaze.x) * ease
  gaze.y += (ty - gaze.y) * ease

  // pupil blows open when you're near the eye or it has locked prey, clamps back otherwise
  const near = light.active
    ? Math.max(0, 1 - Math.hypot(light.x - ex, light.y - ey) / (Math.min(innerWidth, innerHeight) * 0.45 * worldScale))
    : 0
  const want = Math.max(near, eyeTarget ? 0.9 : 0)
  pupilDilate += (want - pupilDilate) * 0.08

  // the eye inflames the whole time it watches, and only ebbs a hair — it remembers
  bloodshot = Math.min(1, Math.max(0, bloodshot + dt * (0.000008 * cfg.rot - 0.0000005)))
  // a visual heartbeat sharing the audio heartbeat's quickening tempo (throbs the veins)
  heartPhase = (heartPhase + dt * 0.001 / Math.max(0.4, 1.6 - pupilDilate * 1.1)) % 1
  irisFlush.t = Math.max(0, irisFlush.t - dt * 0.0016)
  // nictitating membrane: sweep across now and then, more often the more inflamed
  if (memb > 0) { memb += dt * 0.0026; if (memb >= 1) { memb = 0; membT = 4000 + Math.random() * 9000 } }
  else { membT -= dt * (1 + bloodshot); if (membT <= 0) memb = 0.0001 }

  // dark eyes: spawn one on a random timer, age the rest out
  nextEyeT -= dt
  if (nextEyeT <= 0) {
    nextEyeT = 4000 + Math.random() * 9000
    darkEyes.push({ x: Math.random() * innerWidth, y: innerHeight * (0.3 + Math.random() * 0.6), s: 7 + Math.random() * 11, t: 0 })
  }
  for (let i = darkEyes.length - 1; i >= 0; i--) {
    darkEyes[i].t += dt
    if (darkEyes[i].t > 2600) darkEyes.splice(i, 1)
  }

  render(t)
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

// ---------- online layer (optional — game above never depends on this) ----------
let lastBroadcast = 0
function broadcastThrottled() {
  const now = performance.now()
  if (now - lastBroadcast < 120) return // ~8/sec cap, be a good citizen on a shared relay
  lastBroadcast = now
  net.send({ t: 'sky', charge: sky.charge, hue: sky.hue })
}

const net = connectRelay(ROOM, {
  onId: () => elder('Connected to today\'s sky.'),
  onPeerJoin: (id) => { peerCount++; elder(`A rider joined (${id.slice(0, 6)}). ${peerCount} here now.`) },
  onPeerLeave: (id) => { peerCount = Math.max(0, peerCount - 1); elder(`A rider left (${id.slice(0, 6)}). ${peerCount} here now.`) },
  onMessage: (data) => {
    if (data?.t !== 'sky') return
    // fold a remote nudge into the shared local sky — additive, decayed, never
    // overwritten wholesale, so many concurrent players blend instead of fighting
    // over one authoritative value (there's no server authority to fight over anyway).
    sky.charge = Math.min(1, sky.charge * 0.7 + data.charge * 0.3)
    sky.hue = (sky.hue + (((data.hue - sky.hue + 540) % 360) - 180) * 0.15 + 360) % 360
  },
  onError: () => elder('Offline — playing solo. That\'s a fully valid way to play.'),
})
elder('A quiet sky. Drag to bring color to it.')

// ---------- live tuning panel ----------
// A small overlay of sliders bound to cfg, so you can reshape the piece as it runs.
// Built in JS (not markup) so it travels inside the single bundled file. Toggle with
// the gear button or the H key; it starts closed so it never fights the sky.
const TUNABLES = [
  ['floor', 'unicorns (min)', 3, 30, 1],
  ['trigger', 'pile awakens at', 2, 20, 1],
  ['hunger', 'eye hunger', 5, 60, 1],
  ['lure', 'symbol pull', 0, 3, 0.05],
  ['pull', 'pile pull', 0, 3, 0.05],
  ['weep', 'acid weeping', 0, 3, 0.05],
  ['creep', 'pile creep', 0, 3, 0.05],
  ['zcap', 'zoom-out', 1, 4, 0.05],
  ['rot', 'bloodshot rate', 0, 4, 0.05],
  ['vrate', 'voice speed', 0.2, 1, 0.02],
  ['vpitch', 'voice pitch', 0, 1, 0.02],
  ['grit', 'voice grit', 0, 1, 0.05],
]
function buildPanel() {
  const style = document.createElement('style')
  style.textContent =
    '#ui{position:fixed;top:8px;right:8px;z-index:9;font:11px monospace;color:#cfc8e8}' +
    '#ui button{background:rgba(10,8,20,.72);color:#cfc8e8;border:1px solid rgba(233,230,247,.22);border-radius:5px;padding:4px 8px;cursor:pointer;font:inherit}' +
    '#uip{margin-top:6px;width:186px;max-height:calc(100vh - 56px);overflow:auto;padding:6px 10px 10px;background:rgba(8,6,14,.85);border:1px solid rgba(233,230,247,.16);border-radius:7px}' +
    '#uip label{display:grid;grid-template-columns:1fr auto;gap:1px 6px;margin:8px 0 0}' +
    '#uip b{color:#b39cf2;font-weight:600}' +
    '#uip input{grid-column:1/3;width:100%;accent-color:#a06cf0;margin:2px 0 0}' +
    '#uip select{grid-column:1/3;width:100%;margin:3px 0 0;background:rgba(10,8,20,.7);color:#cfc8e8;border:1px solid rgba(233,230,247,.2);border-radius:4px;font:inherit;padding:2px}' +
    '#uip .r{width:100%;margin-top:10px}'
  document.head.append(style)

  const box = document.createElement('div'); box.id = 'ui'
  const gear = document.createElement('button'); gear.textContent = '⚙'; gear.title = 'tune (H)'
  const panel = document.createElement('div'); panel.id = 'uip'
  let open = false
  const setOpen = (v) => { open = v; panel.style.display = v ? 'block' : 'none'; gear.style.opacity = v ? 1 : 0.55 }
  gear.onclick = () => setOpen(!open)
  addEventListener('keydown', (e) => { if (e.key === 'h' || e.key === 'H') setOpen(!open) })

  const setters = []
  for (const [key, label, min, max, step] of TUNABLES) {
    const row = document.createElement('label')
    const cap = document.createElement('span'); cap.textContent = label
    const val = document.createElement('b')
    const s = document.createElement('input')
    s.type = 'range'; s.min = min; s.max = max; s.step = step; s.value = cfg[key]
    const show = () => { val.textContent = step < 1 ? (+cfg[key]).toFixed(2) : cfg[key] }
    s.oninput = () => { cfg[key] = +s.value; show() }
    show()
    row.append(cap, val, s); panel.append(row)
    setters.push(() => { s.value = cfg[key]; show() })
  }

  // voice picker — choose any installed voice directly. Value is the true index
  // into voiceList; english voices are floated to the top for convenience.
  const vrow = document.createElement('label')
  const vcap = document.createElement('span'); vcap.textContent = 'voice'
  const sel = document.createElement('select')
  const fillVoices = () => {
    sel.innerHTML = ''
    const order = [...voiceList.keys()].sort((a, b) => {
      const ea = /^en/i.test(voiceList[a].lang), eb = /^en/i.test(voiceList[b].lang)
      return ea === eb ? 0 : ea ? -1 : 1
    })
    for (const i of order) {
      const v = voiceList[i]
      const o = document.createElement('option')
      o.value = i; o.textContent = `${v.name} (${v.lang})`
      if (v === theVoice) o.selected = true
      sel.append(o)
    }
  }
  sel.onchange = () => { theVoice = voiceList[+sel.value]; voicePinned = true }
  voiceSelectRefresh = fillVoices
  fillVoices()
  vrow.append(vcap, sel); panel.append(vrow)

  const reset = document.createElement('button'); reset.textContent = 'reset'; reset.className = 'r'
  reset.onclick = () => {
    Object.assign(cfg, DEFAULTS); for (const f of setters) f()
    voicePinned = false; loadVoices() // re-pick the auto voice and refresh the dropdown
  }
  panel.append(reset)

  box.append(gear, panel); document.body.append(box)
  setOpen(false)
}
buildPanel()
