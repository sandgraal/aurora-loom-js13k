# TECHNIQUES — how Aurora Loom fits in 13KB, with receipts

Everything here was measured on this repo, not guessed. Sizes are the final
submission zip (`dist/aurora-loom.zip`) after each change, against the js13k
limit of **13,312 bytes**. If you're building your own entry, steal freely —
that's what this file is for.

## The byte ledger

| Change | zip after | delta |
|---|---|---|
| baseline (playable game, esbuild + Roadroller `-O1` + `zip -9`) | 12,110 | — |
| source golf (dead code, cfg inlining, `Math` hoist) | 11,832 | **−278** |
| pipeline upgrade (terser pass, advzip, `RR=2` option) | 11,131 | **−701** |
| Phase 1: real win/lose loop, eye hunt, weave economy | 11,254 | +123 |
| Phase 2: continuous beat, event-driven voice, seeded lyrics | 11,360 | +106 |
| Phase 3: valley endgame, dawn ceremony, fastest-dawn best | 11,524 | +164 |
| Phase 4: cooperative multiplayer fixes | 11,599 | +75 |
| Phase 5: resize/touch polish (release `RR=2` build) | 11,637 | +38 |
| Game-feel fix: steering rebalance + goal legibility | 11,955 | +318 |

Read that table again: **the entire second half of the game's design cost less
than the build pipeline saved.** Bank bytes before you spend them.

## The compression pipeline (build.mjs)

```
esbuild --bundle --minify          fast, gets ~95% of the way
  → terser -c passes=3,unsafe=true,pure_getters=true -m
                                   multi-pass squeeze past esbuild (1–3%)
  → Roadroller                     context-modeling packer; emits a self-
                                   evaluating JS string that beats DEFLATE
  → inline into one <html>         no external anything (rule + fewer bytes)
  → zip -9 -X                      max deflate, no extra fields
  → advzip -z -4 -i 64             zopfli re-deflate of the SAME zip: free bytes
```

Rules that made it robust:

- **Build both candidates, keep the smaller zip.** Roadroller output is *worse*
  than plain DEFLATE for small or repetition-heavy inputs. Never assume — race
  them every build.
- **Every optional tool is wrapped in try/catch.** Offline or missing npx
  package? The build still ships something legal.
- **`-O1` daily, `RR=2 npm run build` (Roadroller `-O2`) for release.** The
  full parameter search takes minutes; don't pay it per iteration.
- **The size gate is in the build** (`process.exit(1)` over 13,312). You can't
  accidentally drift over the limit if the build refuses to succeed.
- Measured here: terser+advzip bought **701 bytes** on a ~15KB inlined page.
  That's a whole feature phase of budget for one evening of build work.

## Source-level golf that actually mattered

- **Kill config indirection.** A `const cfg = {...}` object of named knobs read
  in 21 places cost ~400 source bytes *because property names can't be mangled*.
  Once tuning ended, every `cfg.hunger` became a literal. Keep the old values
  in one comment for archaeology.
- **Destructure `Math` once**: `const {sin,cos,min,max,hypot,random,PI}=Math;
  const P2=PI*2`. ~185 call sites shrank. Minifiers will NOT do this for you
  (they can't prove `Math` wasn't replaced). Caveat: gains partly overlap with
  what Roadroller's modeling already compresses — measure, don't assume.
- **Hunt genuinely dead code after every design pivot.** A removed tuning panel
  left live-looking bindings; a `delivered` flag was read in six places and set
  in none — an entire unreachable render path (the ghost-unicorn look) shipped
  for weeks. Grep for "assigned but never set true" fields after each cut.
- **Comments are free.** They're stripped before packing. This codebase is
  heavily commented *on purpose* — golf the shipped bytes, not the readable
  source. (js13k requires the readable repo anyway.)

## Seeded procgen: one string, one sky

Everything shared comes from a single seed — the relay room name
(`aurora-loom-YYYY-MM-DD`), hashed and fed to mulberry32:

```js
const rng = mulberry32(strSeed(ROOM))
```

- ~30 lines of hashing + PRNG replaces *every stored asset*: 150 stars, nebula
  bands, the eye's capillaries and bruise map, its almond outline, two lures,
  seven rainbow bands, and the beat (root note, kick pattern, bass walk, lead
  motif) are all just draws from `rng()`.
- **Streams, not one dice cup**: the lyrics use their own
  `mulberry32(strSeed(ROOM + 'v'))` so consuming a verse doesn't shift the
  world generation. Derive independent streams by salting the seed string.
- Because the seed is the *room name*, two strangers in today's relay room see
  the same sky without a single byte of sync traffic. Determinism IS the
  netcode for everything that doesn't move.
- The unicorns intentionally use unseeded `random()` — build, mane, horn, wings,
  gait — so "never the same unicorn twice" stays true per client.

## Audio with zero assets

All of it is synthesized at runtime — the zip contains no audio data at all:

- Drums are bare oscillator/noise envelopes (kick = pitch-swept sine, snare =
  filtered noise + tone, hats = short noise ticks) scheduled on a lookahead
  loop against `AudioContext.currentTime` — a ~40-line tracker.
- The drone is two detuned saws + LFO; the "90s tape" feel is a looped buffer
  of synthesized vinyl crackle.
- The voice is the browser's **SpeechSynthesis** (free!), slowed and pitched
  down, with a synthesized growl underneath and captions as the no-TTS
  fallback. Lyrics are template-filled from word banks (~700 bytes for
  thousands of distinct lines).
- The heartbeat's tempo/volume track the game's danger state — the cheapest
  dynamic-music system that exists: one parameter, one `setTimeout`-free rAF.
- js13k scores Audio as a criterion (silence = zero stars). A beat that plays
  *continuously* — with the voice dropping event lines over it — costs barely
  more than one that plays once.

## Offline-first Online (the relay category)

- The relay is dumb by design: `wss://relay.js13kgames.com/<room>`, `@id` =
  you, `+id`/`-id` = join/leave, anything else relayed verbatim. `src/net.js`
  wraps it in ~90 lines.
- **Offline-first is a construction, not a feature flag**: `connectRelay`
  returns a no-op stub if the constructor throws, every send is guarded, and
  the game loop never awaits the network. Unplug the network and nothing
  changes but the log.
- Shared state has no authority, so don't fight over it: blend (`charge` folds
  in only when it *raises* yours; hue eases on the shortest arc). Broadcasts
  are throttled to ~8/s — be a good citizen on a shared relay.
- Presence became *mechanical* for +75 bytes: another rider's cursor also
  shields unicorns under it, and their deliveries burst on your screen. If
  your multiplayer layer only draws dots, it's decoration; give the dots one
  rule that matters.

## Design post-mortem (the expensive lessons)

1. **Playtest for losability first.** A spawn-position bug put half of all
   replacement unicorns inside the goal zone — the game literally could not be
   lost, and every balance opinion formed before that fix was noise. The fix
   was one deleted ternary.
2. **Put the hitbox where the art is.** The eye killed at its geometric
   center with a 15px radius — under a ~1,100px sprite whose drawn pupil sits
   up to 200px away. The fix (track the drawn pupil, kill there, telegraph by
   holding a visible lock for 600ms) turned the title character from scenery
   into the antagonist.
3. **Every death deserves the same ceremony.** The border piles killed more
   than the eye did, silently. One shared `kill()` — sound, particle, ledger
   tick, narrated line — was ~+100 bytes and is most of why the game stopped
   feeling "disconnected".
4. **A timer isn't a system until the player can push it both ways.** The doom
   clock became a ledger: deliveries pay it down, deaths feed it, and it runs
   hotter as you approach the goal.
5. **Steering must never be gated on a resource.** The first weave-economy cut
   scaled the herd's pull with charge — so careful, slow herding (low charge)
   was exactly when the light was weakest, and the always-on ambient forces
   (lures, packing repulsion, an uncapped cohesion spring) out-pulled the
   player. The playtest verdict was "impossible to steer." The fix: a pull
   *floor* that beats every ambient force by construction, lures that yield
   whenever the light is held, capped springs — charge now sweetens steering
   but never gates it. Resources should price *protection and progress*, not
   the basic verb.
6. **Normalize per-frame forces to a timestep.** `v += a` each frame with
   `v *= 0.96` damping means handling is 2× snappier at 120Hz and 2× sludgier
   at 30fps — and a per-frame accrual cap doubles at 120Hz. One hoisted
   `fs = dt/16.7` and `damp = 0.96 ** fs` makes the game feel identical on
   every display (terminal velocity within 3% across 30–120fps) for ~40 bytes.
7. **A gate no one can see is a bug, not a rule.** The "charge > 0.5 to
   deliver" gate had zero pixels of representation; failing it was a silent
   bounce. Now the same fact is shown three ways: a meter arc on the orb that
   flips gold at the gate, a valley that visibly opens and shuts with it, and
   a one-line coach hint that retires on your first delivery. Redundant
   channels are how one-verb games teach without a tutorial.
8. **A verb without a cost isn't a decision.** Holding the light used to do
   everything for free. Now charge is *woven* by movement and *spent* by
   shielding and delivering — park to protect, weave to bank. Same one-finger
   input, actual choices.
9. **Promote your accidents.** Delivered unicorns already splattered remains
   near the goal by accident of code order. Making that intentional ("the
   valley remembers what you fed it" — the goal itself wakes as a threat
   around crossing 8) was the cheapest endgame we could have written.
