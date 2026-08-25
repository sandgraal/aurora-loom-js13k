// Aurora Loom — throwaway spike #1: does the js13kgames 2026 Online relay actually work?
//
// Protocol, confirmed directly from https://js13kgames.com/2026/online (rendered in a
// real browser — the page is a client-rendered SPA that doesn't yield body text to
// plain HTTP fetches, so this was read via browser automation, not guessed):
//
//   const ws = new WebSocket('wss://relay.js13kgames.com/<room>')
//   ws.onmessage = event => {
//     const msg = event.data
//     switch (msg[0]) {
//       case '@': console.log('My ID is:', msg.slice(1)); break        // sent once, on connect
//       case '+': console.log('A client connected, ID:', msg.slice(1)); break
//       case '-': console.log('A client disconnected, ID:', msg.slice(1)); break
//       default:  console.log('Message:', msg)                        // relayed from another client
//     }
//   }
//
// Direct/whisper message to one client: ws.send(`@${clientId}|payload`)
// Rooms are created on first connect and are EPHEMERAL — they vanish once empty.
// That's a real constraint: there is no free persistent store here, only live relay
// between whoever's currently connected. (See README.md — this changes the "world
// persists across the whole month" framing in the original pitch doc.)
//
// This script opens two independent connections to the SAME room (simulating two
// players) and confirms: connect, receive your own ID, see the other peer join,
// exchange a broadcast message, exchange a direct/whispered message, see a
// disconnect notice. If this all works, the Online-category bet is alive.

const ROOM = `aurora-loom-spike-${Date.now()}`
const RELAY = `wss://relay.js13kgames.com/${ROOM}`

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY)
    let myId = null
    const timeout = setTimeout(() => reject(new Error(`${label}: timed out waiting for connection`)), 8000)

    ws.onopen = () => {
      console.log(`[${label}] connected to ${RELAY}`)
    }
    ws.onerror = (err) => {
      console.log(`[${label}] ERROR`, err.message || err)
    }
    ws.onmessage = (event) => {
      const msg = event.data
      switch (msg[0]) {
        case '@':
          myId = msg.slice(1)
          console.log(`[${label}] my client ID is: ${myId}`)
          clearTimeout(timeout)
          resolve({ ws, id: myId, label })
          break
        case '+':
          console.log(`[${label}] peer connected: ${msg.slice(1)}`)
          break
        case '-':
          console.log(`[${label}] peer disconnected: ${msg.slice(1)}`)
          break
        default:
          console.log(`[${label}] message received: ${msg}`)
      }
    }
  })
}

async function main() {
  console.log(`Spiking room: ${ROOM}\n`)

  const a = await connect('A')
  const b = await connect('B')

  await new Promise((r) => setTimeout(r, 500)) // let join notifications settle

  console.log('\n--- broadcast test ---')
  a.ws.send('hello from A (broadcast)')
  await new Promise((r) => setTimeout(r, 500))

  console.log('\n--- direct/whisper test ---')
  b.ws.send(`@${a.id}|hello from B (direct to A only)`)
  await new Promise((r) => setTimeout(r, 500))

  console.log('\n--- shared-state simulation: JSON-encoded mutation broadcast ---')
  // We don't get a server-side state store (rooms are ephemeral, no persistence API),
  // so "shared state" has to be each client broadcasting its own deltas and every
  // client folding them into local state. This simulates exactly that.
  a.ws.send(JSON.stringify({ type: 'sky-mutate', hue: 210, charge: 0.42, from: a.id }))
  await new Promise((r) => setTimeout(r, 500))

  console.log('\n--- disconnect test ---')
  a.ws.close()
  await new Promise((r) => setTimeout(r, 500))

  b.ws.close()
  await new Promise((r) => setTimeout(r, 300))

  console.log('\nSpike complete. If you saw: connect, an ID for both A and B, A/B join notices,')
  console.log('the broadcast text, the direct message, the JSON mutation, and a disconnect notice —')
  console.log('the relay works exactly as documented and the Online-category bet is GO.')
  process.exit(0)
}

main().catch((err) => {
  console.error('SPIKE FAILED:', err)
  process.exit(1)
})
