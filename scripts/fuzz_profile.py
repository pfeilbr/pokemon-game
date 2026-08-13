#!/usr/bin/env python3
"""Fuzz `normaliseProfile` with a fixed corpus of hostile saves, and fail on any violation.

Why this exists
---------------
`normaliseProfile` is the only thing standing between a hostile request body and
the database: `PUT /api/profile` calls it before storing, and the two clients
call it on everything they read back out of localStorage / AsyncStorage. The
claim in CLAUDE.md is absolute - "repairs anything it is given" - so it is worth
checking as a property over thousands of inputs rather than a dozen hand-written
cases.

`src/lib/game/progress.fuzz.test.ts` asserts the same properties inside Vitest.
This script exists for the same reason `balance_report.py` does: it prints the
numbers behind the green tick, so "what did the fuzzer actually try, and what
did it do with it" can be read rather than inferred. It also runs with no test
runner at all, which makes it usable as a pre-deploy check.

How it runs the engine
----------------------
The engine is pure TypeScript with no React, DOM or Node dependencies, so it is
bundled with the repo's own esbuild and executed under plain node - the same
harness pattern as `balance_report.py`. No network is touched.

The corpus below mirrors the one in `progress.fuzz.test.ts`, the way the bot in
`balance_report.py` mirrors `playSmart` from `battle.test.ts`: same seed, same
atom table, same generation order, so the two agree on what "the corpus" means.

Determinism
-----------
Inputs come from the repo's own seeded mulberry32 with a literal seed. Nothing
reads the wall clock, nothing samples the system RNG, and the report prints no
timings or paths, so two runs on the same commit produce byte-identical output.

Exit status
-----------
0  every input was either rejected as `null` or repaired into a profile that
   satisfies every invariant, idempotently, and survives a JSON round-trip.
1  at least one invariant was violated. The offending inputs are printed.
2  the harness could not be built or run.

Note on shelling out: every subprocess is invoked with an explicit argv list and
its return code is checked directly. Nothing is piped through `head`/`tail`,
because a pipeline reports the exit status of its *last* command and that has
already hidden a real failure in this repo once.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ESBUILD = REPO_ROOT / "node_modules" / ".bin" / "esbuild"

# Must match SEED / RANDOM_CASES in src/lib/game/progress.fuzz.test.ts.
SEED = "mathmon:normaliseProfile:fuzz:v1"
RANDOM_CASES = 2500

# How many failing inputs to print in full before summarising the rest.
MAX_SHOWN = 10

HARNESS = r"""
import { CREATURES } from '@engine/creatures';
import { ADAPT_WINDOW, MAX_TIER, MIN_TIER, SKILLS } from '@engine/math';
import { BADGES, MAX_TRAINER_NAME, PROFILE_VERSION, normaliseProfile } from '@engine/progress';
import { createRng } from '@engine/rng';

const config = JSON.parse(process.argv[2]);

// --- tools -----------------------------------------------------------------

/** Iterative, so a 10,000-deep hostile object compares without blowing the stack. */
function deepEqual(a, b) {
  const stack = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    if (Object.is(x, y)) continue;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(y, key)) return false;
      stack.push([x[key], y[key]]);
    }
  }
  return true;
}

function preview(value, limit = 320) {
  let text;
  try {
    text =
      JSON.stringify(value, (_key, v) => {
        if (typeof v === 'number' && !Number.isFinite(v)) return `<${String(v)}>`;
        if (typeof v === 'bigint') return `<${String(v)}n>`;
        if (typeof v === 'function') return '<function>';
        if (typeof v === 'symbol') return '<symbol>';
        if (typeof v === 'string' && v.length > 64) return `<string len=${v.length}>`;
        return v;
      }) ?? String(value);
  } catch (err) {
    text = `<unserialisable: ${err.message}>`;
  }
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} chars)` : text;
}

// --- corpus (mirrors progress.fuzz.test.ts) ---------------------------------

const HUGE_STRING = 'x'.repeat(50000);
const SURROGATE = '\ud83d';

const ATOMS = [
  undefined, null, true, false, 0, -0, 1, -1, 0.5, -0.5, 3.7,
  NaN, Infinity, -Infinity,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, Number.MIN_SAFE_INTEGER,
  Number.MAX_VALUE, Number.MIN_VALUE, -1e308, 1e21, 2 ** 53, -(2 ** 31),
  '', ' ', '   \t\n ', '0', '-1', '1e5', 'NaN', 'Infinity', 'null', 'undefined', 'true',
  'cindik', 'CINDIK', 'not-a-creature', 'first-win', 'invented-badge',
  'en', 'zh', 'ZH', 'klingon', 'add1', '__proto__', 'constructor',
  ' ', '‮​﻿', SURROGATE, '训练师', '🙂🙃'.repeat(32),
  HUGE_STRING,
  '2026-08-11T12:00:00.000Z', '2026-08-11', '9999-99-99', 'banana', ' 2026-08-11 ',
  [], {}, [1, 2, 3], ['cindik', 'cindik'], [[[[[]]]]],
  { a: 1 }, { correct: true }, { attempts: 1, correct: 1, totalMs: 1 },
  new Date(0), () => 0, Symbol('nope'), 10n,
];

const PROFILE_KEYS = [
  'version', 'trainerName', 'starterId', 'xp', 'caught', 'badges', 'battlesWon',
  'battlesLost', 'problemsCorrect', 'problemsTotal', 'bestCombo', 'tier',
  'recentAttempts', 'skillStats', 'streak', 'settings', 'createdAt', 'updatedAt',
];

const JUNK_KEYS = [
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf',
  'hasOwnProperty', 'level', '0', '', ' ', 'partner',
];

/** Assigns even `__proto__` as an own property, the way JSON.parse does. */
function put(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hostileValue(rng, depth = 0) {
  const roll = rng.next();
  if (depth < 3 && roll < 0.1) {
    const out = [];
    const n = rng.int(0, 4);
    for (let i = 0; i < n; i++) out.push(hostileValue(rng, depth + 1));
    return out;
  }
  if (depth < 3 && roll < 0.2) {
    const out = {};
    const n = rng.int(0, 3);
    for (let i = 0; i < n; i++) {
      const key = rng.next() < 0.5 ? rng.pick(JUNK_KEYS) : rng.pick(PROFILE_KEYS);
      put(out, key, hostileValue(rng, depth + 1));
    }
    return out;
  }
  return ATOMS[rng.int(0, ATOMS.length - 1)];
}

function hostileProfile(rng) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    if (rng.next() < 0.75) put(out, key, hostileValue(rng));
  }
  const junk = rng.int(0, 3);
  for (let i = 0; i < junk; i++) put(out, rng.pick(JUNK_KEYS), hostileValue(rng));
  return out;
}

function validProfile() {
  return {
    version: PROFILE_VERSION,
    trainerName: 'Ada',
    starterId: 'cindik',
    xp: 340,
    caught: ['cindik', 'bublet'],
    badges: ['first-win', 'combo-5'],
    battlesWon: 6,
    battlesLost: 2,
    problemsCorrect: 41,
    problemsTotal: 50,
    bestCombo: 7,
    tier: 4,
    recentAttempts: [
      { skill: 'add1', tier: 4, correct: true, elapsedMs: 1500 },
      { skill: 'sub2', tier: 4, correct: false, elapsedMs: 9000 },
    ],
    skillStats: { add1: { attempts: 20, correct: 18, totalMs: 30000 } },
    streak: { current: 3, best: 5, lastPlayed: '2026-08-11' },
    settings: { language: 'zh', sound: false },
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-11T12:00:00.000Z',
  };
}

function corrupt(path, value) {
  const clone = JSON.parse(JSON.stringify(validProfile()));
  const parts = path.split('.');
  let node = clone;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null) return clone;
    node = next;
  }
  put(node, parts[parts.length - 1], value);
  return clone;
}

function deepNest(depth) {
  let node = { end: true };
  for (let i = 0; i < depth; i++) node = { a: node };
  return node;
}

function literalCases() {
  const cases = [
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'number', value: 42 },
    { label: 'string', value: 'nope' },
    { label: 'boolean', value: true },
    { label: 'bigint', value: 1n },
    { label: 'symbol', value: Symbol('x') },
    { label: 'function', value: () => 0 },
    { label: 'empty object', value: {} },
    { label: 'array root', value: [] },
    { label: 'array of profiles', value: [validProfile(), validProfile()] },
    { label: 'valid profile', value: validProfile() },
    { label: 'valid profile via JSON', value: JSON.parse(JSON.stringify(validProfile())) },
    { label: 'null-prototype object', value: Object.assign(Object.create(null), { xp: 5 }) },
    { label: 'inherited fields only', value: Object.create({ xp: -5, starterId: 'zaplet' }) },
    { label: 'Date root', value: new Date(0) },
    { label: 'Map root', value: new Map([['xp', 1]]) },
    { label: 'Set root', value: new Set(['cindik']) },
    { label: 'boxed String root', value: new String('x') },
    { label: 'proto pollution root', value: JSON.parse('{"__proto__":{"pwned":true}}') },
    {
      label: 'proto pollution in skillStats',
      value: JSON.parse('{"skillStats":{"__proto__":{"pwned":true},"add1":{"attempts":1}}}'),
    },
    {
      label: 'proto pollution in settings',
      value: JSON.parse('{"settings":{"__proto__":{"pwned":true},"language":"zh"}}'),
    },
    {
      label: 'constructor.prototype pollution',
      value: JSON.parse('{"constructor":{"prototype":{"pwned":true}},"xp":1}'),
    },
    {
      label: 'proto pollution in a recentAttempt',
      value: JSON.parse('{"recentAttempts":[{"correct":true,"__proto__":{"pwned":true}}]}'),
    },
    { label: 'deeply nested skillStats', value: { skillStats: deepNest(10000) } },
    { label: 'deeply nested root', value: deepNest(10000) },
    { label: 'deeply nested caught entry', value: { caught: [deepNest(2000)] } },
    { label: 'huge trainerName', value: { trainerName: HUGE_STRING } },
    { label: 'huge starterId', value: { starterId: HUGE_STRING } },
    { label: 'huge createdAt', value: { createdAt: HUGE_STRING, updatedAt: HUGE_STRING } },
    { label: 'huge lastPlayed', value: { streak: { lastPlayed: HUGE_STRING } } },
    { label: 'huge caught array', value: { caught: new Array(50000).fill('cindik') } },
    { label: 'huge badges array', value: { badges: new Array(50000).fill('first-win') } },
    {
      label: 'huge recentAttempts array',
      value: { recentAttempts: new Array(20000).fill({ correct: true }) },
    },
    { label: 'huge skillStats object', value: { skillStats: { add1: { attempts: HUGE_STRING } } } },
    { label: 'NaN everywhere', value: { xp: NaN, tier: NaN, bestCombo: NaN } },
    { label: 'Infinity everywhere', value: { xp: Infinity, tier: Infinity, battlesWon: Infinity } },
    { label: 'negative zero', value: JSON.parse('{"xp":-0,"tier":-0,"bestCombo":-0}') },
    { label: 'negative everything', value: { xp: -1, tier: -50, battlesWon: -1, bestCombo: -1 } },
    { label: 'numeric strings', value: { xp: '100', tier: '5', battlesWon: '3' } },
    { label: 'tier above max', value: { tier: MAX_TIER + 1000 } },
    { label: 'tier below min', value: { tier: MIN_TIER - 1000 } },
    { label: 'tier fractional', value: { tier: 4.6 } },
    { label: 'arrays where objects belong', value: { streak: [], settings: [], skillStats: [] } },
    {
      label: 'objects where arrays belong',
      value: { caught: { 0: 'cindik' }, badges: { 0: 'first-win' }, recentAttempts: {} },
    },
    { label: 'stage-2 starter', value: { starterId: 'cindash' } },
    { label: 'stage-3 starter', value: { starterId: 'cinderon' } },
    {
      label: 'skillStats with junk values',
      value: {
        skillStats: {
          add1: null,
          sub1: 'lots',
          doubles: { attempts: NaN, correct: -1, totalMs: Infinity },
          nonsense: { attempts: 1, correct: 1, totalMs: 1 },
        },
      },
    },
    {
      label: 'recentAttempts with junk entries',
      value: {
        recentAttempts: [
          { correct: true, skill: 'no-such-skill', tier: 'x', elapsedMs: NaN },
          { correct: false },
          { correct: 'yes' },
          null,
          [],
          { correct: true, skill: 'add1', tier: -Infinity, elapsedMs: -5 },
        ],
      },
    },
    { label: 'settings wrongly typed', value: { settings: { language: 0, sound: 'yes' } } },
    { label: 'streak wrongly typed', value: { streak: { current: '3', best: null, lastPlayed: 12 } } },
    {
      label: 'every field an array',
      value: Object.fromEntries(PROFILE_KEYS.map((k) => [k, [k]])),
    },
    {
      label: 'every field an object',
      value: Object.fromEntries(PROFILE_KEYS.map((k) => [k, { [k]: 1 }])),
    },
    { label: 'every field null', value: Object.fromEntries(PROFILE_KEYS.map((k) => [k, null])) },
    {
      label: 'every field undefined',
      value: Object.fromEntries(PROFILE_KEYS.map((k) => [k, undefined])),
    },
    { label: 'sparse-ish caught', value: { caught: [undefined, null, 'cindik', 7, {}, []] } },
    { label: 'creature ids in badges', value: { badges: CREATURES.map((c) => c.id) } },
    { label: 'badge ids in caught', value: { caught: BADGES.map((b) => b.id) } },
  ];

  const paths = [
    ...PROFILE_KEYS,
    'streak.current', 'streak.best', 'streak.lastPlayed',
    'settings.language', 'settings.sound',
    'skillStats.add1', 'skillStats.__proto__',
    'recentAttempts.0', 'caught.0', 'badges.0',
  ];
  for (const path of paths) {
    for (let i = 0; i < ATOMS.length; i++) {
      cases.push({ label: `valid profile with ${path} = ATOMS[${i}]`, value: corrupt(path, ATOMS[i]) });
    }
  }
  return cases;
}

function fullCorpus() {
  const rng = createRng(config.seed);
  const cases = literalCases();
  for (let i = 0; i < config.randomCases; i++) {
    const roll = rng.next();
    if (roll < 0.75) cases.push({ label: `random hostile profile #${i}`, value: hostileProfile(rng) });
    else if (roll < 0.9) cases.push({ label: `random hostile value #${i}`, value: hostileValue(rng) });
    else {
      const path = PROFILE_KEYS[rng.int(0, PROFILE_KEYS.length - 1)];
      cases.push({
        label: `random single-field corruption #${i} (${path})`,
        value: corrupt(path, hostileValue(rng)),
      });
    }
  }
  return cases;
}

// --- invariants (mirrors checkProfile in progress.fuzz.test.ts) -------------

const CREATURE_IDS = new Set(CREATURES.map((c) => c.id));
const BADGE_IDS = new Set(BADGES.map((b) => b.id));
const SKILL_IDS = new Set(SKILLS);
const COUNTERS = [
  'xp', 'battlesWon', 'battlesLost', 'problemsCorrect', 'problemsTotal', 'bestCombo',
];

function checkProfile(p) {
  const bad = [];
  const say = (m) => bad.push(m);

  if (Object.getPrototypeOf(p) !== Object.prototype) say('result does not have a plain prototype');
  if (Object.prototype.hasOwnProperty.call(p, '__proto__')) say('result has an own __proto__ key');
  if (p.version !== PROFILE_VERSION) say(`version is ${String(p.version)}`);
  if (typeof p.trainerName !== 'string') say(`trainerName is ${typeof p.trainerName}`);
  else if (p.trainerName.length > MAX_TRAINER_NAME) {
    say(`trainerName is ${p.trainerName.length} chars (max ${MAX_TRAINER_NAME})`);
  }

  if (typeof p.starterId !== 'string' || !CREATURE_IDS.has(p.starterId)) {
    say(`starterId ${preview(p.starterId)} is not a creature`);
  } else if (CREATURES.find((c) => c.id === p.starterId).stage !== 1) {
    say(`starterId ${preview(p.starterId)} is not a stage-1 creature`);
  }

  for (const key of COUNTERS) {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) say(`${key} is ${preview(v)}`);
    if (Object.is(v, -0)) say(`${key} is -0, which does not survive JSON.stringify`);
  }

  if (!Number.isInteger(p.tier) || p.tier < MIN_TIER || p.tier > MAX_TIER) {
    say(`tier ${preview(p.tier)} is outside [${MIN_TIER}, ${MAX_TIER}] or not an integer`);
  }

  if (!Array.isArray(p.caught)) say('caught is not an array');
  else {
    for (const id of p.caught) {
      if (typeof id !== 'string' || !CREATURE_IDS.has(id)) say(`caught contains ${preview(id)}`);
    }
    if (!p.caught.includes(p.starterId)) say('caught does not contain the starter');
    if (new Set(p.caught).size !== p.caught.length) say('caught contains duplicates');
  }

  if (!Array.isArray(p.badges)) say('badges is not an array');
  else {
    for (const id of p.badges) {
      if (typeof id !== 'string' || !BADGE_IDS.has(id)) say(`badges contains ${preview(id)}`);
    }
    if (new Set(p.badges).size !== p.badges.length) say('badges contains duplicates');
  }

  if (!Array.isArray(p.recentAttempts)) say('recentAttempts is not an array');
  else {
    if (p.recentAttempts.length > ADAPT_WINDOW) {
      say(`recentAttempts holds ${p.recentAttempts.length} entries (max ${ADAPT_WINDOW})`);
    }
    for (const a of p.recentAttempts) {
      if (typeof a !== 'object' || a === null || Array.isArray(a)) {
        say(`recentAttempts contains ${preview(a)}`);
        continue;
      }
      if (typeof a.correct !== 'boolean') say(`attempt.correct is ${preview(a.correct)}`);
      if (!SKILL_IDS.has(a.skill)) say(`attempt.skill is ${preview(a.skill)}`);
      if (typeof a.tier !== 'number' || !Number.isFinite(a.tier)) say(`attempt.tier is ${preview(a.tier)}`);
      if (typeof a.elapsedMs !== 'number' || !Number.isFinite(a.elapsedMs) || a.elapsedMs < 0) {
        say(`attempt.elapsedMs is ${preview(a.elapsedMs)}`);
      }
    }
  }

  if (typeof p.skillStats !== 'object' || p.skillStats === null || Array.isArray(p.skillStats)) {
    say(`skillStats is ${preview(p.skillStats)}`);
  } else {
    for (const [key, stat] of Object.entries(p.skillStats)) {
      if (!SKILL_IDS.has(key)) {
        say(`skillStats has unknown key ${preview(key)}`);
        continue;
      }
      if (typeof stat !== 'object' || stat === null || Array.isArray(stat)) {
        say(`skillStats.${key} is ${preview(stat)}`);
        continue;
      }
      for (const field of ['attempts', 'correct', 'totalMs']) {
        const v = stat[field];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          say(`skillStats.${key}.${field} is ${preview(v)}`);
        }
      }
    }
  }

  if (typeof p.streak !== 'object' || p.streak === null) say('streak is not an object');
  else {
    for (const key of ['current', 'best']) {
      const v = p.streak[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) say(`streak.${key} is ${preview(v)}`);
    }
    const last = p.streak.lastPlayed;
    if (last !== null && typeof last !== 'string') say(`streak.lastPlayed is ${preview(last)}`);
    else if (typeof last === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(last)) {
      say(`streak.lastPlayed ${preview(last)} is not a YYYY-MM-DD date`);
    }
  }

  if (typeof p.settings !== 'object' || p.settings === null) say('settings is not an object');
  else {
    if (p.settings.language !== 'en' && p.settings.language !== 'zh') {
      say(`settings.language is ${preview(p.settings.language)}`);
    }
    if (typeof p.settings.sound !== 'boolean') say(`settings.sound is ${preview(p.settings.sound)}`);
  }

  for (const key of ['createdAt', 'updatedAt']) {
    const v = p[key];
    if (typeof v !== 'string') say(`${key} is ${preview(v)}`);
    else if (!Number.isFinite(Date.parse(v))) say(`${key} ${preview(v)} is not a parseable date`);
  }

  return bad;
}

// --- run --------------------------------------------------------------------

const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
const corpus = fullCorpus();

let rejected = 0;
let repaired = 0;
const failures = [];
const kinds = {};

for (const c of corpus) {
  let bad = [];
  let first = null;
  try {
    first = normaliseProfile(c.value);
  } catch (err) {
    bad.push(`threw ${err.name}: ${err.message}`);
  }

  if (bad.length === 0 && first === null) {
    rejected += 1;
  } else if (bad.length === 0) {
    repaired += 1;
    bad = checkProfile(first);

    let second = null;
    try {
      second = normaliseProfile(first);
      if (second === null) bad.push('normalising its own output returned null');
      else if (!deepEqual(second, first)) {
        bad.push('not idempotent: normaliseProfile(normaliseProfile(x)) differs from normaliseProfile(x)');
      }
    } catch (err) {
      bad.push(`normalising its own output threw ${err.name}: ${err.message}`);
    }

    try {
      if (!deepEqual(JSON.parse(JSON.stringify(first)), first)) {
        bad.push('does not survive a JSON round-trip unchanged');
      }
    } catch (err) {
      bad.push(`cannot be JSON-serialised: ${err.name}: ${err.message}`);
    }
  }

  if (bad.length > 0) {
    for (const line of bad) {
      // Bucket by the shape of the message, not its values.
      const kind = line.replace(/".*?"/g, '"..."').replace(/-?\d+(\.\d+)?/g, 'N');
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    failures.push({ label: c.label, input: preview(c.value), violations: bad.slice(0, 6) });
  }
}

const protoAfter = Object.getOwnPropertyNames(Object.prototype).sort().join(',');

process.stdout.write(
  JSON.stringify({
    tried: corpus.length,
    literals: literalCases().length,
    random: config.randomCases,
    rejected,
    repaired,
    failures,
    kinds,
    prototypePolluted: protoBefore !== protoAfter || ({}).pwned !== undefined,
  }),
);
"""


def die(message: str, code: int = 2) -> None:
    print(f"fuzz_profile: {message}", file=sys.stderr)
    raise SystemExit(code)


def run_engine() -> dict:
    """Bundle the pure engine with esbuild and execute the fuzz harness under node."""
    if not ESBUILD.exists():
        die(f"esbuild not found at {ESBUILD}. Run `npm install` first.")

    workdir = Path(tempfile.mkdtemp(prefix="mathmon-fuzz-"))
    try:
        entry = workdir / "harness.mjs"
        entry.write_text(HARNESS, encoding="utf-8")
        bundle = workdir / "bundle.mjs"

        build = subprocess.run(
            [
                str(ESBUILD),
                str(entry),
                "--bundle",
                "--platform=node",
                "--format=esm",
                "--target=node20",
                "--log-level=warning",
                f"--alias:@engine={REPO_ROOT / 'src' / 'lib' / 'game'}",
                f"--outfile={bundle}",
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            die(f"esbuild failed (exit {build.returncode}):\n{build.stderr.strip()}")

        payload = json.dumps({"seed": SEED, "randomCases": RANDOM_CASES}, sort_keys=True)
        run = subprocess.run(
            ["node", str(bundle), payload],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        if run.returncode != 0:
            die(f"fuzz harness failed (exit {run.returncode}):\n{run.stderr.strip()}")

        try:
            return json.loads(run.stdout)
        except json.JSONDecodeError as exc:
            die(f"harness produced non-JSON output: {exc}")
            raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main() -> int:
    data = run_engine()

    print("normaliseProfile fuzz report")
    print("============================")
    print(f'seed: "{SEED}"   (fixed; two runs try byte-identical inputs)')
    print(f"inputs tried:        {data['tried']}")
    print(f"  hand-written:      {data['literals']}")
    print(f"  seeded random:     {data['random']}")
    print(f"rejected as null:    {data['rejected']}")
    print(f"repaired:            {data['repaired']}")
    print(f"invariant violations:{len(data['failures']):>4}")
    print()
    print("Checked on every repaired profile: real creature and badge ids, starter present")
    print("and stage-1, finite non-negative counters, tier in range, language en/zh, dates")
    print("parseable, attempts and skill stats well formed, idempotent under a second pass,")
    print("and unchanged by a JSON round-trip (localStorage and Postgres jsonb both do one).")

    if data["prototypePolluted"]:
        print()
        print("FAIL: Object.prototype was modified while normalising the corpus.")
        return 1

    if not data["failures"]:
        print()
        print("OK: every input was rejected or repaired into a valid, stable profile.")
        return 0

    print()
    print("FAIL")
    for failure in data["failures"][:MAX_SHOWN]:
        print(f"  [{failure['label']}]")
        print(f"    input: {failure['input']}")
        for violation in failure["violations"]:
            print(f"    - {violation}")
    if len(data["failures"]) > MAX_SHOWN:
        print(f"  ... and {len(data['failures']) - MAX_SHOWN} more failing inputs")
    print()
    print("  violation kinds (message shape -> count):")
    for kind, count in sorted(data["kinds"].items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"    {count:>6}  {kind}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
