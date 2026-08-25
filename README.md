# Aurora Loom — js13kgames 2026

Status: **playable vertical slice, Online layer confirmed live.** Not yet visually
playtested by a human — see "What's verified vs. not" below.

## What this is

You drag a light across a night sky; a small wild herd of unicorns is drawn to
warmth and flees grey. Get enough shared "charge" into the sky and the herd
crosses to the valley. If other people happen to be playing right now, your
sky and theirs are the same sky — the js13kgames 2026 Online-category relay
broadcasts everyone's nudges to everyone else currently connected.

Run it (needs a static server, not `file://`, because it's ES modules):
```
npm run dev
```
then open the printed localhost URL and drag on the canvas.

## Corrections to the original pitch doc, now that the actual rules page was read

The earlier design doc was written against research-agent summaries of
js13kgames.com pages that don't render body text to plain HTTP fetches (it's a
client-rendered SPA). I read the real, rendered `/2026/rules` and `/2026/online`
pages directly in a browser this round. Three corrections:

1. **There is no separate "Web" category.** The two base categories are
   **Desktop** and **Mobile**. Online and WebXR are *additional* categories you
   can qualify for on top of whichever base category your entry competes in —
   so yes, a single submission can be both a base-category entry and an
   Online-category entry; that wasn't confirmed before, it is now.
2. **Deadline, exact:** submissions close **13 September 2026, 13:00 CEST**,
   which is **05:00 in Costa Rica time** that same day. "Sep 10 as your real
   deadline" from the original doc still stands as sound advice — just be aware
   the actual cutoff is early morning your time, not end-of-day.
3. **Submissions require a public GitHub repo with buildable, unmangled source**
   (js13kGames clones it for their archive) — not just the zipped build. This
   repo already has `spike/`, `src/`, and a `package.json` with a `build`
   script, structured to satisfy that from day one.

## What the Online relay actually is (confirmed live, not just documented)

`spike/relay-spike.mjs` opens two real WebSocket connections to
`wss://relay.js13kgames.com/<room>` from this machine and round-trips a
connect, an ID assignment, a peer-join notice, a broadcast message, a direct
"whisper" message, a JSON state mutation, and a disconnect notice. **It all
worked, live, on the first try** — run `npm run spike` to see it yourself.
`spike/net-integration-test.mjs` does the same thing through the actual
`src/net.js` module the game imports, confirming the real code path (not just
the protocol) works end to end.

One important finding that **changes the original pitch's framing**: rooms are
**ephemeral** — the relay is pure message-passing between whoever's currently
connected, with no server-side persistence. There is no way to make the sky
"remember every rider all month" for free; when a room empties, it's gone.
The design leans into this instead of fighting it: the sky is *supposed* to be
as temporary as the rainbows it's made of. The Sky Elder log now narrates only
the current room's live session, which is honest about what the tech actually
does and, arguably, a better fit for the theme than a fake sense of permanence
would have been.

Also confirmed on the rules page: **"Your game must work offline... Online
features must be optional"** is an actual rule, not just good design advice —
`src/net.js` is written so every call is wrapped and a failed/blocked/absent
connection never breaks or blocks the local game. You can unplug your network
and the game still plays start to finish.

One more thing worth using later: js13kgames hosts an official PartySocket
build at `//play.js13kgames.com/2026/online/partysocket.js` that you can
import at runtime **without it counting against your 13KB zip** (it's fetched
from their server, not bundled). `src/net.js` currently talks to the raw
WebSocket directly instead — the protocol is simple enough that a wrapper
isn't needed yet — but if reconnect/backoff handling becomes worth it later,
that import is free.

## What's verified vs. not

Verified, live, from this environment:
- The relay protocol works exactly as documented (`npm run spike`)
- `src/net.js` — the exact module the game uses — round-trips real state through it (`npm run spike:net`)
- Both `src/*.js` files pass `node --check` (syntax is valid)

Not yet verified (this sandbox has no browser to render canvas/DOM in):
- Actual visual rendering, the drag feel, boid tuning, frame rate
- Cross-browser behavior (rules require Chrome + Firefox both working)

**Next step: open `index.html` (via `npm run dev`, not double-clicking the
file) yourself and tell me what feels off** — boid pull strength, charge
decay rate, whether dragging feels good on trackpad vs. touch — so tuning can
start from real feedback instead of guesses. I can also keep iterating on the
code blind based on your descriptions if that's easier than sending screenshots.

## Structure

```
index.html          entry point, canvas + minimal log overlay
src/main.js          game loop: drag-light input, boid herd, rendering, scoring
src/net.js           relay connection, offline-safe by construction
spike/relay-spike.mjs         standalone protocol test (2 clients, no game code)
spike/net-integration-test.mjs  same test through the real src/net.js module
package.json          npm run dev / build / spike / spike:net
```

## Not done yet (per the build plan)

Visual pass (currently just glow shapes, no parametric unicorn silhouette
detail), audio (no ZzFX/oscillator music yet), difficulty/pacing tuning,
compression pass (Terser/Roadroller/zip -9 — nothing minified yet, this is
dev-mode source), and the actual submission repo cleanup.
