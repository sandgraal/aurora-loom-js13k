# Aurora Loom

## What this is
An exhibit of what is possible from a single .html, under 13k. Meh, Iunno really I'm trying to make it as auto-generational as possible and let it be as weird or as normal as it wants to be within the framework provided...You drag a light across a night sky; a small wild herd of unicorns is drawn to
warmth. Avoid the eye at all costs, who know why it seems so creepy. Get enough shared "charge" into the sky and the herd
crosses to the valley. If other people happen to be playing right now, your
sky and theirs are the same sky.

## What the Online relay actually is
`spike/relay-spike.mjs` opens two real WebSocket connections to
`wss://relay.js13kgames.com/<room>` from this machine and round-trips a
connect, an ID assignment, a peer-join notice, a broadcast message, a direct
"whisper" message, a JSON state mutation, and a disconnect notice. **It all
worked, live, on the first try** — run `npm run spike` to see it yourself.
`spike/net-integration-test.mjs` does the same thing through the actual
`src/net.js` module the game imports, confirming the real code path (not just
the protocol) works end to end.

The relay is pure message-passing between whoever's currently
connected, with no server-side persistence. There is no way to make the sky
"remember every rider all month" for free; when a room empties, it's gone.
The design leans into this instead of fighting it: the sky is *supposed* to be
as temporary as the rainbows it's made of. The Sky Elder log now narrates only
the current room's live session, which is honest about what the tech actually
does and, arguably, a better fit for the theme than a fake sense of permanence
would have been.

You can unplug your network and the game still plays start to finish.

One more thing worth using later: js13kgames hosts an official PartySocket
build at `//play.js13kgames.com/2026/online/partysocket.js` that you can
import at runtime **without it counting against your 13KB zip** (it's fetched
from their server, not bundled). `src/net.js` currently talks to the raw
WebSocket directly instead — the protocol is simple enough that a wrapper
isn't needed yet — but if reconnect/backoff handling becomes worth it later,
that import is free.

## Structure

```
index.html          entry point, canvas + minimal log overlay
src/main.js          game loop: drag-light input, boid herd, rendering, scoring
src/net.js           relay connection, offline-safe by construction
spike/relay-spike.mjs         standalone protocol test (2 clients, no game code)
spike/net-integration-test.mjs  same test through the real src/net.js module
package.json          npm run dev / build / spike / spike:net
```
