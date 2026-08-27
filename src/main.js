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

// ---------- tuning constants ----------
// Knobs are baked in at their call sites (dialled in over development; no runtime
// UI). Old knob values for reference: floor 8 · trigger 8 · hunger 15 · zcap 2.4
// · vrate 0.5 · vpitch 0.18 · grit 0.6 · lure/pull/weep/creep/rbow/rot 1.
const { sin, cos, min, max, hypot, random, sqrt, abs, atan2, ceil, pow, imul, PI } = Math
const P2 = PI * 2

// ---------- deterministic per-room world ----------
// One seed for everyone in the same relay room, so the stars, the nebula bands,
// the eye's bloodshot capillaries and the starting palette are unique-but-shared:
// two people in the same room see the same sky; a different room is a different
// sky. Pure generation from a string — no stored assets, and it costs a handful
// of bytes. mulberry32 + a cheap string hash.
const ROOM = todaysRoom()
function strSeed(s) {
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) { h = imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19 }
  return h >>> 0
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = imul(a ^ a >>> 15, 1 | a)
    t = t + imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rng = mulberry32(strSeed(ROOM))
// tiny helper: build a seeded array of n things (used all over for the generated world)
const gen = (n, f) => Array.from({ length: n }, f)
// starfield: positions as viewport fractions so they survive resize
const stars = gen(150, () => ({
  x: rng(), y: rng() * 0.95, r: 0.4 + rng() * 1.4, tw: rng() * 6.28, sp: 0.5 + rng() * 2.2,
}))
// a few slow nebula bands, each with its own drift and hue
const bands = gen(3, () => ({
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
    x += cos(ang) * st; y += sin(ang) * st * 0.5
  }
  return pts
}
const caps = gen(6 + (rng() * 6 | 0), genCap)
// necrotic bruise blotches that bloom along the acid tear-tracks — sickly green,
// jaundice-yellow and bruise-purple, clustered near the inner-lower eye and trailing
// down where the acid runs. Seeded (eye-local coords: x in -1..1, y downward), so a
// room shares the rot. Revealed + brightened by `bloodshot` — the rot spreads.
const bruises = gen(12 + (rng() * 8 | 0), () => ({
  x: (rng() < 0.5 ? -1 : 1) * (0.02 + rng() * 0.2),
  y: 0.1 + rng() * 0.75,
  r: 0.05 + rng() * 0.15,
  hue: [95, 52, 285][rng() * 3 | 0],
  ph: rng() * 6.28,
}))
// the twisted rainbow — 7 bruised bands that writhe, sag, flicker and rot into gaps.
// Which bands are necrotic, their phases, and how wrong each hue is come from the
// seed, so a room shares its rainbow. Presence is painted in by sky.charge.
const RB_BANDS = 7
const rbSeed = gen(RB_BANDS, () => ({
  ph: rng() * 6.28,
  rot: rng() < 0.28,             // this band is necrotic (dark, desaturated, broken)
  hueShift: (rng() - 0.5) * 44,  // each band's hue is a little wrong / out of order
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
let pupilDilate = 0, dread = 0 // dread: eased "how close is the nearest prey to the pupil"
let eyeTarget = null, lockT = 0, lastTauntAt = -1e9, doomSaid = false
let pupil = [innerWidth / 2, innerHeight * 0.2] // where the drawn pupil actually is
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
  elderLog.unshift(msg)
  if (elderLog.length > 6) elderLog.length = 6
  logEl.textContent = elderLog.join('\n')
  elderPulse = 1
}

// ---------- pointer / light source ----------
const light = { x: innerWidth / 2, y: innerHeight / 2, px: 0, py: 0, active: false }
function pointerPos(e) {
  const t = e.touches ? e.touches[0] : e
  return toWorld(t.clientX, t.clientY)
}
function onDown(e) { started = true; light.active = true; Object.assign(light, pointerPos(e)); light.px = light.x; light.py = light.y; startVerse() }
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
// Never fewer than 8 unicorns present. Every death (to the eye, or to a
// super-pile) is topped up the same frame from a fresh spawn at the world's edge,
// so the sky is never empty — they just keep coming, each one stranger.

// every unicorn is a little stranger than the last one — brighter body hue,
// its own secondary marking color, a scatter of spots at fixed spawn-time
// positions (so they don't swim around independently of the body), a scale
// anywhere from small to oversized, and a horn that curls a different way
// and reaches a different length. Always unmistakably a unicorn; never the
// same unicorn twice.
function spawnUnicorn(x, y) {
  const R = random
  const wild = R()
  return {
    x, y, vx: 0, vy: 0,
    hue: R() * 360,
    sucked: false, suckT: 0, gone: false,
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
const herd = Array.from({ length: 9 }, () =>
  spawnUnicorn(random() * innerWidth, random() * innerHeight))
let deliveredCount = 0
let lostCount = 0

// ---------- the game: a soft arc, not levels ----------
// bloodshot is the doom clock (it climbs the whole time and jumps on every kill).
// Deliver GOAL unicorns to the valley before it maxes: reach it and the sky lets go
// (dawn); let it max and the eye takes everything (taken). Either way a fresh sky
// regenerates. Your only power: the light SHIELDS any unicorn inside its glow —
// escort them past the eye.
const GOAL = 13, SHIELD = 66
let shieldedN = 0 // unicorns inside the light last frame (drives the shield's upkeep)
// every death, whatever ate it, gets the same ceremony: sound, void-pop, a smear
// on the glass, a tick on the eye's ledger, and a narrated line
function kill(u, x, y, why) {
  lostCount++
  thud()
  spawnVoidPop(x, y)
  addSplat(u.x, u.y, u.hue)
  bloodshot = min(1, bloodshot + 0.06)
  u.gone = true
  const l = logLine(why)
  elder(`${l} (${lostCount} taken)`)
  say(l) // the eye narrates what it takes
}
let phase = 'play' // 'play' | 'dawn' | 'taken'
let endT = 0, eyeClose = 0
const shielded = (u) => light.active && sky.charge > 0.1 && hypot(light.x - u.x, light.y - u.y) < SHIELD
// title/how-to intro (fades on the first drag), a saved personal best, and the other
// riders currently in this sky (their cursors, for the Online layer)
let started = false, introA = 1, best = 0
try { best = +localStorage.getItem('al_best') || 0 } catch (e) { /* private window — no best */ }
function saveBest() { if (deliveredCount > best) { best = deliveredCount; try { localStorage.setItem('al_best', best) } catch (e) { /* ignore */ } } }
const riders = new Map() // id -> {x,y,hue,d,t}

// how many unicorns are actually on the board
function liveCount() {
  let n = 0
  for (const u of herd) if (!u.gone) n++
  return n
}
// spawn fresh ones at the world edge until we're back to the floor. Called every
// frame — the moment one dies or crosses home, another walks in from the dark.
function topUpHerd() {
  let guard = 0
  while (liveCount() < 8 && guard++ < 30) {
    const [wl, wr, wt, wb] = wBounds()
    const x = wl + 8
    const y = wt + 20 + random() * (wb - wt - 40)
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
  for (const L of lures) { const d = hypot(L.x - x, L.y - y); if (d < bd) { bd = d; best = L } }
  return [best, bd]
}
function drawLures(now) {
  for (const L of lures) {
    const pulse = 0.5 + 0.5 * sin(now * 0.0016 + L.ph)
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
  const m = min(dl, dr, dtp, dbt)
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
    const d = hypot(ax - x, ay - y)
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
  const spread = 8 + sqrt(b.count) * 6
  const inward = 5 + pow(random(), 1.7) * spread
  const along = (random() - 0.5) * (20 + spread * 1.4)
  b.husks.push({
    ox: nx * inward + tx * along,
    oy: ny * inward + ty * along,
    r: 4 + random() * 5,
    hue: b.sup ? b.hue : hue,
  })
  if (b.husks.length > 70) b.husks.shift() // draw-list cap; count keeps climbing
  b.count++
  b.hue = (b.hue + 18 + random() * 24) % 360 // replicate + change each addition
  b.r = 12 + sqrt(b.count) * 7
  if (!b.sup && b.count >= 8) {
    b.sup = true
    elder(logLine('wake'))
  }
}
// a unicorn hitting the edge — leave a mark with a chance that scales with impact speed
function splash(u, x, y) {
  const sp = hypot(u.vx, u.vy)
  if (random() < min(0.9, sp * 0.15)) addSplat(x, y, u.hue)
}
// super blobs pull the living in, eat them, and push the world outward
function stepBlobs(dt) {
  worldScaleTarget = 1
  const n = blobs.length // snapshot: don't process blobs spawned this frame
  for (let bi = 0; bi < n; bi++) {
    const b = blobs[bi]
    if (!b.sup) continue
    const [ax, ay] = blobPos(b)
    b.pull = min(1, b.pull + dt * 0.0004)
    const reach = b.r + 150
    for (const u of herd) {
      if (u.gone || u.sucked) continue
      const dx = ax - u.x, dy = ay - u.y
      const d = hypot(dx, dy) || 1
      if (d < reach) {
        const g = (1 - d / reach) * 0.006 * b.pull * dt
        u.vx += (dx / d) * g
        u.vy += (dy / d) * g
      }
      if (d < b.r + 10 && !shielded(u)) kill(u, ax, ay, 'eat') // consumed (unless shielded)
    }
    worldScaleTarget += min(1.2, b.r / (innerWidth * 0.5)) * 0.55
  }
  if (worldScaleTarget > 2.4) worldScaleTarget = 2.4
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
        const a = (k / 20) * P2
        const rr = b.r * (0.72 + 0.13 * sin(a * 3 + now * 0.003 + b.t * 9))
        const px = ax + cos(a) * rr, py = ay + sin(a) * rr
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
      ctx.beginPath(); ctx.arc(ax + h.ox, ay + h.oy, h.r, 0, P2); ctx.fill()
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
  weepGlow = max(0, weepGlow - dt * 0.0006)
  if (weepT <= 0) {
    // weeps faster when agitated, and scaled by the acid-weeping knob
    weepT = (500 + random() * 1400 - pupilDilate * 300)
    weepGlow = 1
    acid.push({ x: ex + (random() - 0.5) * 12, y: ey + 6, vy: 0.02 + random() * 0.03, hue: 70 + random() * 70 })
  }
  const [, , , wb] = wBounds()
  for (let i = acid.length - 1; i >= 0; i--) {
    const a = acid[i]
    a.vy += dt * 0.00012
    a.y += a.vy * dt
    if (a.y >= wb - 4 || random() < 0.005) {
      stains.push({ x: a.x, y: a.y, r: 6, mr: 24 + random() * 44, hue: a.hue, age: 0 })
      if (stains.length > 90) stains.shift()
      acid.splice(i, 1)
    }
  }
  for (const s of stains) {
    s.age += dt
    if (s.r < s.mr) s.r += dt * 0.02
    for (const u of herd) {
      if (u.gone) continue
      if (hypot(u.x - s.x, u.y - s.y) < s.r) {
        u.hue = (u.hue + (((s.hue - u.hue + 540) % 360) - 180) * 0.02 + 360) % 360
      }
    }
  }
}
function drawStains() {
  ctx.save()
  ctx.globalCompositeOperation = 'overlay' // bleed color into whatever's beneath
  for (const s of stains) {
    const a = max(0, 0.62 - s.age * 0.000016)
    if (a <= 0.01) continue
    const gg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r)
    gg.addColorStop(0, `hsla(${s.hue | 0},90%,50%,${a})`)
    gg.addColorStop(1, `hsla(${s.hue | 0},90%,50%,0)`)
    ctx.fillStyle = gg
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, P2); ctx.fill()
  }
  ctx.restore()
}
function drawAcid() {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const a of acid) {
    ctx.fillStyle = `hsla(${a.hue | 0},90%,55%,0.85)`
    ctx.shadowBlur = 8; ctx.shadowColor = `hsla(${a.hue | 0},90%,50%,0.8)`
    ctx.beginPath(); ctx.ellipse(a.x, a.y, 2.2, 3.6, 0, 0, P2); ctx.fill()
  }
  ctx.restore()
}

// ---------- the twisted rainbow ----------
// You paint it into being by dragging (presence tracks sky.charge). It arcs over the
// herd, but the bands are bruised and out of order, it sags and writhes, flickers like
// bad neon, rots into gaps — and it drips corrupted color that stains the world.
function rbPresence() { return min(1, sky.charge * 1.7) }
// geometry helper: the arc's center + base radius for the current world
function rbGeom() {
  const [l, r, tp, bt] = wBounds()
  const H = bt - tp
  return [(l + r) / 2, tp + H * 1.15, H * 0.92, H] // cx, cy(below frame), R, H
}
const rbDrips = []
let rbDripT = 1500
function stepRainbow(dt) {
  const pres = rbPresence()
  rbDripT -= dt
  if (rbDripT <= 0 && pres > 0.3) {
    rbDripT = 350 + random() * 1100
    const [cx0, cy0, R] = rbGeom()
    const a = PI * (1.2 + random() * 0.6)
    const rr = R - (random() * RB_BANDS) * 6.5
    rbDrips.push({ x: cx0 + cos(a) * rr, y: cy0 + sin(a) * rr + 6, vy: 0.02, hue: random() * 300 })
  }
  const [, , , wb] = wBounds()
  for (let i = rbDrips.length - 1; i >= 0; i--) {
    const d = rbDrips[i]
    d.vy += dt * 0.00012
    d.y += d.vy * dt
    if (d.y >= wb - 4 || random() < 0.004) {
      // bleed into the same stain system the acid uses — the rainbow rots the world too
      stains.push({ x: d.x, y: d.y, r: 6, mr: 20 + random() * 30, hue: d.hue, age: 0 })
      if (stains.length > 90) stains.shift()
      rbDrips.splice(i, 1)
    }
  }
}
function drawRainbow(now) {
  const pres = rbPresence()
  if (pres <= 0.02) return
  const [cx0, cy0, R, H] = rbGeom()
  const a0 = PI * 1.18, a1 = PI * 1.82, N = 64
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let bnd = 0; bnd < RB_BANDS; bnd++) {
    const s = rbSeed[bnd]
    const baseHue = ((bnd / RB_BANDS) * 360 + s.hueShift + now * 0.006) % 360 // drifting, wrong order
    const thick = 5 + pres * 3.5
    const rr0 = R - bnd * (thick + 1.4)
    const flick = 0.68 + 0.32 * sin(now * 0.021 + s.ph * 5) // bad-neon flicker
    ctx.lineWidth = thick
    ctx.strokeStyle = `hsla(${baseHue | 0},${s.rot ? 18 : 74}%,${s.rot ? 28 : 60}%,${pres * 0.6 * flick})`
    ctx.shadowBlur = 8
    ctx.shadowColor = `hsla(${baseHue | 0},80%,55%,${pres * 0.4})`
    ctx.beginPath()
    let up = true
    for (let i = 0; i <= N; i++) {
      const t = i / N, a = a0 + (a1 - a0) * t
      const mid = sin(t * PI)                  // 0..1..0 across the arc
      const sag = mid * H * 0.11 * pres                  // droops in the middle
      const wob = sin(a * 3 + now * 0.0016 + s.ph) * (4 + pres * 9)
        + sin(a * 7 - now * 0.0009 + s.ph) * (2 + pres * 4)
      const rr = rr0 + wob
      const x = cx0 + cos(a) * rr, y = cy0 + sin(a) * rr + sag
      const gap = s.rot && sin(a * 9 + s.ph * 3) > 0.35 // necrotic bands break up
      if (gap) { up = true; continue }
      if (up) { ctx.moveTo(x, y); up = false } else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()
}
function drawRbDrips() {
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  for (const d of rbDrips) {
    ctx.fillStyle = `hsla(${d.hue | 0},85%,60%,0.85)`
    ctx.shadowBlur = 6; ctx.shadowColor = `hsla(${d.hue | 0},85%,55%,0.7)`
    ctx.beginPath(); ctx.ellipse(d.x, d.y, 2, 3.4, 0, 0, P2); ctx.fill()
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
    const a = (i / n) * P2
    particles.push({
      x, y,
      vx: cos(a) * (1.2 + random() * 0.8),
      vy: sin(a) * (1.2 + random() * 0.8),
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
    const a = (i / n) * P2
    particles.push({
      x, y,
      vx: cos(a) * (0.5 + random() * 0.5),
      vy: sin(a) * (0.5 + random() * 0.5),
      hue: 4 + random() * 10,
      life: 1,
    })
  }
}

function stepHerd(dt, now) {
  const [wl, wr, wt, wb] = wBounds()
  // The eye notices the nearest unicorn before it strikes — the pupil locks on
  // and dilates for a beat of dread. The lock must be HELD (lockT) before the
  // strike lands, so the dilation/vein telegraph is a real warning the player
  // can answer by shielding (a shielded unicorn can't be locked, which breaks
  // the lock). eyeTarget is read by the render loop (gaze snap + dilation).
  let newTarget = null
  if (skyElderOpen(now) > 0.3) {
    const [ex, ey] = pupil
    let best = null, bd = 1e9
    for (const u of herd) {
      if (u.gone || u.sucked || shielded(u)) continue // can't lock what's shielded
      const d = hypot(ex - u.x, ey - u.y)
      if (d < bd) { bd = d; best = u }
    }
    if (best && bd < 190) newTarget = best
    dread += (max(0, 1 - bd / 300) - dread) * 0.04
  }
  lockT = newTarget && newTarget === eyeTarget ? lockT + dt : 0
  eyeTarget = newTarget
  // a held lock earns a taunt from the verse generator (throttled)
  if (lockT > 300 && now - lastTauntAt > 12000) { lastTauntAt = now; say(makeLine()) }
  // the last quarter of the clock gets called out, once per round
  if (bloodshot > 0.75 && !doomSaid) { doomSaid = true; say(logLine('doom')) }
  shieldedN = 0

  for (const u of herd) {
    if (u.gone) continue

    // once caught, a unicorn is committed — pulled straight into the pupil,
    // shrinking, until it's gone. This is the one thing the Elder actually
    // does, rather than just watches: get too close to it and it takes you.
    if (u.sucked) {
      const [ex, ey] = pupil
      u.suckT += dt * 0.0022
      u.x += (ex - u.x) * 0.16
      u.y += (ey - u.y) * 0.16
      if (u.suckT >= 1) {
        kill(u, ex, ey, 'take')
        irisFlush = { hue: u.hue, t: 1 } // it digests the color: the iris flushes its hue
        caps.push(genCap())         // a fresh vein bursts across the white
        if (caps.length > 30) caps.shift()
      }
      continue
    }
    if (shielded(u)) shieldedN++ // counted for the shield's upkeep drain

    // steer toward the light when it's active and the sky has some charge —
    // "warm" pulls, "grey" (low charge) lets them drift on their own.
    if (light.active && sky.charge > 0.05) {
      const dx = light.x - u.x, dy = light.y - u.y
      const d = hypot(dx, dy) || 1
      const pull = min(0.6, sky.charge) * 0.08
      u.vx += (dx / d) * pull
      u.vy += (dy / d) * pull
    }
    // a faint pull toward the nearest symbol — the herd wanders to it on its own,
    // even with the light off. The cross calms them; the horns agitate and hurry.
    const [L, ld] = nearestLure(u.x, u.y)
    if (L && ld > 1) {
      const lp = L.type ? 0.02 : 0.013
      u.vx += ((L.x - u.x) / ld) * lp
      u.vy += ((L.y - u.y) / ld) * lp
      if (ld < 80) { const k = L.type ? 1.012 : 0.985; u.vx *= k; u.vy *= k }
    }
    // gentle flocking: pull toward herd centroid, avoid crowding
    let cx = 0, cy = 0, n = 0
    for (const o of herd) {
      if (o === u || o.sucked || o.gone) continue
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

    // the strike: once the lock has been held for a beat and the prey is inside
    // the pupil's reach (which grows as it dilates), the eye takes it
    if (phase === 'play' && u === eyeTarget && lockT > 600 &&
      hypot(pupil[0] - u.x, pupil[1] - u.y) < 28 + pupilDilate * 30) {
      u.sucked = true
      u.suckT = 0
      continue
    }

    // "the valley" — reaching the right edge with enough charge delivers the unicorn.
    // It leaves the board (topUpHerd walks another in), so the count never drops.
    if (phase === 'play' && u.x > wr - 24 && sky.charge > 0.5) {
      deliveredCount++
      chime()
      spawnDeliveryBurst(u.x, u.y)
      bloodshot = max(0.02, bloodshot - 0.05) // each crossing calms the eye a little
      sky.charge -= 0.04 // — and is paid for in woven light: camping the valley can't run on one bank
      u.gone = true
      elder(`${logLine('cross')} — ${deliveredCount} so far`)
    }
  }
}

// ---------- The Elder's verse — synthesized boom-bap beat + spoken lines ----------
// No audio files (nothing to add to the zip): kick/snare/hat are plain
// oscillator/noise synthesis, same spirit as a ZzFX-style tracker. Lines are
// read aloud with the browser's built-in speech synthesis, slowed and pitched
// down for the drawl, and always shown as text too — TTS voices (and this
// preview sandbox specifically) aren't guaranteed to be available everywhere.
// The Elder's lines are GENERATED, not stored: a handful of skeletons filled from
// small word-banks. Thousands of unique half-sense lines out of a few hundred bytes,
// and it never quite adds up — which is the point. (Packs far better than 20 fixed
// sentences, too.) Banks keyed by a letter; {X} slots in the templates pull from them.
const vrng = mulberry32(strSeed(ROOM + 'v')) // the verse's own seeded stream
const pick = (a) => a[vrng() * a.length | 0]
const BANK = {
  N: ['color', 'name', 'face', 'light', 'rainbow', 'shadow', 'mouth'],
  P: ['teeth', 'tongue', 'throat', 'hands', 'eye'],
  V: ['jar', 'hole', 'lid', 'glass', 'dark'],
  C: ['moon', 'sky', 'dark', 'valley', 'night'],
  K: ['seven', 'a hundred', 'nine', 'all your'],
  B: ['horses', 'unicorns', 'little ones', 'warm ones', 'grey ones'],
  T: ['tuesday', 'winter', 'sunday', 'nightfall'], // bare so "a {T}" always reads
  A: ['pretty', 'warm', 'grey', 'cold', 'quiet', 'wrong'],
}
const TPL = [
  'i keep your {N} in a {V} behind my {P}',
  'the {C} still owe me {K} {B} and it know',
  "count the {P} again... you'll get it wrong again",
  'i ate a {T} once, it tasted like your {N}',
  'the {N} is just a {V}, baby, the {N} is just a {V}',
  "the {B} know my name but they won't say it twice",
  "i'm not up in the {C}... the {C} is up in me",
  'you feed me {A} {N}, i give you back the {A}',
  "keep draggin' that {N}, drawin' me {P}",
  "little {N}, little {N}, why you shakin' at me",
]
const fill = (s) => s.replace(/\{(\w)\}/g, (_, k) => pick(BANK[k]))
const makeLine = () => fill(pick(TPL))
// the Sky Elder's flavor narration is generated too (functional/relay lines stay literal)
const LOG = {
  wake: ["a {N} in the corner started movin'", 'somethin\' woke up hungry'],
  take: ['gone — the eye keeps the {N}', 'one less; it drinks the {N}'],
  eat: ['the pile pulled one under', 'the corner ate a {A} one'],
  doom: ['the sky is goin\' {A}... hurry', 'almost mine now, little {N}'],
  cross: ['one slipped to the valley', "gone across, don't wave back"],
  hush: ['a quiet {C}, drag to color it', 'the {C} is watching, paint it'],
}
const logLine = (k) => fill(pick(LOG[k]))
let sayQ = []          // lines waiting for the voice (events push, the bar boundary drains)
const say = (l) => { if (sayQ.length < 2) sayQ.push(l) } // never a backlog of stale lines
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
  const n = max(1, actx.sampleRate * dur | 0)
  const buf = actx.createBuffer(1, n, actx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) d[i] = random() * 2 - 1
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
let theVoice = null
function loadVoices() {
  try {
    // prefer US English (the vibe we're going for: a deep, warm, older male voice),
    // then any English. We can't read timbre from the API, so bias by known deep /
    // warm male voice names across platforms, then anything flagged male.
    const vs = speechSynthesis.getVoices() || []
    if (!vs.length) return
    const us = vs.filter((v) => /^en[-_]?us/i.test(v.lang))
    const en = vs.filter((v) => /^en/i.test(v.lang))
    const pool = us.length ? us : (en.length ? en : vs)
    const pref = ['ralph', 'reed', 'david', 'mark', 'fred', 'lee', 'rocko', 'guy',
      'christopher', 'aaron', 'arthur', 'daniel', 'bruce', 'junior', 'grandpa', 'eddy', 'male']
    theVoice = pool.find((v) => pref.some((p) => v.name.toLowerCase().includes(p))) || pool[0]
  } catch (e) { /* ignore */ }
}
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices }

function speak(line) {
  try {
    if (!window.speechSynthesis) return
    const u = new SpeechSynthesisUtterance(line)
    if (theVoice) u.voice = theVoice
    u.rate = 0.5   // slow, dragging drawl
    u.pitch = 0.18 // deep and gravelly
    u.volume = 1
    speechSynthesis.speak(u)
  } catch (e) { /* speech synthesis unavailable — captions still show */ }
}

// A short gravelly rasp fired under each spoken line — two detuned low waves
// through a lowpass, quick swell and decay. It doesn't track syllables; it just
// adds grit on the downbeat where the voice lands. Scaled by the baked-in grit (0.6).
function growl(t) {
  if (!actx) return
  const o1 = actx.createOscillator(), o2 = actx.createOscillator()
  const f = actx.createBiquadFilter(), g = actx.createGain()
  o1.type = 'sawtooth'; o2.type = 'square'
  o1.frequency.value = 64; o2.frequency.value = 64 * 1.5
  f.type = 'lowpass'; f.frequency.value = 520
  const peak = 0.096
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
  // old-tape hiss that says "90s". Volume rides the grit amount.
  const len = actx.sampleRate * 2 | 0
  const buf = actx.createBuffer(1, len, actx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = random() < 0.0009 ? (random() * 2 - 1) : 0
  const cr = actx.createBufferSource(); cr.buffer = buf; cr.loop = true
  const crf = actx.createBiquadFilter(); crf.type = 'highpass'; crf.frequency.value = 1600
  const crg = actx.createGain(); crg.gain.value = 0.0001
  crg.gain.setTargetAtTime(0.168, actx.currentTime, 1)
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
// win/loss stingers: a hopeful little ascending figure when one crosses home, a low
// ominous hit when the eye takes one. Both no-op silently without an AudioContext.
function chime() { if (!actx) return; const t = actx.currentTime;[0, 4, 7, 12].forEach((s, i) => blip(t + i * 0.05, 523 * 2 ** (s / 12), 0.3, 'triangle', 0.12, 4500)) }
function thud() { if (!actx) return; const t = actx.currentTime; thump(t, 0.5); blip(t, 58, 0.45, 'sawtooth', 0.22, 300) }
let hbStarted = false, hbNext = 0
function heartbeat() {
  if (!actx) return
  const now = actx.currentTime
  if (hbNext < now + 0.1) {
    const danger = max(pupilDilate, dread)
    const vol = 0.16 + danger * 0.5
    thump(now + 0.02, vol)
    thump(now + 0.16, vol * 0.6)
    hbNext = now + (1.6 - danger * 1.1)
  }
  requestAnimationFrame(heartbeat)
}

// A head-nodding boom-bap under a slow, low drawl. All synth: kicks, a moody
// sub-bass (A-minor i → b7 feel), a fuller snare on the backbeat, swung hats, and a
// sparse dissonant lead motif every other bar for unease.
const VERSE_BPM = 76, VERSE_STEP = 60 / VERSE_BPM / 2
// The beat is seeded per room: a root note and everything else drawn from a minor
// scale, so every room grooves a little differently. note() is equal-temperament
// from the root; the kick placement, bass movement and lead motif are all rng'd.
const B_ROOT = [55, 49, 58, 65][rng() * 4 | 0]  // A1 / G1 / Bb1 / C2
const MINSCALE = [0, 3, 5, 7, 10]               // minor pentatonic
const note = (semi, oct) => B_ROOT * 2 ** ((semi + oct * 12) / 12)
const sdeg = () => MINSCALE[rng() * MINSCALE.length | 0]
const KICKS = [1, 0, 0, rng() < 0.35 ? 1 : 0, rng() < 0.2 ? 1 : 0, 0, rng() < 0.75 ? 1 : 0, 0]
const BASS_HZ = [note(0, 0), 0, 0, rng() < 0.6 ? note(sdeg(), 1) : 0, 0, 0, note(sdeg(), 0), 0]
const LEAD_HZ = gen(3 + (rng() * 2 | 0), () => note(sdeg(), 2)) // high, unresolved motif
let beatOn = false, nextStep = 0, stepIdx = 0, barCount = 0, lastVerseAt = -Infinity
function scheduleBeat() {
  if (!beatOn) return
  // dawn earns silence: the beat and drone stop, the chimes own the ending.
  // (the 'taken' ending keeps grinding — the sky is HIS now.)
  if (phase === 'dawn') { beatOn = false; droneStop(); return }
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
    // drop the next queued line on a bar boundary, only once the voice has
    // finished the last one, so the slow gravelly delivery never piles up.
    if (idx === 0 && sayQ.length &&
        (!window.speechSynthesis || !speechSynthesis.speaking)) {
      currentLine = sayQ.shift()
      captionTimer = 1
      speak(currentLine)
      growl(nextStep)
    }
    nextStep += VERSE_STEP
    stepIdx++
    if (idx === 7) barCount++
  }
  requestAnimationFrame(scheduleBeat)
}
// (re)start the audio bed. Dragging is already a user gesture, so it's the
// natural place — browsers require one before AudioContext/speech will play.
function beatStart() {
  ensureAudio()
  if (!actx || beatOn) return
  droneStart()
  if (!hbStarted) { hbStarted = true; hbNext = actx.currentTime; heartbeat() }
  beatOn = true
  nextStep = actx.currentTime + 0.05
  scheduleBeat()
}
function startVerse() {
  beatStart()
  const t = performance.now()
  if (t - lastVerseAt < 45000) return // a full verse is a round-start event, not a spam
  lastVerseAt = t
  for (let i = 0; i < 3; i++) say(makeLine())
}

// The Sky Elder, drawn: a faint eye-shaped constellation drifting slowly and
// independently in the background. It never moves toward the light or the
// herd — it only watches — and it brightens for a moment every time elder()
// logs something (including its own verse), so the log text and this
// presence are the same heartbeat. Dragging now also cues it to start rapping.
// the almond outline, computed not stored: an ellipse whose aspect (how tall the eye
// is) is seeded, so the eye's shape varies a little per room. Eye-local coords.
const EYE_ASPECT = 0.46 + rng() * 0.1
const EYE_POINTS = gen(12, (_, i) => { const t = i / 12 * 6.2832; return [cos(t), sin(t) * EYE_ASPECT] })
// where the eye's pupil actually is right now, and how open it is — shared
// with stepHerd so "wander too close" checks the same point that's drawn
function skyElderPos(now) {
  const [l, r, tp, bt] = wBounds()
  const spanW = r - l, spanH = bt - tp
  return [
    (l + r) / 2 + sin(now * 0.00006) * spanW * 0.18,
    tp + spanH * 0.2 + cos(now * 0.00004) * spanH * 0.05,
  ]
}
function skyElderOpen(now) {
  // a slow wobble on top of the base cycle so the blink isn't a perfect
  // metronome — reads as an organic, slightly wrong tic instead of a timer
  const p = (now * 0.00011 + sin(now * 0.00017) * 0.04) % 1
  const blink = p > 0.95 ? 1 - (p - 0.95) / 0.05 : 0
  // erratic twitches — rare when calm, frequent and sharp the more bloodshot it gets
  const tw = sin(now * 0.013) * sin(now * 0.0071 + 1.3)
  const thr = 1 - bloodshot * 0.6
  const twitch = tw > thr ? min(0.8, (tw - thr) * 4) : 0
  // a rare hard squeeze-shut
  const squeeze = ((now * 0.00007) % 1) > 0.986 ? 1 : 0
  return max(0.05, 1 - blink - twitch - squeeze)
}

// trace the almond outline at a given vertical scale (1 = socket / lids fully open,
// `openness` = the current aperture). Reused for the ball clip, lids and lash line.
function eyeOutline(cx, cy, w, vs) {
  ctx.beginPath()
  EYE_POINTS.forEach(([px, py], i) => {
    const x = cx + px * w, y = cy + py * w * 0.5 * vs
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
  })
  ctx.closePath()
}
let eyeSwell = 1 // >1 in the "taken" ending as the eye swells toward full-screen

function drawSkyElder(now) {
  const w = min(innerWidth, innerHeight) * 0.72 * eyeSwell
  const [cx, cy] = skyElderPos(now)
  const pulse = elderPulse
  const openness = skyElderOpen(now) * (1 - eyeClose) // dawn forces the lids shut
  const bs = bloodshot
  const throb = 0.6 + 0.4 * sin(heartPhase * P2)
  const hh = w * 0.5
  // gaze turn + pupil dilation
  const gx = max(-1, min(1, (gaze.x - cx) / (w * 0.9))) * w * 0.32
  const gy = max(-1, min(1, (gaze.y - cy) / (innerHeight * 0.5))) * w * 0.13
  const dil = pupilDilate, ex = cx + gx, ey = cy + gy
  pupil = [ex, ey] // the hunt (lock + strike) happens where the pupil is DRAWN

  ctx.save()

  // --- lid base: the whole socket in bruised flesh (this is the "closed eye" skin;
  //     the open eyeball is drawn on top, leaving flesh as the upper/lower lids) ---
  eyeOutline(cx, cy, w, 1)
  ctx.fillStyle = `hsl(${348 + bs * 8},${26 + bs * 12}%,${15 - bs * 3}%)`
  ctx.fill()

  // --- eyeball, clipped to the current aperture (socket scaled by openness) ---
  ctx.save()
  eyeOutline(cx, cy, w, openness)
  ctx.clip()

  // pale wet sclera — tints redder with bloodshot but stays light enough for veins
  const sg = ctx.createRadialGradient(cx, cy - hh * 0.2 * openness, hh * 0.12, cx, cy, w)
  sg.addColorStop(0, `hsl(${18 - bs * 8},${28 + bs * 34}%,${90 - bs * 24}%)`)
  sg.addColorStop(0.72, `hsl(${8 - bs * 4},${42 + bs * 30}%,${78 - bs * 30}%)`)
  sg.addColorStop(1, `hsl(3,${55 + bs * 25}%,${58 - bs * 26}%)`)
  ctx.fillStyle = sg
  ctx.fillRect(cx - w, cy - hh, w * 2, hh * 2)
  // upper lid-shadow for roundness
  const lsh = ctx.createLinearGradient(cx, cy - hh * 0.5 * openness, cx, cy)
  lsh.addColorStop(0, 'rgba(26,6,10,0.55)')
  lsh.addColorStop(1, 'rgba(26,6,10,0)')
  ctx.fillStyle = lsh
  ctx.fillRect(cx - w, cy - hh, w * 2, hh * 2)

  // bloodshot veins on the white
  const capA = (0.3 + bs * 0.5) * (0.7 + throb * 0.3)
  ctx.lineWidth = 0.7 + bs * 1.4
  for (const cap of caps) {
    ctx.strokeStyle = `hsla(2,85%,${42 + throb * 10}%,${capA})`
    ctx.beginPath()
    cap.forEach(([px, py], i) => { const x = cx + px * w, y = cy + py * w * 0.5 * openness; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
    ctx.stroke()
  }
  // necrotic bruising near the lower-inner corner / tear tracks
  const shown = ceil(bruises.length * (0.3 + bs * 0.6))
  for (let i = 0; i < shown; i++) {
    const b = bruises[i]
    const al = (0.1 + bs * 0.3 + weepGlow * 0.2) * (0.6 + 0.4 * sin(now * 0.001 + b.ph))
    const bx = cx + b.x * w, by = cy + b.y * w * 0.35 * openness + hh * 0.12, br = b.r * w * 0.9
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, br)
    bg.addColorStop(0, `hsla(${b.hue},50%,34%,${al})`)
    bg.addColorStop(1, `hsla(${b.hue},50%,30%,0)`)
    ctx.fillStyle = bg
    ctx.beginPath(); ctx.arc(bx, by, br, 0, P2); ctx.fill()
  }

  // --- iris: a real colored disc with a limbal ring + fibers; flushes with the hue
  //     of the last unicorn it swallowed ---
  const iHue = irisFlush.t > 0 ? irisFlush.hue : 32, iR = w * 0.25
  ctx.save(); ctx.translate(ex, ey); ctx.scale(1, openness)
  const ig = ctx.createRadialGradient(0, 0, iR * 0.16, 0, 0, iR)
  ig.addColorStop(0, `hsl(${iHue | 0},70%,44%)`)
  ig.addColorStop(0.6, `hsl(${iHue | 0},76%,30%)`)
  ig.addColorStop(0.92, `hsl(${iHue | 0},70%,18%)`)
  ig.addColorStop(1, `hsl(${iHue | 0},60%,9%)`)
  ctx.fillStyle = ig
  ctx.beginPath(); ctx.arc(0, 0, iR, 0, P2); ctx.fill()
  ctx.strokeStyle = `hsla(${iHue | 0},80%,58%,${0.3 + irisFlush.t * 0.4})`
  ctx.lineWidth = 1
  for (let i = 0; i < 22; i++) { const a = i / 22 * P2, r1 = iR * (0.78 + 0.16 * sin(i * 3.7)); ctx.beginPath(); ctx.moveTo(cos(a) * iR * 0.3, sin(a) * iR * 0.3); ctx.lineTo(cos(a) * r1, sin(a) * r1); ctx.stroke() }
  ctx.strokeStyle = `hsla(${iHue | 0},60%,7%,0.85)`; ctx.lineWidth = iR * 0.07
  ctx.beginPath(); ctx.arc(0, 0, iR * 0.96, 0, P2); ctx.stroke()

  // --- round pupil: dilates from pinprick to blown wide; a red burn behind it when
  //     inflamed; wet glints from a fixed upper-left light ---
  const pR = iR * (0.16 + dil * 0.52)
  if (bs > 0.15) { const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, pR * 1.9); rg.addColorStop(0, `hsla(4,95%,56%,${bs * 0.55})`); rg.addColorStop(1, 'hsla(4,95%,50%,0)'); ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(0, 0, pR * 1.9, 0, P2); ctx.fill() }
  ctx.fillStyle = '#050205'
  ctx.beginPath(); ctx.arc(0, 0, pR, 0, P2); ctx.fill()
  ctx.fillStyle = 'hsla(0,0%,100%,0.9)'
  ctx.beginPath(); ctx.arc(-iR * 0.16, -iR * 0.16, max(1.4, iR * 0.09), 0, P2); ctx.fill()
  ctx.fillStyle = 'hsla(0,0%,100%,0.45)'
  ctx.beginPath(); ctx.arc(iR * 0.1, iR * 0.14, max(0.8, iR * 0.05), 0, P2); ctx.fill()
  ctx.restore() // iris translate/scale

  // veins reach for prey
  if (eyeTarget) {
    ctx.strokeStyle = `hsla(2,88%,${44 + throb * 14}%,${0.28 + dil * 0.5})`
    ctx.lineWidth = 1.2 + dil * 2.2
    for (let i = 0; i < 4; i++) { const j = (i - 1.5) * 0.05; ctx.beginPath(); ctx.moveTo(ex, ey); ctx.quadraticCurveTo(cx + gx * 1.3 + j * w, cy + gy * 1.3, cx + gx * 2 + j * w * 1.3, cy + gy * 2); ctx.stroke() }
  }
  ctx.restore() // end aperture clip

  // --- lid details: a dark lash line on the rim, lashes off the upper margin, a
  //     crease above, and a pink inner canthus ---
  eyeOutline(cx, cy, w, openness)
  ctx.strokeStyle = 'hsl(348,32%,7%)'; ctx.lineWidth = 2 + w * 0.004; ctx.stroke()
  ctx.lineWidth = 1; ctx.strokeStyle = 'hsla(348,30%,5%,0.9)'
  for (const [px, py] of EYE_POINTS) {
    if (py > -0.15) continue // upper rim only
    const bx = cx + px * w, by = cy + py * w * 0.5 * openness
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + px * w * 0.05, by - w * 0.05); ctx.stroke()
  }
  ctx.strokeStyle = 'hsla(348,24%,24%,0.5)'; ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(cx - w * 0.85, cy - hh * 0.06)
  ctx.quadraticCurveTo(cx, cy - hh * 0.28 * openness - hh * 0.12, cx + w * 0.85, cy - hh * 0.06)
  ctx.stroke()
  ctx.fillStyle = 'hsla(350,60%,42%,0.7)'
  ctx.beginPath(); ctx.ellipse(cx - w * 0.95, cy, w * 0.04, w * 0.045 * openness + 1.5, 0, 0, P2); ctx.fill()

  // acid tears from the lower lid (additive glow)
  ctx.globalCompositeOperation = 'lighter'
  const tearA = 0.1 + weepGlow * 0.5
  const tg = ctx.createLinearGradient(cx, cy, cx, cy + w * 0.9)
  tg.addColorStop(0, `hsla(95,90%,62%,${tearA})`)
  tg.addColorStop(1, 'hsla(115,90%,45%,0)')
  ctx.strokeStyle = tg; ctx.lineWidth = 1.6 + weepGlow * 2.2
  ctx.beginPath()
  ctx.moveTo(cx - w * 0.05, cy + w * 0.1 * openness)
  ctx.quadraticCurveTo(cx - w * 0.02, cy + w * 0.5, cx - w * 0.05, cy + w * 0.85)
  ctx.moveTo(cx + w * 0.06, cy + w * 0.1 * openness)
  ctx.quadraticCurveTo(cx + w * 0.09, cy + w * 0.5, cx + w * 0.06, cy + w * 0.8)
  ctx.stroke()

  // nictitating membrane: a pale film wiping sideways across the aperture now and then
  if (memb > 0 && memb < 1) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.save()
    eyeOutline(cx, cy, w, openness); ctx.clip()
    ctx.fillStyle = 'rgba(200,175,175,0.28)'
    ctx.fillRect(cx - w, cy - hh, (memb * 2 * w), hh * 2)
    ctx.restore()
  }

  ctx.restore()
}

// the current line, floating under the Elder while it's being said/sung
function drawElderCaption(now) {
  const [ex, ey] = skyElderPos(now)
  ctx.save()
  ctx.globalAlpha = min(1, captionTimer * 2.4)
  ctx.fillStyle = '#f4f0ff'
  ctx.font = 'italic 15px Georgia, "Times New Roman", serif'
  ctx.textAlign = 'center'
  ctx.shadowBlur = 6
  ctx.shadowColor = 'rgba(0,0,0,0.8)'
  ctx.fillText(currentLine, ex, ey + min(innerWidth, innerHeight) * 0.42)
  ctx.restore()
}

// The light cursor itself IS the rainbow — a spinning conic-gradient disc —
// rather than a separate arc elsewhere on screen. One clear source of color.
function drawLightOrb(now) {
  if (!light.active) return
  const r = 12 + sky.charge * 18
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  // the shield bubble: anything inside is safe from the eye and the piles
  const sr = SHIELD + sin(now * 0.006) * 2
  const sgrad = ctx.createRadialGradient(light.x, light.y, sr * 0.6, light.x, light.y, sr)
  sgrad.addColorStop(0, 'hsla(190,90%,75%,0)')
  sgrad.addColorStop(1, 'hsla(190,90%,80%,0.14)')
  ctx.fillStyle = sgrad
  ctx.beginPath(); ctx.arc(light.x, light.y, sr, 0, P2); ctx.fill()
  ctx.strokeStyle = 'hsla(190,90%,82%,0.35)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(light.x, light.y, sr, 0, P2); ctx.stroke()
  ctx.shadowBlur = 44
  ctx.shadowColor = `hsl(${sky.hue},95%,60%)`
  const grad = ctx.createConicGradient(now * 0.0009, light.x, light.y)
  for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},95%,62%)`)
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(light.x, light.y, r, 0, P2)
  ctx.fill()
  // a bright white-hot core so it still reads as a light source, not just a disc
  ctx.globalAlpha = 0.7
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(light.x, light.y, r * 0.28, 0, P2)
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
    if (u.sucked || u.gone) continue
    const dx = light.x - u.x, dy = light.y - u.y
    const dist = hypot(dx, dy) || 1
    const nx = -dy / dist, ny = dx / dist
    const wiggle = sin(now * 0.004 + u.x * 0.05) * min(24, dist * 0.12)
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
      ctx.beginPath(); ctx.arc(ix, iy, 2.4, 0, P2); ctx.fill()
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
    ctx.arc(p.x, p.y, 3 + p.life * 6, 0, P2)
    ctx.fill()
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

function drawParticles() {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const p of particles) {
    ctx.globalAlpha = max(0, p.life)
    ctx.fillStyle = `hsl(${p.hue},95%,65%)`
    ctx.beginPath()
    ctx.arc(p.x, p.y, 3, 0, P2)
    ctx.fill()
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

// A unicorn that actually reads as a unicorn: arched body, flowing mane and
// tail, and — the part that matters most at a glance — a real head with a
// muzzle, an ear, an eye, and a twisted horn. All vector, no stored sprite.
function drawUnicorn(u) {
  const a = atan2(u.vy, u.vx) || 0
  const hue = u.hue, sat = '90%'
  const ink = `hsla(${hue},${sat},78%,1)`
  const fill = `hsla(${hue},${sat},68%,0.26)`

  // caught by the eye: shrinks to nothing as it's dragged in; u.scale is the
  // per-unicorn "some bigger, some smaller" size.
  const base = 1.7 * u.scale
  const shrink = u.sucked ? max(0.02, 1 - u.suckT) * base : base
  const b = u.build, n = u.neck
  const gait = sin(performance.now() * 0.007 + u.gait) * (u.gallop ? 3.2 : 0.7)

  ctx.save()
  ctx.translate(u.x, u.y)
  ctx.rotate(a)
  ctx.scale(shrink, shrink)
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // soft presence glow first
  const gg = ctx.createRadialGradient(0, -5, 0, 0, -5, 22)
  gg.addColorStop(0, `hsla(${hue},${sat},65%,0.36)`)
  gg.addColorStop(1, 'hsla(0,0%,0%,0)')
  ctx.fillStyle = gg
  ctx.beginPath(); ctx.arc(0, -5, 22, 0, P2); ctx.fill()

  // shielded in the light: a protective ring — the eye and the piles can't touch it
  if (shielded(u)) {
    ctx.strokeStyle = `hsla(190,90%,82%,${(0.4 + 0.3 * sin(performance.now() * 0.01 + u.gait)) * min(1, sky.charge * 2)})`
    ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.arc(0, -3, 14, 0, P2); ctx.stroke()
  }

  ctx.shadowBlur = 9
  ctx.shadowColor = `hsl(${hue},${sat},65%)`
  ctx.strokeStyle = ink
  ctx.fillStyle = fill

  // head base sits at the top of the neck; neck length shifts it up/forward
  const hbx = 8, hby = -6 - 5 * n
  const hx = hbx + 2, hy = hby

  // wings behind everything (a few unicorns are winged)
  if (u.wings) {
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
  ctx.fillStyle = `hsla(${hue},40%,94%,0.95)`
  ctx.beginPath(); ctx.arc(hx + 3, hy - 1.8, 0.9, 0, P2); ctx.fill()

  // chin tuft (a few)
  if (u.beard) {
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
  ctx.fillStyle = `hsla(${u.spotHue},85%,72%,0.5)`
  for (const [mx, my, mr] of u.marks) { ctx.beginPath(); ctx.arc(mx, my, mr, 0, P2); ctx.fill() }

  // horn — the brightest thing on it, and a different shape on each one
  ctx.save()
  ctx.shadowBlur = 16
  ctx.strokeStyle = `hsl(${(hue + 45) % 360},95%,85%)`
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
    const yy = innerHeight * b.y + sin(now * b.sp + b.ph) * innerHeight * 0.03
    const h = innerHeight * b.amp * 2
    const g = ctx.createLinearGradient(0, yy - h, 0, yy + h)
    g.addColorStop(0, 'hsla(0,0%,0%,0)')
    g.addColorStop(0.5, `hsla(${b.hue | 0},70%,55%,0.06)`)
    g.addColorStop(1, 'hsla(0,0%,0%,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, yy - h, innerWidth, h * 2)
  }
  for (const s of stars) {
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * sin(now * 0.001 * s.sp + s.tw))
    ctx.globalAlpha = tw
    ctx.fillStyle = `hsla(${(sky.hue + 200) % 360},30%,${72 + tw * 22}%,1)`
    ctx.beginPath()
    ctx.arc(s.x * innerWidth, s.y * innerHeight, s.r * tw, 0, P2)
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
    let open = min(1, p / 0.15) * (1 - max(0, (p - 0.85) / 0.15))
    if (p > 0.55 && p < 0.68) open *= abs((p - 0.615) / 0.065) // quick blink dip
    open = max(0, open)
    const a = open * 0.55
    if (a <= 0.01) continue
    const w = e.s
    ctx.strokeStyle = `hsla(4,30%,82%,${a})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.ellipse(e.x, e.y, w, w * 0.5 * open, 0, 0, P2)
    ctx.stroke()
    // pupil turned toward where you're looking
    const ox = max(-1, min(1, (gaze.x - e.x) / (w * 3))) * w * 0.4
    const oy = max(-1, min(1, (gaze.y - e.y) / (w * 3))) * w * 0.2 * open
    ctx.fillStyle = `hsla(4,72%,60%,${a * 1.4})`
    ctx.shadowBlur = 8
    ctx.shadowColor = 'hsla(4,80%,55%,0.6)'
    ctx.beginPath()
    ctx.ellipse(e.x + ox, e.y + oy, w * 0.16, w * 0.42 * open, 0, 0, P2)
    ctx.fill()
    ctx.shadowBlur = 0
  }
  ctx.restore()
}

// A breathing vignette — the edges of the frame slowly close in and ease back,
// like the dark is inhaling. Drawn under the HUD so the text stays readable.
function drawVignette(now) {
  const breath = 0.5 + 0.5 * sin(now * 0.0004)
  const dread = bloodshot // the edge bleeds red as the doom clock climbs
  const g = ctx.createRadialGradient(
    innerWidth / 2, innerHeight * 0.46, innerHeight * 0.2,
    innerWidth / 2, innerHeight * 0.5, max(innerWidth, innerHeight) * 0.72
  )
  g.addColorStop(0, 'hsla(0,0%,0%,0)')
  g.addColorStop(1, `hsla(${260 - dread * 260},${35 + dread * 45}%,2%,${0.5 + breath * 0.18 + dread * 0.16})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, innerWidth, innerHeight)
}
// the two endings: a warm dawn wash or a red-black swallow, with a caption; then regen
function drawEnding() {
  const k = min(1, endT / 2200), dawn = phase === 'dawn'
  ctx.fillStyle = dawn ? `hsla(42,55%,86%,${k * 0.5})` : `hsla(0,85%,7%,${k * 0.62})`
  ctx.fillRect(0, 0, innerWidth, innerHeight)
  ctx.textAlign = 'center'
  ctx.fillStyle = dawn ? `rgba(60,40,20,${k})` : `rgba(255,215,215,${k})`
  ctx.font = `italic ${min(innerWidth, innerHeight) * 0.07}px Georgia, serif`
  ctx.fillText(dawn ? 'the herd crossed' : 'the sky is taken', innerWidth / 2, innerHeight * 0.44)
  ctx.font = '15px monospace'
  ctx.fillStyle = dawn ? `rgba(60,40,20,${k * 0.85})` : `rgba(255,195,195,${k * 0.85})`
  ctx.fillText((dawn ? `${deliveredCount} carried to the valley` : `${lostCount} taken into the dark`) + (best ? `   ·   best ${best}` : ''), innerWidth / 2, innerHeight * 0.54)
  ctx.textAlign = 'left'
}

// a warm, inviting glow on the right edge — the valley, where you're taking the herd
function drawValley(now) {
  const [wl, wr, wt, wb] = wBounds()
  const band = (wr - wl) * 0.11, pulse = 0.5 + 0.5 * sin(now * 0.002)
  const g = ctx.createLinearGradient(wr - band, 0, wr, 0)
  g.addColorStop(0, 'hsla(84,80%,60%,0)')
  g.addColorStop(1, `hsla(84,80%,62%,${0.1 + pulse * 0.1})`)
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = g
  ctx.fillRect(wr - band, wt, band, wb - wt)
  ctx.restore()
}
// the other riders in this sky right now: a faint drifting cursor for each (mapped from
// their normalized position). The "you are not alone in this sky" cue for the Online cat.
function drawRiders() {
  const now = performance.now()
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  for (const r of riders.values()) {
    const a = max(0, 1 - (now - r.t) / 2500) * 0.55
    if (a <= 0.02) continue
    const x = r.x * innerWidth, y = r.y * innerHeight
    ctx.shadowBlur = 16; ctx.shadowColor = `hsl(${r.hue | 0},90%,60%)`
    ctx.fillStyle = `hsla(${r.hue | 0},90%,72%,${a})`
    ctx.beginPath(); ctx.arc(x, y, 6, 0, P2); ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = `hsla(${r.hue | 0},90%,82%,${a * 0.8})`; ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(x, y, 12, 0, P2); ctx.stroke()
  }
  ctx.restore()
}
// the title + one-line how-to; fades on the first drag (which also starts the audio)
function drawIntro() {
  ctx.save()
  ctx.fillStyle = `rgba(6,4,12,${introA * 0.72})`
  ctx.fillRect(0, 0, innerWidth, innerHeight)
  ctx.globalAlpha = introA
  ctx.textAlign = 'center'
  const S = min(innerWidth, innerHeight)
  ctx.fillStyle = '#f0e9ff'; ctx.font = `italic ${S * 0.09}px Georgia, serif`
  ctx.fillText('Aurora Loom', innerWidth / 2, innerHeight * 0.38)
  ctx.fillStyle = '#cfc8e8'; ctx.font = '15px monospace'
  ctx.fillText('drag the light  ·  keep the herd inside it  ·  walk them to the valley', innerWidth / 2, innerHeight * 0.49)
  ctx.fillText(`get ${GOAL} across before the eye takes the sky`, innerWidth / 2, innerHeight * 0.55)
  const pulse = 0.5 + 0.5 * sin(performance.now() * 0.004)
  ctx.fillStyle = `rgba(185,165,240,${0.4 + pulse * 0.6})`
  ctx.fillText('— drag to begin —', innerWidth / 2, innerHeight * 0.68)
  ctx.globalAlpha = 1; ctx.textAlign = 'left'
  ctx.restore()
}

// ---------- render ----------
function render(now) {
  // --- screen-space background: fills the viewport at any zoom ---
  drawSky(now)
  drawDarkEyes()
  // ambient eye-glow wash — remote players' contributions show up here too
  const g = ctx.createRadialGradient(
    innerWidth / 2, innerHeight * 0.2, 0,
    innerWidth / 2, innerHeight * 0.2, max(innerWidth, innerHeight) * 0.8
  )
  g.addColorStop(0, `hsla(${sky.hue},90%,55%,${0.05 + sky.charge * 0.35})`)
  g.addColorStop(1, 'hsla(0,0%,0%,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, innerWidth, innerHeight)

  // --- the world, under the camera (zooms out as the piles claim ground) ---
  ctx.save()
  ctx.translate(CX, CY); ctx.scale(zoom, zoom); ctx.translate(-CX, -CY)

  drawStains()
  drawValley(now) // the goal glow on the right edge
  drawLures(now)
  drawBlobs(now)
  drawRainbow(now) // the twisted arc, behind the eye and the herd
  drawSkyElder(now)
  if (captionTimer > 0) drawElderCaption(now)
  drawTrail()
  drawTendrils(now)
  drawLightOrb(now)
  for (const u of herd) if (!u.gone) drawUnicorn(u)
  drawAcid()
  drawRbDrips()
  drawParticles()

  ctx.restore()

  // --- screen overlays ---
  drawVignette(now)
  drawRiders() // other players' cursors, floating over the shared sky
  if (phase === 'play') {
    // minimal ambient HUD — progress toward the goal; the reddening edge carries the danger
    ctx.fillStyle = 'rgba(240,235,255,0.6)'
    ctx.font = '13px monospace'
    ctx.textAlign = 'left'
    let total = deliveredCount
    for (const r of riders.values()) total += r.d
    const bestTxt = best ? '   ·   best ' + best : ''
    ctx.fillText(peerCount
      ? `${deliveredCount} / ${GOAL} crossed   ·   this sky: ${total}   ·   ${peerCount} riders${bestTxt}`
      : `${deliveredCount} / ${GOAL} crossed${bestTxt}`, 12, 22)
  } else {
    drawEnding()
  }
  if (introA > 0) drawIntro()
}

// wipe the mutable simulation for a fresh round (the room's seeded look persists as
// its identity; only the palette hue is re-rolled so each attempt feels new)
function newRound() {
  phase = 'play'; endT = 0; eyeClose = 0; eyeSwell = 1
  bloodshot = 0.06; deliveredCount = 0; lostCount = 0
  worldScale = 1; worldScaleTarget = 1; zoom = 1
  sky.charge = 0.08; sky.hue = random() * 360 | 0
  doomSaid = false; lastVerseAt = -Infinity; sayQ.length = 0
  herd.length = 0
  for (let i = 0; i < 9; i++) herd.push(spawnUnicorn(random() * innerWidth, random() * innerHeight))
  blobs.length = 0; acid.length = 0; stains.length = 0; rbDrips.length = 0
  elder('a new sky. drag to bring color to it')
}

// ---------- loop ----------
let last = performance.now()
function loop(t) {
  const dt = min(32, t - last)
  last = t
  elderPulse = max(0, elderPulse - dt * 0.0012)
  captionTimer = max(0, captionTimer - dt * 0.00032)

  // the loom: charge is WOVEN — it rises with how far the light moved, not how
  // long it's held — and the shield spends it (an upkeep per protected unicorn).
  // Park to protect, weave to bank, arrive at the valley rich enough to deliver.
  if (light.active) {
    sky.charge = min(1, sky.charge + min(20, hypot(light.x - light.px, light.y - light.py)) * 0.0005)
    sky.charge = max(0, sky.charge - dt * (0.00008 + 0.00002 * shieldedN))
    sky.hue = (sky.hue + dt * 0.02) % 360
    broadcastThrottled()
    trail.push({ x: light.x, y: light.y, hue: sky.hue, life: 1 })
    if (trail.length > 80) trail.shift()
  } else {
    sky.charge = max(0, sky.charge - dt * 0.00006)
  }
  light.px = light.x; light.py = light.y
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

  if (actx && !beatOn && phase === 'play' && started) beatStart()
  stepHerd(dt, t)
  stepBlobs(dt)
  stepAcid(dt, t)
  stepRainbow(dt)
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
  else { tx = (wl + wr) / 2 + sin(t * 0.0003) * (wr - wl) * 0.3; ty = (wt + wb) / 2 + cos(t * 0.00023) * (wb - wt) * 0.2; ease = 0.02 }
  gaze.x += (tx - gaze.x) * ease
  gaze.y += (ty - gaze.y) * ease

  // pupil blows open when you're near the eye or it has locked prey, clamps back otherwise
  const near = light.active
    ? max(0, 1 - hypot(light.x - ex, light.y - ey) / (min(innerWidth, innerHeight) * 0.45 * worldScale))
    : 0
  const want = max(near, eyeTarget ? 0.9 : 0)
  pupilDilate += (want - pupilDilate) * 0.08

  // the eye inflames the whole time it watches, and only ebbs a hair — it remembers.
  // This IS the doom clock: reach 1 and the sky is taken.
  if (phase === 'play') bloodshot = min(1, max(0, bloodshot + dt * 0.00001 * (1 + deliveredCount * 0.08)))

  if (started) introA = max(0, introA - dt * 0.0016) // title fades once you grab the light
  // forget riders we haven't heard from in a couple of seconds
  const tnow = performance.now()
  for (const [id, r] of riders) if (tnow - r.t > 2500) riders.delete(id)

  // --- the arc: win at GOAL, lose when the eye maxes; play the ending, then regen ---
  if (phase === 'play') {
    if (deliveredCount >= GOAL) { phase = 'dawn'; endT = 0; saveBest() }
    else if (bloodshot >= 1) { phase = 'taken'; endT = 0; saveBest() }
  } else {
    endT += dt
    if (phase === 'dawn') { eyeClose = min(1, eyeClose + dt * 0.0005); bloodshot = max(0, bloodshot - dt * 0.0006) }
    else { eyeSwell = min(3.2, eyeSwell + dt * 0.0009); eyeClose = max(0, eyeClose - dt * 0.001) } // taken: the eye swells to fill the sky
    if (endT > 6000) newRound()
  }
  // a visual heartbeat sharing the audio heartbeat's quickening tempo (throbs the veins)
  heartPhase = (heartPhase + dt * 0.001 / max(0.4, 1.6 - max(pupilDilate, dread) * 1.1)) % 1
  irisFlush.t = max(0, irisFlush.t - dt * 0.0016)
  // nictitating membrane: sweep across now and then, more often the more inflamed
  if (memb > 0) { memb += dt * 0.0026; if (memb >= 1) { memb = 0; membT = 4000 + random() * 9000 } }
  else { membT -= dt * (1 + bloodshot); if (membT <= 0) memb = 0.0001 }

  // dark eyes: spawn one on a random timer, age the rest out
  nextEyeT -= dt
  if (nextEyeT <= 0) {
    nextEyeT = 4000 + random() * 9000
    darkEyes.push({ x: random() * innerWidth, y: innerHeight * (0.3 + random() * 0.6), s: 7 + random() * 11, t: 0 })
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
  // include who we are, our light's screen-normalized position, and our delivery count,
  // so other players can SEE us moving in the shared sky and a room-wide tally can form
  const sx = (CX + (light.x - CX) * zoom) / innerWidth
  const sy = (CY + (light.y - CY) * zoom) / innerHeight
  net.send({ t: 'sky', id: net.id, charge: sky.charge, hue: sky.hue, x: sx, y: sy, d: deliveredCount })
}

const net = connectRelay(ROOM, {
  onId: () => elder('Connected to today\'s sky.'),
  onPeerJoin: (id) => { peerCount++; elder(`A rider joined (${id.slice(0, 6)}). ${peerCount} here now.`) },
  onPeerLeave: (id) => { peerCount = max(0, peerCount - 1); riders.delete(id); elder(`A rider left (${id.slice(0, 6)}). ${peerCount} here now.`) },
  onMessage: (data) => {
    if (data?.t !== 'sky') return
    // fold a remote nudge into the shared local sky — additive, decayed, never
    // overwritten wholesale, so many concurrent players blend instead of fighting
    // over one authoritative value (there's no server authority to fight over anyway).
    sky.charge = min(1, sky.charge * 0.7 + data.charge * 0.3)
    sky.hue = (sky.hue + (((data.hue - sky.hue + 540) % 360) - 180) * 0.15 + 360) % 360
    // remember the other rider's cursor + count so we can draw them (see drawRiders)
    if (data.id != null && data.id !== net.id) riders.set(data.id, { x: data.x, y: data.y, hue: data.hue, d: data.d || 0, t: performance.now() })
  },
  onError: () => elder('Offline — playing solo. That\'s a fully valid way to play.'),
})
elder(logLine('hush'))
