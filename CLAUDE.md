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
  creatures.ts      The 18-creature roster + art specs.
  moves.ts          The four-slot move kit.
  math.ts           Problem generation + adaptive difficulty.
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

### Why the engine is pure

Every function in `src/lib/game/` is deterministic given its inputs. Randomness
comes from explicit seeds (`${seed}:${turn}:${purpose}`), and the current time
is passed **into** the reducer with each action rather than read inside it.

That buys three things:

- A battle replays exactly in a test. There is no "sometimes it crits".
- A battle can be serialised to JSON mid-fight and resumed.
- Balance can be proven rather than play-tested by hand. The suite simulates all
  36 starter matchups and asserts properties about the outcomes.

If you find yourself reaching for `Date.now()` or `Math.random()` inside
`src/lib/game/`, that is the signal you are putting a rule in the wrong place.

## Design decisions worth knowing before you change something

These are load-bearing. Each one is guarded by a test, and several were written
_because_ a test caught the opposite behaviour.

**A wrong answer deals flat chip damage — no type bonus, no combo, no speed.**
An earlier version scaled a miss like a normal hit. With a 2× type advantage
that was enough to win a fight while answering every single question wrong.
Maths has to be the win condition. `battle.test.ts` sweeps all 36 matchups to
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
time. Promotion needs both accuracy _and_ comfort within par, so a lucky streak
of easy questions cannot fling a child into fractions.

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
  follows the player to another device. Conflicts resolve last-write-wins on
  `updatedAt`.
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
generated from the spec, so no image is needed. `rosterIsComplete()` and the
roster tests will tell you if the line is malformed.

**A maths skill:** add it to `SKILLS` and `SKILL_META` in `math.ts` with a tier
band and both labels. The test suite re-evaluates every generated prompt
independently across all tiers, so a generator that can throw or produce a
non-integer answer will fail immediately.

**A badge:** add it to `BADGES` in `progress.ts`. A test asserts every badge is
reachable by some profile, so dead badges fail the build.
