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
  const wild = Math.random()
  return {
    x, y, vx: 0, vy: 0,
    hue: Math.random() * 360,
    delivered: false, sucked: false, suckT: 0, gone: false,
    scale: 0.6 + Math.random() * 1.3,
    spotHue: Math.random() * 360,
    hornCurl: Math.random() < 0.5 ? 1 : -1,
    wild,
    marks: Array.from({ length: 1 + Math.floor(Math.random() * 6) }, () => [
      -14 + Math.random() * 30,
      -6 + Math.random() * 14,
      0.8 + Math.random() * 1.6,
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

// ---------- corner piles ----------
// Where the dead pile up. Four corners; each accumulates "husks" — the leftover
// color of eaten unicorns. Past a threshold a corner turns into a SUPER pile: it
// takes on a mutating color, reaches out and drags living unicorns in to consume
// them, and every meal makes it grow and spread further inward — claiming ground.
const piles = [0, 1, 2, 3].map((i) => ({
  i, husks: [], count: 0, sup: false, hue: rng() * 360, r: 0, pull: 0,
}))
// world corner + inward unit direction for pile i (0=TL,1=TR,2=BL,3=BR)
function pileAnchor(i) {
  const [l, r, tp, bt] = wBounds()
  return [(i & 1) ? r : l, (i & 2) ? bt : tp, (i & 1) ? -1 : 1, (i & 2) ? -1 : 1]
}
function nearestPile(x, y) {
  let best = piles[0], bd = 1e9
  for (const p of piles) {
    const [ax, ay] = pileAnchor(p.i)
    const d = Math.hypot(ax - x, ay - y)
    if (d < bd) { bd = d; best = p }
  }
  return best
}
// a unicorn's remains join the nearest corner; the pile grows and mutates color
function addHusk(x, y, hue) {
  const p = nearestPile(x, y)
  const [, , dx, dy] = pileAnchor(p.i)
  // husks mound near the corner and only slowly creep inward — pow() biases most
  // of them toward the corner, so it reads as a growing pile, not scattered confetti
  const spread = (8 + Math.sqrt(p.count) * 6) * cfg.creep
  p.husks.push({
    ox: dx * (5 + Math.pow(Math.random(), 1.7) * spread),
    oy: dy * (5 + Math.pow(Math.random(), 1.7) * spread),
    r: 4 + Math.random() * 5,
    hue: p.sup ? p.hue : hue,
  })
  if (p.husks.length > 70) p.husks.shift() // draw-list cap; count keeps climbing
  p.count++
  p.hue = (p.hue + 18 + Math.random() * 24) % 360 // replicate + change with each addition
  p.r = 12 + Math.sqrt(p.count) * 7
  if (!p.sup && p.count >= cfg.trigger) {
    p.sup = true
    elder('A pile in the corner has started to move on its own.')
  }
}
// super piles pull the living in, eat them, and push the world outward
function stepPiles(dt) {
  worldScaleTarget = 1
  for (const p of piles) {
    if (!p.sup) continue
    const [ax, ay] = pileAnchor(p.i)
    p.pull = Math.min(1, p.pull + dt * 0.0004)
    const reach = p.r + 150
    for (const u of herd) {
      if (u.gone || u.delivered || u.sucked) continue
      const dx = ax - u.x, dy = ay - u.y
      const d = Math.hypot(dx, dy) || 1
      if (d < reach) {
        const g = (1 - d / reach) * 0.006 * p.pull * dt * cfg.pull
        u.vx += (dx / d) * g
        u.vy += (dy / d) * g
      }
      if (d < p.r + 10) { addHusk(u.x, u.y, u.hue); u.gone = true } // consumed
    }
    worldScaleTarget += Math.min(1.2, p.r / (innerWidth * 0.5)) * 0.55
  }
  if (worldScaleTarget > cfg.zcap) worldScaleTarget = cfg.zcap
}
function drawPiles(now) {
  for (const p of piles) {
    if (!p.count) continue
    const [ax, ay] = pileAnchor(p.i)
    ctx.save()
    if (p.sup) {
      // a solid, wobbling mass — the pile as a body claiming ground, not just glow
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = `hsla(${p.hue | 0},68%,30%,0.72)`
      ctx.shadowBlur = 26
      ctx.shadowColor = `hsla(${p.hue | 0},85%,48%,0.7)`
      ctx.beginPath()
      for (let k = 0; k <= 20; k++) {
        const a = (k / 20) * Math.PI * 2
        const rr = p.r * (0.72 + 0.13 * Math.sin(a * 3 + now * 0.003 + p.i))
        const px = ax + Math.cos(a) * rr, py = ay + Math.sin(a) * rr
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)
      }
      ctx.closePath(); ctx.fill()
      ctx.shadowBlur = 0
    }
    // the husks themselves — a knotted cluster of colored blobs on the mass
    ctx.globalCompositeOperation = 'lighter'
    for (const h of p.husks) {
      ctx.fillStyle = `hsla(${h.hue | 0},70%,${p.sup ? 58 : 46}%,${p.sup ? 0.75 : 0.5})`
      ctx.shadowBlur = p.sup ? 10 : 4
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
        addHusk(u.x, u.y, u.hue) // the remains drop into the nearest corner pile
        u.gone = true            // topUpHerd() walks a stranger in to replace it
        elder(`The eye took one. Its color pools in the corner. (${lostCount} taken)`)
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

    // bounce softly off the (growing) world edges
    if (u.x < wl) { u.x = wl; u.vx *= -1 }
    if (u.x > wr) { u.x = wr; u.vx *= -1 }
    if (u.y < wt) { u.y = wt; u.vy *= -1 }
    if (u.y > wb) { u.y = wb; u.vy *= -1 }

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
const RAP_LINES = [
  "i am the eye... i never close, i never look away...",
  "i counted every color that you dragged today,",
  "the little warm ones come to me... they don't come back,",
  "keep painting all your pretty rainbows on the black,",
  "i see you... yeah, i see you... i'll be here when you're gone.",
]
let lyricIdx = -1
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
function speak(line) {
  try {
    if (!window.speechSynthesis) return
    // one deep, slow voice — and a second quieter, slightly slower layer under it.
    // The two drifting out of sync is the "wrong", doubled, not-quite-human sound.
    const u = new SpeechSynthesisUtterance(line)
    u.rate = 0.6; u.pitch = 0.18; u.volume = 0.9
    speechSynthesis.speak(u)
    const w = new SpeechSynthesisUtterance(line)
    w.rate = 0.48; w.pitch = 0.06; w.volume = 0.45
    speechSynthesis.speak(w)
  } catch (e) { /* speech synthesis unavailable — captions still show */ }
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
  droneNodes = { g, o1, o2, lfo }
}
function droneStop() {
  if (!droneNodes) return
  const { g, o1, o2, lfo } = droneNodes
  try {
    g.gain.setTargetAtTime(0.0001, actx.currentTime, 0.6)
    o1.stop(actx.currentTime + 1.2); o2.stop(actx.currentTime + 1.2); lfo.stop(actx.currentTime + 1.2)
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

const VERSE_BPM = 64, VERSE_STEP = 60 / VERSE_BPM / 2
const VERSE_PATTERN = [1, 0, 0, 0, 0, 0, 1, 0] // boom ... bap, boom-boom ... bap
let verseOn = false, nextStep = 0, stepIdx = 0, lastVerseAt = -Infinity
function scheduleVerse() {
  if (!verseOn) return
  while (nextStep < actx.currentTime + 0.15) {
    const idx = stepIdx % 8
    if (VERSE_PATTERN[idx]) kick(nextStep)
    if (idx === 4) noiseHit(nextStep, 0.15, 1500, 0.5) // snare
    if (idx % 2 === 1) noiseHit(nextStep, 0.05, 6000, 0.2) // hat
    if (idx === 0) {
      lyricIdx = (lyricIdx + 1) % RAP_LINES.length
      currentLine = RAP_LINES[lyricIdx]
      captionTimer = 1
      elder(currentLine)
      speak(currentLine)
    }
    nextStep += VERSE_STEP
    stepIdx++
    if (stepIdx >= RAP_LINES.length * 8) { verseOn = false; droneStop(); return }
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
  verseOn = true
  stepIdx = 0
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
  return Math.max(0.05, 1 - blink)
}

function drawSkyElder(now) {
  const w = Math.min(innerWidth, innerHeight) * 0.6
  const [cx, cy] = skyElderPos(now)
  const pulse = elderPulse
  const a = 0.1 + pulse * 0.4
  const openness = skyElderOpen(now)

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'

  // a solid sclera behind the outline — gives the shape real weight instead
  // of reading as a bare wireframe
  ctx.fillStyle = `hsla(4,20%,10%,${0.5 + pulse * 0.2})`
  ctx.beginPath()
  EYE_POINTS.forEach(([px, py], i) => {
    const x = cx + px * w, y = cy + py * w * 0.5 * openness
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  })
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = `hsla(4,20%,85%,${a})`
  ctx.lineWidth = 1.4
  ctx.stroke()

  ctx.fillStyle = `hsla(4,25%,90%,${a * 1.5})`
  for (const [px, py] of EYE_POINTS) {
    ctx.beginPath()
    ctx.arc(cx + px * w, cy + py * w * 0.5 * openness, 1.3, 0, Math.PI * 2)
    ctx.fill()
  }

  // seeded bloodshot capillaries reaching in from the inner corner — they wake up
  // (brighter, redder) as the sky charges and the eye pulses. Generated once from
  // the room seed, so everyone in the same room shares the same veined eye.
  const capA = 0.07 + pulse * 0.3 + sky.charge * 0.28
  ctx.lineWidth = 0.6
  for (const cap of caps) {
    ctx.strokeStyle = `hsla(${2 + sky.charge * 6},70%,${44 + pulse * 22}%,${capA})`
    ctx.beginPath()
    cap.forEach(([px, py], i) => {
      const x = cx + px * w, y = cy + py * w * 0.5 * openness
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  // how far the eyeball is turned toward whatever it's watching (your light, or the
  // prey it just locked onto). Clamped so the pupil always stays inside the sclera.
  const dx = gaze.x - cx, dy = gaze.y - cy
  const gx = Math.max(-1, Math.min(1, dx / (w * 0.9))) * w * 0.3
  const gy = Math.max(-1, Math.min(1, dy / (innerHeight * 0.5))) * w * 0.16 * openness
  const dil = pupilDilate

  // iris ring + fibers — reptile-eye texture, mostly hidden by the shades except
  // for a rim that glows through around them. Rides with the gaze.
  ctx.strokeStyle = `hsla(30,70%,55%,${0.3 + pulse * 0.4})`
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
  ctx.restore()

  // the pupil itself — a reptilian slit that blows wide open (dil) when it's near
  // you or has locked prey, and clamps back to a needle when it's idle
  ctx.shadowBlur = 20 + dil * 30 + pulse * 40
  ctx.shadowColor = `hsla(4,75%,55%,${0.45 + pulse * 0.55})`
  ctx.fillStyle = `hsla(4,65%,60%,${0.3 + pulse * 0.65})`
  ctx.save()
  ctx.translate(cx + gx, cy + gy)
  ctx.scale(1, openness)
  ctx.beginPath()
  ctx.ellipse(0, 0, 2.2 + dil * 4 + pulse * 2, 8 + dil * 3 + pulse * 6, 0, 0, Math.PI * 2)
  ctx.fill()
  // a wet specular glint high on the pupil — the "it's alive and looking at you" cue
  ctx.shadowBlur = 0
  ctx.fillStyle = `hsla(0,0%,100%,${0.45 + pulse * 0.35})`
  ctx.beginPath()
  ctx.ellipse(-1.6, -3.5, 1.2, 2, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // acid tears: sickly wet streaks weeping from the lower lid, brightening with each
  // fresh drop. The eye doesn't only watch — it leaks, and the leak corrupts color.
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
  ctx.restore()

  drawElderSwagger(cx, cy, w, openness)
}

// 90s-gangster flourishes, drawn in normal (non-additive) compositing so they
// read as solid objects sitting in front of the glow rather than more light.
// Shades mostly hide the eye — the pupil's glow still leaks out past the rims
// — and a gold chain hangs below. Purely cosmetic; doesn't touch the hitbox.
function drawElderSwagger(cx, cy, w, openness) {
  ctx.save()
  const lensW = w * 0.46, lensH = w * 0.22 * openness, lensDX = w * 0.32
  // the darker the glasses, the less you see — but as the pupil dilates (it's
  // hunting, or you're near) the lenses turn translucent and the eye's glow bleeds
  // through the glass. You can see it looking at you.
  const dil = pupilDilate
  ctx.fillStyle = `rgba(8,6,12,${0.66 - dil * 0.24})`
  ctx.beginPath()
  ctx.ellipse(cx - lensDX, cy, lensW * 0.5, lensH * 0.5, 0, 0, Math.PI * 2)
  ctx.ellipse(cx + lensDX, cy, lensW * 0.5, lensH * 0.5, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(cx - w * 0.05, cy - 1.5, w * 0.1, 3) // bridge

  // red glow leaking through each lens where the eye burns behind the glass
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const sgn of [-1, 1]) {
    const lx = cx + sgn * lensDX
    const gg = ctx.createRadialGradient(lx, cy, 0, lx, cy, lensW * 0.5)
    const gA = 0.14 + dil * 0.5 + elderPulse * 0.2
    gg.addColorStop(0, `hsla(4,85%,55%,${gA})`)
    gg.addColorStop(1, 'hsla(4,85%,55%,0)')
    ctx.fillStyle = gg
    ctx.beginPath()
    ctx.ellipse(lx, cy, lensW * 0.5, lensH * 0.5, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  // a thin rainbow streak across each lens — reflected light, not a light source
  const hl = ctx.createLinearGradient(cx - w * 0.6, cy, cx + w * 0.6, cy)
  for (let i = 0; i <= 6; i++) hl.addColorStop(i / 6, `hsla(${i * 60},90%,65%,0.4)`)
  ctx.strokeStyle = hl
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(cx - lensDX - lensW * 0.4, cy - lensH * 0.12)
  ctx.lineTo(cx - lensDX + lensW * 0.4, cy - lensH * 0.12)
  ctx.moveTo(cx + lensDX - lensW * 0.4, cy - lensH * 0.12)
  ctx.lineTo(cx + lensDX + lensW * 0.4, cy - lensH * 0.12)
  ctx.stroke()

  // gold chain, hanging below — pure swagger
  ctx.fillStyle = 'hsla(46,85%,55%,0.55)'
  const chainY = cy + w * 0.34
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath()
    ctx.arc(cx + i * w * 0.045, chainY + Math.abs(i) * w * 0.012, 1.6, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.beginPath()
  ctx.arc(cx, chainY + w * 0.05, 3.4, 0, Math.PI * 2)
  ctx.fill()
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
  const inkStroke = dim ? 'hsla(0,0%,90%,0.6)' : `hsla(${hue},${sat},74%,1)`
  const fillTone = dim ? 'hsla(0,0%,90%,0.12)' : `hsla(${hue},${sat},70%,0.22)`

  // caught by the eye: shrinks to nothing as it's dragged in — "teeny tiny
  // unicorn" is the shrink curve, the pop happens on the frame it hits zero.
  // u.scale is the "some bigger, some smaller" size each unicorn spawns with.
  const base = 1.7 * u.scale
  const shrink = u.sucked ? Math.max(0.02, 1 - u.suckT) * base : base

  ctx.save()
  ctx.translate(u.x, u.y)
  ctx.rotate(a)
  ctx.scale(shrink, shrink)
  ctx.globalCompositeOperation = 'lighter'

  // soft body glow first, so the unicorn reads as a presence before the linework
  const glowGrad = ctx.createRadialGradient(4, -6, 0, 4, -6, 20)
  glowGrad.addColorStop(0, `hsla(${hue},${sat},65%,${dim ? 0.14 : 0.4})`)
  glowGrad.addColorStop(1, 'hsla(0,0%,0%,0)')
  ctx.fillStyle = glowGrad
  ctx.beginPath(); ctx.arc(4, -6, 20, 0, Math.PI * 2); ctx.fill()

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowBlur = dim ? 4 : 9
  ctx.shadowColor = `hsl(${hue},${sat},65%)`
  ctx.strokeStyle = inkStroke
  ctx.lineWidth = 1.5

  // legs, drawn first so the body overlaps them
  ctx.beginPath()
  ctx.moveTo(-8, 3); ctx.lineTo(-9, 10)
  ctx.moveTo(1, 2); ctx.lineTo(0, 10)
  ctx.stroke()

  // tail — a couple of flowing strands, not one stiff line
  ctx.beginPath()
  ctx.moveTo(-10, 2)
  ctx.quadraticCurveTo(-16, 4, -15, 11)
  ctx.moveTo(-10, 2)
  ctx.quadraticCurveTo(-15, 1, -17, 6)
  ctx.stroke()

  // body: one confident arched stroke from haunch to chest
  ctx.beginPath()
  ctx.moveTo(-10, 2)
  ctx.quadraticCurveTo(-3, -6, 5, -3)
  ctx.stroke()

  // mane, flowing back along the neck
  ctx.beginPath()
  ctx.moveTo(6, -10)
  ctx.quadraticCurveTo(2, -8, -2, -3)
  ctx.moveTo(7, -9)
  ctx.quadraticCurveTo(4, -6, 0, -1)
  ctx.stroke()

  // neck, rising from the shoulder to the throat
  ctx.beginPath()
  ctx.moveTo(5, -3)
  ctx.quadraticCurveTo(6, -8, 8, -10)
  ctx.stroke()

  // --- head: the part that has to actually read as a unicorn ---
  ctx.beginPath()
  ctx.moveTo(8, -10)                                    // throat
  ctx.quadraticCurveTo(9, -15, 13, -16)                 // up to the forehead
  ctx.quadraticCurveTo(18, -17, 21, -13)                // brow to nose bridge
  ctx.quadraticCurveTo(23, -11, 21, -9.5)               // muzzle tip, rounded
  ctx.quadraticCurveTo(18, -8.5, 16, -9.5)              // under the nose
  ctx.quadraticCurveTo(13, -10.5, 11, -9)               // mouth/chin
  ctx.quadraticCurveTo(9, -9.5, 8, -10)                 // back to throat
  ctx.closePath()
  ctx.fillStyle = fillTone
  ctx.fill()
  ctx.stroke()

  // stranger markings — a scatter of spots in a second color, fixed at
  // spawn time so they ride along with the body instead of swimming loose
  if (!dim) {
    ctx.fillStyle = `hsla(${u.spotHue},85%,72%,0.55)`
    for (const [mx, my, mr] of u.marks) {
      ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill()
    }
  }

  // ear
  ctx.beginPath()
  ctx.moveTo(12, -15.5)
  ctx.lineTo(10.5, -20)
  ctx.lineTo(14.5, -17)
  ctx.closePath()
  ctx.fillStyle = fillTone
  ctx.fill()
  ctx.stroke()

  // eye
  ctx.fillStyle = dim ? 'hsla(0,0%,95%,0.7)' : `hsla(${hue},40%,92%,0.95)`
  ctx.beginPath()
  ctx.arc(16, -13, 0.9, 0, Math.PI * 2)
  ctx.fill()

  // horn — twisted, and the single brightest thing on the whole unicorn.
  // Length and curl direction vary per unicorn — some are barely a nub,
  // some are dramatically, unreasonably long.
  ctx.save()
  ctx.shadowBlur = dim ? 5 : 16
  const hornHue = (hue + 45) % 360
  ctx.strokeStyle = dim ? 'hsla(0,0%,96%,0.65)' : `hsl(${hornHue},95%,84%)`
  ctx.lineWidth = 1.6
  const hornWild = u.wild || 0
  const tipX = 19 + hornWild * 9, tipY = -25 - hornWild * 14
  ctx.beginPath()
  ctx.moveTo(13.5, -16.2)
  ctx.lineTo(tipX, tipY)
  ctx.stroke()
  // spiral ticks along the horn — direction flips per unicorn (u.hornCurl)
  ctx.lineWidth = 1
  const curl = u.hornCurl || 1
  for (let i = 1; i <= 3; i++) {
    const p = i / 4
    const bx = 13.5 + (tipX - 13.5) * p, by = -16.2 + (tipY + 16.2) * p
    ctx.beginPath()
    ctx.moveTo(bx - 1.1 * curl, by + 0.5 * curl)
    ctx.lineTo(bx + 1.1 * curl, by - 0.5 * curl)
    ctx.stroke()
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
  drawPiles(now)
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
  stepPiles(dt)
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
]
function buildPanel() {
  const style = document.createElement('style')
  style.textContent =
    '#ui{position:fixed;top:8px;right:8px;z-index:9;font:11px monospace;color:#cfc8e8}' +
    '#ui button{background:rgba(10,8,20,.72);color:#cfc8e8;border:1px solid rgba(233,230,247,.22);border-radius:5px;padding:4px 8px;cursor:pointer;font:inherit}' +
    '#uip{margin-top:6px;width:186px;padding:6px 10px 10px;background:rgba(8,6,14,.85);border:1px solid rgba(233,230,247,.16);border-radius:7px}' +
    '#uip label{display:grid;grid-template-columns:1fr auto;gap:1px 6px;margin:8px 0 0}' +
    '#uip b{color:#b39cf2;font-weight:600}' +
    '#uip input{grid-column:1/3;width:100%;accent-color:#a06cf0;margin:2px 0 0}' +
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
  const reset = document.createElement('button'); reset.textContent = 'reset'; reset.className = 'r'
  reset.onclick = () => { Object.assign(cfg, DEFAULTS); for (const f of setters) f() }
  panel.append(reset)

  box.append(gear, panel); document.body.append(box)
  setOpen(false)
}
buildPanel()
