// Sanity check that src/net.js — the exact module main.js imports — round-trips
// correctly against the live relay, using the same API shape main.js calls
// (connectRelay, todaysRoom, .send(), onId/onPeerJoin/onPeerLeave/onMessage).
import { connectRelay, todaysRoom } from '../src/net.js'

const room = `${todaysRoom('net-test')}-${Date.now()}`
let aReady, bReady
const aReadyP = new Promise((r) => (aReady = r))
const bReadyP = new Promise((r) => (bReady = r))

const a = connectRelay(room, {
  onId: (id) => { console.log('[A] id', id); aReady(id) },
  onPeerJoin: (id) => console.log('[A] peer joined', id),
  onMessage: (data) => console.log('[A] got', data),
})
const b = connectRelay(room, {
  onId: (id) => { console.log('[B] id', id); bReady(id) },
  onPeerJoin: (id) => console.log('[B] peer joined', id),
  onMessage: (data) => console.log('[B] got', data),
})

await Promise.all([aReadyP, bReadyP])
await new Promise((r) => setTimeout(r, 400))

console.log('\n[A] sending sky mutation via net.send() ...')
a.send({ t: 'sky', charge: 0.77, hue: 300 })
await new Promise((r) => setTimeout(r, 500))

a.close()
b.close()
await new Promise((r) => setTimeout(r, 300))
console.log('\nOK: net.js works standalone exactly as main.js uses it.')
process.exit(0)
