# Aurora Loom

## What this is
Pushing what is possible from a single .html, under 13k. Meh, Iunno really I'm trying to make it as auto-generational as possible and let it be as weird or as normal as it wants to be within the framework provided...

You drag a light across a night sky. A small wild herd of unicorns is drawn to its
warmth — and a giant bloodshot eye hangs over everything, watching, weeping acid,
getting redder the longer it stares. Anything inside your light is shielded from it.
Gather the herd into the light and walk them past the eye to the valley on the right;
get **13** across before the eye inflames all the way and takes the sky. Win and it
goes quiet at dawn; lose and the eye swells up and swallows everything — then a fresh
sky grows back, a little different. If other people happen to be playing right now,
your sky and theirs are the same sky.

Almost none of it is hand-authored: the stars, the palette, the eye's veins, the beat,
and the Elder's lyrics are all generated from the room's seed, so no two skies are the
same and everyone in a room shares theirs.

## How to play
- **Drag** (mouse or touch) to move the light and paint the sky brighter.
- Unicorns drift toward the light. **Whatever's inside the light is safe** — the eye
  can't take it, and neither can the crusty piles growing along the edges.
- Steer the herd to the **right edge (the valley)**; each one that crosses counts.
  You need enough "charge" (built by dragging) for them to cross.
- The **eye reddens over time, and more every time it eats one** — that's the clock.
  Get **13** across before it maxes out.
- It never really ends: each round the sky regrows a little different.

Run it locally (needs a static server, not `file://`, because the dev version is ES
modules):
```
npm run dev
```

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

## Build & submit
```
npm run build
```

Bundles `src/main.js` (+ `src/net.js`), minifies it, runs it through **Roadroller**
(a packer that beats plain zip), and inlines the result into a single
**self-contained** `dist/index.html` — no external fonts, CDNs, or services, per the
rules. It builds both the plain-minified and the Roadroller-packed variants, zips each
with `zip -9`, keeps whichever is smaller, and **fails if the zip exceeds 13,312 bytes**
(falls back to the minified build if Roadroller can't be fetched). Current output:
`dist/aurora-loom.zip` ≈ **11.6 KB** (~1.7 KB to spare). `dist/` and `*.zip` are
gitignored — submit the zip plus this public source repo.

Deadline: **13 Sep 2026, 13:00 CEST**. Category: **Online** (on top of Desktop/Mobile).

## Structure
```
index.html          dev entry point (ES modules, for `npm run dev`)
src/main.js          the whole game: input + shield, herd, the watching eye, the
                     corruption, the win/lose arc, procedural sky/lyrics/beat, audio
src/net.js           relay connection, offline-safe by construction
build.mjs            bundle + minify + Roadroller + inline + zip + 13KB gate (`npm run build`)
spike/relay-spike.mjs         standalone protocol test (2 clients, no game code)
spike/net-integration-test.mjs  same test through the real src/net.js module
package.json          npm run dev / build / spike / spike:net
```

Everything ships in the one bundled `dist/index.html`; `aurora-loom-demo.html` is an
old standalone mockup from early on (different look, uses web fonts) and is **not**
the game — kept around only as a scratch artifact.
