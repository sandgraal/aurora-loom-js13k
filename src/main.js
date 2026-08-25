import { connectRelay, todaysRoom } from './net.js'

// ---------- canvas setup ----------
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')
const logEl = document.getElementById('log')
let W, H
function resize() {
  W = canvas.width = innerWidth * devicePixelRatio
  H = canvas.height = innerHeight * devicePixelRatio
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
}
addEventListener('resize', resize)
resize()

// ---------- shared "sky" state ----------
// charge: how lit-up the shared sky is right now (0..1), decays on its own.
// hue: the sky's current color, drifts toward whoever's actively adding charge.
// Both are local variables that get nudged by (a) your own light cursor and
// (b) deltas broadcast by other players currently in the room. There is no
// server-side store (see net.js) — this is pure "whoever's here right now"
// ambient state, which is also why it resets to calm whenever a room empties:
// the sky itself is as ephemeral as the rainbows it's made of.
const sky = { charge: 0.08, hue: 200 }
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
  return { x: t.clientX, y: t.clientY }
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
addEventListener('touchmove', (e) => { onMove(e); e.preventDefault() }, { passive: false })
addEventListener('touchend', onUp)

// ---------- herd (boid-lite) ----------
const N_UNICORNS = 6

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
const herd = Array.from({ length: N_UNICORNS }, () =>
  spawnUnicorn(Math.random() * innerWidth, Math.random() * innerHeight))
let deliveredCount = 0
let lostCount = 0

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
        // it doesn't come back — a new, stranger one does. The eye is a
        // hazard, not a dead end: losing one to it recolors the herd rather
        // than shrinking it for good.
        const nx = Math.random() * innerWidth, ny = Math.random() * innerHeight
        Object.assign(u, spawnUnicorn(nx, ny))
        spawnDeliveryBurst(nx, ny)
        elder(`The eye took one... and something stranger climbed out of the dark. (${lostCount} so far)`)
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

    // wrap/bounce softly off edges
    if (u.x < 0) { u.x = 0; u.vx *= -1 }
    if (u.x > innerWidth) { u.x = innerWidth; u.vx *= -1 }
    if (u.y < 0) { u.y = 0; u.vy *= -1 }
    if (u.y > innerHeight) { u.y = innerHeight; u.vy *= -1 }

    // wander into the eye's open pupil and it takes you — no warning beyond
    // the eye itself being there to see
    if (skyElderOpen(now) > 0.3) {
      const [ex, ey] = skyElderPos(now)
      if (Math.hypot(ex - u.x, ey - u.y) < 15 + elderPulse * 10) {
        u.sucked = true
        u.suckT = 0
        continue
      }
    }

    // "the valley" — reaching the right edge with enough charge delivers the unicorn
    if (u.x > innerWidth - 24 && sky.charge > 0.5) {
      u.delivered = true
      deliveredCount++
      spawnDeliveryBurst(u.x, u.y)
      elder(deliveredCount === N_UNICORNS
        ? 'The whole herd has crossed. The sky goes quiet again.'
        : `A unicorn reached the valley. ${deliveredCount}/${N_UNICORNS} home.`)
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
  "yo... it's the eye up in the sky, watchin' errrybody...",
  "got a herd of unicorns, each one born with a horn,",
  "draggin' colors 'cross the dark 'til the break of dawn,",
  "slow with the flow, baby, watch me glow,",
  "get too close to me though... and — pop — you go.",
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
    const u = new SpeechSynthesisUtterance(line)
    u.rate = 0.72; u.pitch = 0.35; u.volume = 0.9
    speechSynthesis.speak(u)
  } catch (e) { /* speech synthesis unavailable — captions still show */ }
}

const VERSE_BPM = 76, VERSE_STEP = 60 / VERSE_BPM / 2
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
    if (stepIdx >= RAP_LINES.length * 8) { verseOn = false; return }
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
  return [
    innerWidth * 0.5 + Math.sin(now * 0.00006) * innerWidth * 0.18,
    innerHeight * 0.2 + Math.cos(now * 0.00004) * innerHeight * 0.05,
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

  // faint veins from the inner corner — a small, unsettling "this has been
  // open a long time" detail
  ctx.strokeStyle = `hsla(4,60%,60%,${0.12 + pulse * 0.25})`
  ctx.lineWidth = 0.6
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.moveTo(cx - w * 0.94, cy)
    ctx.quadraticCurveTo(
      cx - w * 0.5, cy + (i - 1) * w * 0.06 * openness,
      cx - w * 0.15, cy + (i - 1) * w * 0.14 * openness
    )
    ctx.stroke()
  }

  // a thin iris ring — reptile-eye texture, mostly hidden by the shades
  // except for a rim that glows through around them
  ctx.strokeStyle = `hsla(30,70%,55%,${0.3 + pulse * 0.4})`
  ctx.lineWidth = 1
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, openness)
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(Math.cos(ang) * 5, Math.sin(ang) * 5)
    ctx.lineTo(Math.cos(ang) * (9 + pulse * 4), Math.sin(ang) * (9 + pulse * 4))
    ctx.stroke()
  }
  ctx.restore()

  // the pupil itself — a narrow reptilian slit, not a soft dot
  ctx.shadowBlur = 20 + pulse * 50
  ctx.shadowColor = `hsla(4,75%,55%,${0.45 + pulse * 0.55})`
  ctx.fillStyle = `hsla(4,65%,60%,${0.3 + pulse * 0.65})`
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, openness)
  ctx.beginPath()
  ctx.ellipse(0, 0, 2.4 + pulse * 3, 8 + pulse * 7, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
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
  ctx.fillStyle = 'rgba(8,6,12,0.92)'
  ctx.beginPath()
  ctx.ellipse(cx - lensDX, cy, lensW * 0.5, lensH * 0.5, 0, 0, Math.PI * 2)
  ctx.ellipse(cx + lensDX, cy, lensW * 0.5, lensH * 0.5, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(cx - w * 0.05, cy - 1.5, w * 0.1, 3) // bridge

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

// ---------- render ----------
function render(now) {
  ctx.fillStyle = '#05040a'
  ctx.fillRect(0, 0, innerWidth, innerHeight)

  drawSkyElder(now)
  if (captionTimer > 0) drawElderCaption(now)

  // ambient sky wash — this is where OTHER players' contributions become visible:
  // sky.hue/charge are nudged by remote deltas too, so the wash shifts even if
  // you personally haven't touched anything in a moment.
  const g = ctx.createRadialGradient(
    innerWidth / 2, innerHeight * 0.2, 0,
    innerWidth / 2, innerHeight * 0.2, Math.max(innerWidth, innerHeight) * 0.8
  )
  g.addColorStop(0, `hsla(${sky.hue},90%,55%,${0.05 + sky.charge * 0.35})`)
  g.addColorStop(1, 'hsla(0,0%,0%,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, innerWidth, innerHeight)

  drawTrail()
  drawTendrils(now)
  drawLightOrb(now)

  for (const u of herd) if (!u.gone) drawUnicorn(u)
  drawParticles()

  // HUD
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = '13px monospace'
  const lost = lostCount ? `   lost: ${lostCount}` : ''
  ctx.fillText(`sky charge ${(sky.charge * 100 | 0)}%   peers: ${peerCount}   home: ${deliveredCount}/${N_UNICORNS}${lost}`, 10, 20)
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

const net = connectRelay(todaysRoom(), {
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
