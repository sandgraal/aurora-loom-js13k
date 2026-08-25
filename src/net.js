// Online layer for the js13kgames 2026 "Online" category relay.
//
// Confirmed protocol (js13kgames.com/2026/online, live-tested — see spike/relay-spike.mjs):
//   wss://relay.js13kgames.com/<room>            connect / auto-creates room
//   incoming msg[0] === '@'  -> msg.slice(1) is YOUR OWN client id (sent once)
//   incoming msg[0] === '+'  -> msg.slice(1) is a peer's id that just connected
//   incoming msg[0] === '-'  -> msg.slice(1) is a peer's id that just disconnected
//   anything else            -> a message relayed verbatim from another client
//   ws.send(`@${id}|payload`) -> whisper directly to one client id
//
// Hard rule (confirmed on the same page): "Your game must work offline (e.g. be
// playable by a single player). Online features must be optional." Every call in
// this module is wrapped so a failed/blocked/slow connection NEVER blocks or breaks
// the local game — it just means you play solo, which must always be a complete
// experience on its own.
//
// Also confirmed: rooms are EPHEMERAL — they disappear once nobody's connected.
// There is no free persistent store here. "Shared state" only exists for as long as
// someone's around to hold it in memory and re-broadcast it; a fresh room starts
// blank. That's a real constraint, not a bug — see README.md for how the game
// design leans into it instead of fighting it.

const RELAY_HOST = 'wss://relay.js13kgames.com'

export function connectRelay(room, handlers = {}) {
  const { onId, onPeerJoin, onPeerLeave, onMessage, onError } = handlers
  let ws
  try {
    ws = new WebSocket(`${RELAY_HOST}/${room}`)
  } catch (err) {
    onError?.(err)
    return offlineStub()
  }

  let myId = null
  let open = false

  ws.onopen = () => { open = true }

  ws.onerror = (err) => { onError?.(err) }

  ws.onclose = () => { open = false }

  ws.onmessage = (event) => {
    const msg = event.data
    if (typeof msg !== 'string' || msg.length === 0) return
    switch (msg[0]) {
      case '@':
        myId = msg.slice(1)
        onId?.(myId)
        break
      case '+':
        onPeerJoin?.(msg.slice(1))
        break
      case '-':
        onPeerLeave?.(msg.slice(1))
        break
      default:
        onMessage?.(safeParse(msg))
    }
  }

  return {
    get id() { return myId },
    get connected() { return open },
    // Broadcast a small state delta to everyone else currently in the room.
    // Never throws even if the socket isn't open yet/anymore — solo play must
    // never depend on this succeeding.
    send(data) {
      if (!open) return
      try { ws.send(JSON.stringify(data)) } catch { /* offline-first: swallow */ }
    },
    whisper(peerId, data) {
      if (!open) return
      try { ws.send(`@${peerId}|${JSON.stringify(data)}`) } catch { /* ignore */ }
    },
    close() { try { ws.close() } catch { /* ignore */ } },
  }
}

function safeParse(msg) {
  try { return JSON.parse(msg) } catch { return { raw: msg } }
}

function offlineStub() {
  return { id: null, connected: false, send() {}, whisper() {}, close() {} }
}

// One room per calendar day keeps strangers who happen to be playing "right now"
// together without needing any matchmaking UI. Swap for a fixed string while
// developing solo so you don't need a second tab to see peer-join messages.
export function todaysRoom(prefix = 'aurora-loom') {
  const d = new Date().toISOString().slice(0, 10)
  return `${prefix}-${d}`
}
