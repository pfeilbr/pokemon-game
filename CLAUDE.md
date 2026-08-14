# CLAUDE.md

Guidance for Claude Code (and any other contributor) working in this repository.

## What this is

**Mathmon Battle League** — a creature-collecting battle game where every attack
is gated behind a maths problem. It was built for one specific player: a
seven-year-old bilingual (English/Chinese) boy who likes trading cards, plays
chess, and is good at maths. Nearly every design decision below traces back to
that.

The creatures are original. There are no Nintendo assets, names, or sprites
anywhere in this repository, and there should never be.

## Commands

```bash
npm run dev          # dev server on :3000
npm run build        # production build
npm test             # unit tests (Vitest)
npm run test:e2e     # E2E tests (Playwright) — needs `npm run build` first
npm run test:all     # typecheck + unit + E2E
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run format       # Prettier
npm run screenshots  # regenerate docs/screenshots/
```

In a sandbox whose bundled Chromium predates this Playwright version, set
`PLAYWRIGHT_CHROMIUM_PATH` to the local Chromium binary.

**The root CI job does not install `mobile/node_modules`.** Anything at the root
that reaches into `mobile/` therefore passes on a developer machine, where those
packages happen to be present, and fails only in CI. This has bitten twice: the
root `tsconfig` quietly type-checking 23 React Native files (sixteen red runs),
and `audit_docs.py` bundling `mobile/src/storage.ts` for a string literal. To
reproduce CI before pushing:

```bash
npm run preflight
```

That is `scripts/preflight.py`, and it exists because the recipe it replaces was
a procedure you had to _remember_ — which is not a guard. It reads the check
list out of `.github/workflows/ci.yml` rather than hardcoding one that would
drift, parks `mobile/node_modules` outside the repo (a `.bak` alongside it would
trip `audit_assets.py`, which rightly objects to an untracked, un-ignored
directory appearing in the tree), runs everything CI runs that can honestly run
locally, and prints a `NOT EXERCISED LOCALLY` section naming what it skipped and
why — a preflight that quietly omits a check is the false confidence this repo
keeps getting burned by.

It is proven against the real historical bug: with `audit_docs.py` reverted to
bundling `mobile/src/storage.ts`, running it directly exits 0 and the bug ships,
while `npm run preflight` exits 1 with CI's actual
`Could not resolve "@react-native-async-storage/async-storage"`.

Restoration is belt-and-braces — `try/finally`, signal handlers, `atexit`, and a
breadcrumb written _before_ the move so even a SIGKILL is repairable by the next
run or `npm run preflight -- --restore`. A crash that left your
`mobile/node_modules` parked would be worse than the bug it prevents.

`npm run audits` runs the audit scripts alone, without the parking.

**Regenerate screenshots against their own port**, e.g. `PORT=3177 npm run
screenshots`. `playwright.config.ts` sets `reuseExistingServer: !process.env.CI`,
so a screenshot run will silently attach to any dev server already listening and
photograph whatever that server is serving — which is how seven blank captures
were produced, four of them from tests that reported PASS. `shot()` now refuses
to photograph a page with almost no visible text, and `scripts/audit_screenshots.py`
catches what gets past it: it found `12-chinese.png` byte-identical to
`02-dashboard.png`, meaning the README's only picture of the Chinese interface
had always been an English dashboard.

### iOS

```bash
cd mobile
npm run typecheck
npm test          # shared-engine seam + API client contract
npm run bundle    # real Metro/Hermes compile; works on Linux, no Xcode needed
```

Everything requiring macOS runs on GitHub Actions, not locally - see
`.github/workflows/ios.yml` and `mobile/README.md`. The simulator job needs no
Apple credentials, so the iOS build is verified on every push for free.

### Testing the database path

The account layer talks SQL, so it is covered by integration tests rather than
mocks. They skip themselves unless a database is offered, which keeps
`npm test` dependency-free:

```bash
export TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable'
npm test          # adds 18 Postgres integration tests
npm run test:e2e  # adds 8 signed-in browser tests, incl. cross-device sync
```

Without it, the suite exercises the zero-config (local-only) deployment, which
is what a default Vercel import actually runs. CI runs both.

## Architecture

The hard rule: **all game rules live in `src/lib/game/` as pure, deterministic,
seeded functions.** React never decides anything about the game.

```
src/lib/game/       The engine. Pure. No React, no I/O, no Date.now, no Math.random.
  rng.ts            Seeded mulberry32.
  elements.ts       The six-element wheel.
  creatures.ts      The 36-creature roster (12 lines) + art specs.
  art.ts            Creature geometry as data. Pure; no SVG, no DOM.
  moves.ts          The four-slot move kit.
  math.ts           Problem generation + adaptive difficulty.
  prompt.ts         How wide a prompt is, and how large it may be drawn.
                    Pure; no CSS, no points, no DOM.
  battle.ts         The battle state machine (a reducer).
  progress.ts       XP, levels, evolution, badges, streaks, save repair.

src/lib/storage/    Client persistence (localStorage + server sync).
src/lib/server/     Postgres, sessions, accounts. Server-only.
src/components/     React. Presentation and timing only.
src/app/            Next.js App Router pages and API routes.
e2e/                Playwright specs, including the screenshot suite.
mobile/             iOS client (React Native / Expo). See mobile/README.md.
```

### Two clients, one engine

`src/lib/game/` is consumed by both the web app and the iOS client. That is the
whole reason the engine is kept free of React, the DOM, Node APIs and ambient
randomness - portability is a consequence of purity, not a separate goal.

The iOS client reaches it through `mobile/src/engine.ts`, the single file that
knows the path across the directory boundary, with Metro `watchFolders` making
it visible. `mobile/src/engine.test.ts` fails if a shared module grows a Node
or browser dependency that would break under Hermes.

So: a rule change belongs in `src/lib/game/` and lands on both clients at once.
Never fork a rule into a client.

The prompt's _size_ is shared the same way, and for the same reason. The chess
strand made the longest question `(♛9 + ♜5) − (♝3 + ♟1)` — 21 characters, four
of them glyphs nearly twice the advance of a digit — and it wrapped onto two
lines on every phone. `prompt.ts` answers "how many ems wide is this string" and
"what size fits a line box of N units"; each client supplies only what it alone
knows, its normal size and its own line box. The harder case turned out to be a
laptop, not a phone: above `lg` the battle splits into two columns, so a wide
screen gives the prompt a _narrower_ box while using the largest type.

The creature art is shared the same way the rules are. `art.ts` emits a
`Drawing` — primitive shapes and gradients, no SVG and no DOM — and each client
has a thin renderer whose whole job is a 45-line switch mapping each
primitive onto its own surface. The geometry
used to be written out once per client and hand-ported, which made "this
creature quietly lost its crown on iOS" a real and invisible bug, because a
missing branch draws nothing and nothing looks like art.

What the iOS client does own is presentation, and three things it cannot share:
`AsyncStorage` in place of `localStorage` (same key, same `normaliseProfile` at
the boundary), the Taptic Engine in place of Web Audio, and an explicit
`AccessibilityInfo` check where the web gets `prefers-reduced-motion` from CSS.
Each is a substitution for a platform API, never for a rule. `mobile/README.md`
tabulates them.

### Why the engine is pure

Every function in `src/lib/game/` is deterministic given its inputs. Randomness
comes from explicit seeds (`${seed}:${turn}:${purpose}`), and the current time
is passed **into** the reducer with each action rather than read inside it.

That buys three things:

- A battle replays exactly in a test. There is no "sometimes it crits".
- A battle can be serialised to JSON mid-fight and resumed.
- Balance can be proven rather than play-tested by hand. The suite simulates all
  144 starter matchups and asserts properties about the outcomes.

If you find yourself reaching for `Date.now()` or `Math.random()` inside
`src/lib/game/`, that is the signal you are putting a rule in the wrong place.

## Design decisions worth knowing before you change something

These are load-bearing. Each one is guarded by a test, and several were written
_because_ a test caught the opposite behaviour.

**A wrong answer deals flat chip damage — no type bonus, no combo, no speed.**
An earlier version scaled a miss like a normal hit. With a 2× type advantage
that was enough to win a fight while answering every single question wrong.
Maths has to be the win condition. `battle.test.ts` sweeps all 144 matchups to
guard this.

**The element wheel is provably symmetric.** Each element is strong against the
next two in the cycle and weak to the previous two, so every element's matchup
multipliers sum to exactly 7. No element is secretly best, which makes
counter-picking a real decision rather than trivia.

**Every matchup is winnable, including the worst one.** Dealing 0.5× while
taking 2× is survivable if you save the special for full charge — it finishes at
roughly 39% health versus 85% for the reverse pick. A bad matchup should be a
lesson, not a wall. Tested at level 1 and level 3.

**Stats are identical across elements at equal stage.** Matchups are decided by
the wheel, not by stat creep.

**Answers are always non-negative integers.** The player types on an on-screen
keypad, so negatives and decimals would be a UX tax rather than a lesson. If you
add a maths skill, it must satisfy this.

**Losing still awards XP.** A seven-year-old who gets nothing for trying stops
trying.

**The opponent never attacks on turn one**, and answering slowly is never
penalised below normal damage. Speed earns a bonus; slowness is not punished.

**The speed meter is a bonus, not a timer.** The engine always paid up to +30%
damage for a fast answer, but nothing showed it, so a child saw "Critical hit!"
on some turns and "Correct!" on others with no idea why. The meter under the
question drains in real time and names the bonus. When it empties it says "take
your time" rather than counting down to a penalty - there is no timeout in the
UI, and running the clock out costs nothing. Guarded by an E2E test that lets it
empty and then checks a correct answer still lands normally.

**Difficulty adapts on a rolling 8-attempt window** and moves one tier at a
time, so a lucky streak of easy questions cannot fling a child into fractions.

**Promotion needs accuracy; speed only decides how fast it arrives.** There are
two routes up: accurate and within par promotes on 8 attempts, sustained
near-perfect accuracy promotes on 16 at any pace at all. The second route exists
because the first was a trap — promotion used to require _both_, and par at tier
1 is 5.1 seconds while a seven-year-old hunting for digits on an on-screen keypad
takes seven. He could answer four hundred questions without a single mistake and
stay on "adding to 20" forever, because the adapter could not tell slow hands
from weak maths. That is the opposite of the rule below, and a permanent
difficulty cap is the harshest punishment this game has.
`scripts/simulate_difficulty.py` found it and now guards both directions: no
accurate player is capped by his pace (P5), and a quick one still reaches the top
sooner (P6).

**`normaliseProfile` repairs anything it is given.** Save data outlives code.
Unknown creature ids, negative XP, invented badges, corrupt dates and wrong
types all fall back to defaults rather than throwing. A child losing his album
to a schema change is not an acceptable failure.

## Deployment model

The app is **offline-first**, and this is deliberate:

- The profile always lives in `localStorage`. The game is fully playable with no
  account, no network, and **no environment variables at all** — which is why a
  zero-config Vercel import works on the first click.
- Signing in is an _upgrade_. It mirrors the same profile to Postgres so it
  follows the player to another device. **Conflicts merge what was earned** —
  album, badges, records and lifetime counters — and resolve last-write-wins on
  `updatedAt` only for mutable state (name, tier, settings, the attempt window).

  It used to be last-write-wins for everything, and that quietly cost a child
  his afternoon. It did not even need a wrong clock: toggling the language on
  the laptop bumps `updatedAt` without earning anything, so a tablet carrying an
  afternoon of catching and winning lost to a laptop that had barely started.
  126 of 216 seeded divergences were lossy, and a device with a fast clock won
  every comparison forever. `scripts/audit_sync.py` found it and now guards it, along
  with commutativity — the old rule gave a different answer depending on which
  device happened to sync first.

- `accountsAvailable()` gates the whole account UI. With no database, the app
  says so plainly instead of erroring.

Every environment variable is optional. See `.env.example`.

## Security notes

**A 4-digit PIN is only 10,000 combinations.** The hash is not the defence — the
lockout is. Five wrong guesses lock an account for fifteen minutes. PINs are
scrypt-hashed with a per-account salt so a database leak does not expose them,
and login failures are indistinguishable between "no such name" and "wrong PIN"
so the endpoint cannot enumerate trainers. If you touch `accounts.ts`, keep all
three properties.

**The server never trusts a client profile.** `PUT /api/profile` runs
`normaliseProfile` before storing, so a tampered payload cannot poison the save.

**`AUTH_SECRET` falls back to an HKDF of `DATABASE_URL`** when unset, so accounts
work immediately after attaching a database in the Vercel UI. It logs a warning.
It is a convenience, not a recommendation — the derived key is only as private
as the connection string.

## Conventions

- TypeScript strict, including `noUncheckedIndexedAccess`. Index access is
  genuinely `T | undefined`; handle it rather than reaching for `!`.
- Prefer throwing on invalid data in the engine (`getCreature` throws on an
  unknown id) and repairing it at the boundary (`normaliseProfile`).
- Comments explain _why_, not _what_. Several of the comments in this codebase
  record a bug that was caught — do not delete those.
- Tests assert behaviour and properties, not implementation. When a test fails,
  first work out whether the test or the code is wrong; twice during this build
  the test was the one asserting the wrong thing.
- Both languages are first-class. Any new user-facing string goes in
  `src/lib/i18n.ts` with `en` and `zh`, and any new creature or badge needs both
  names. The types enforce this.
- Every tap target is at least 56px (`tap` utility). Reduced motion is honoured
  globally in `globals.css`.

## Adding things

**A creature:** add a `LineEntry` to the relevant line in `creatures.ts`. Art is
generated from its `ArtSpec` by `art.ts`, so no image is needed on either
client. `rosterIsComplete()` and the roster tests will tell you if the line is
malformed.

**A whole evolution line:** add a `Line` with a unique `id`. `evolutionLine`
walks by `lineId`, never by element, because two lines share each element -
finding the root by element instead would evolve a Cinderpup into a Blazur, and
a test guards exactly that.

**An art feature** (a crown, a tail, a texture): extend the union in
`creatures.ts` and add a branch in `art.ts`. Both clients pick it up with no
change, because they only know how to draw primitives. `art.test.ts` asserts
every value the roster uses produces more shapes than not using it, which is
what catches a feature that silently draws nothing.

**A maths skill:** add it to `SKILLS` and `SKILL_META` in `math.ts` with a tier
band and both labels. The test suite re-evaluates every generated prompt
independently across all tiers, so a generator that can throw or produce a
non-integer answer will fail immediately.

**A badge:** add it to `BADGES` in `progress.ts`. A test asserts every badge is
reachable by some profile, so dead badges fail the build.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
