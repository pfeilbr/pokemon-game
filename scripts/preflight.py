#!/usr/bin/env python3
"""Reproduce the root CI job locally, in one command, without the mobile deps.

Why this exists
---------------
`CLAUDE.md` records the one recurring, expensive failure in this repository:

    "The root CI job does not install `mobile/node_modules`. Anything at the
     root that reaches into `mobile/` therefore passes on a developer machine,
     where those packages happen to be present, and fails only in CI."

It has bitten twice - the root `tsconfig` quietly type-checking 23 React Native
files (sixteen red runs), and `audit_docs.py` bundling `mobile/src/storage.ts`
for a string literal. The documented remedy is a shell recipe a human has to
remember: park `mobile/node_modules` outside the tree, run the suite, move it
back. A procedure that depends on being remembered is not a guard, and the
"move it back" half is the dangerous half - a Ctrl-C in the middle leaves a
developer's mobile dependencies sitting in /tmp.

So this script owns both halves. It parks the directory, runs what CI runs, and
restores it on *every* exit path: normal, failed check, exception, SIGINT,
SIGTERM, SIGHUP. It also drops a breadcrumb outside the repository, so a run
that is SIGKILLed (which no process can trap) is detected and repaired by the
next run - or by `--restore` on its own.

Two things it refuses to do
---------------------------
1. **Hardcode the checks.** The list of steps is read out of
   `.github/workflows/ci.yml` on every run. A list copied into this file would
   drift out of date silently, which is the same class of bug this script
   exists to prevent. An unrecognised `run:` step is executed, not ignored -
   drift fails safe.

2. **Skip quietly.** Some CI steps genuinely cannot run on a laptop: GitHub
   Actions, a Postgres service container, a `sudo apt-get` browser install.
   Each one is printed as SKIP with the reason, and every capability that was
   *not* exercised is repeated in a "NOT EXERCISED LOCALLY" block at the end. A
   green preflight that quietly omitted a check is precisely the false
   confidence this repository keeps paying for.

Determinism
-----------
Standard library only. No network of its own, no randomness. The plan, the
per-step verdicts and the summary are emitted in workflow order - which is a
property of `ci.yml`, not of this run - and every set-derived list (environment
adaptations, skip reasons) is sorted. Durations are the one varying value: they
appear in a separate right-hand column and `--no-timings` removes them, which
makes the whole report byte-identical across runs.

The one thing that cannot be deterministic is the *forwarded output of a failing
tool*: a vitest or tsc diagnostic is theirs, not ours. Those are written to log
files and echoed on failure, and they are clearly fenced as foreign output.

Usage
-----
    python3 scripts/preflight.py               # the real thing
    python3 scripts/preflight.py --plan        # what would run, and why not
    python3 scripts/preflight.py --restore     # repair a killed earlier run
    python3 scripts/preflight.py --no-timings  # byte-identical output
    python3 scripts/preflight.py --with-install    # also run `npm ci`
    python3 scripts/preflight.py --only typecheck  # iterate (NOT a preflight)

Exit codes:  0 = everything CI would run locally passed
             1 = a check failed
             2 = the harness itself could not run (or could not restore)
"""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOW = os.path.join(".github", "workflows", "ci.yml")
JOB_ID = "verify"
MOBILE_MODULES = os.path.join(REPO_ROOT, "mobile", "node_modules")

# Deterministic per-checkout breadcrumb path, so a SIGKILLed run is found again.
_REPO_KEY = hashlib.sha1(os.path.realpath(REPO_ROOT).encode()).hexdigest()[:12]
BREADCRUMB = os.path.join(tempfile.gettempdir(), f"mathmon-preflight-{_REPO_KEY}.json")


# ==========================================================================
# A very small YAML reader
#
# Enough of the language for a GitHub workflow: nested maps, sequences, quoted
# and plain scalars, block scalars, and one-line flow sequences. Deliberately
# not a general parser - it raises rather than guessing, and the caller turns a
# raise into exit code 2. `ci.yml` is read, never written.
# ==========================================================================


class YamlError(Exception):
    """The workflow could not be understood. Always fatal, never ignored."""


def _strip_comment(line: str) -> str:
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def _split_key(content: str) -> tuple[str, str] | None:
    """Split `key: value` on the first colon that is followed by space or EOL."""
    quote = None
    for i, ch in enumerate(content):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == ":" and (i + 1 == len(content) or content[i + 1] == " "):
            return content[:i].strip().strip("\"'"), content[i + 1 :].strip()
    return None


def _scalar(text: str) -> Any:
    if text == "":
        return ""
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        return [] if not inner else [_scalar(p.strip()) for p in inner.split(",")]
    return text


_BLOCK_RE = re.compile(r"^(?P<key>.*?):[ \t]*(?P<ind>[|>])(?P<chomp>[+-]?)$")


def _tokenize(text: str) -> list[dict[str, Any]]:
    raw = text.replace("\r\n", "\n").split("\n")
    toks: list[dict[str, Any]] = []
    i = 0
    while i < len(raw):
        line = raw[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        stripped = _strip_comment(line).rstrip()
        if not stripped.strip():
            i += 1
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        if "\t" in stripped[:indent]:
            raise YamlError(f"{WORKFLOW}:{i + 1}: tab in indentation")
        content = stripped.strip()

        block = _BLOCK_RE.match(content)
        if block:
            body: list[str] = []
            j = i + 1
            body_indent = None
            while j < len(raw):
                nxt = raw[j]
                if not nxt.strip():
                    body.append("")
                    j += 1
                    continue
                nxt_indent = len(nxt) - len(nxt.lstrip(" "))
                if nxt_indent <= indent:
                    break
                if body_indent is None:
                    body_indent = nxt_indent
                body.append(nxt[body_indent:])
                j += 1
            while body and body[-1] == "":
                body.pop()
            if block.group("ind") == ">":
                folded, run = [], []
                for entry in body:
                    if entry == "":
                        folded.append(" ".join(run))
                        run = []
                    else:
                        run.append(entry.strip())
                folded.append(" ".join(run))
                value = "\n".join(folded)
            else:
                value = "\n".join(body)
            if block.group("chomp") != "-":
                value += "\n"
            toks.append(
                {
                    "indent": indent,
                    "content": block.group("key").strip() + ":",
                    "value": value,
                    "line": i + 1,
                }
            )
            i = j
            continue

        toks.append({"indent": indent, "content": content, "value": None, "line": i + 1})
        i += 1
    return toks


def _parse_node(toks: list[dict[str, Any]], idx: int, indent: int) -> tuple[Any, int]:
    if toks[idx]["content"] == "-" or toks[idx]["content"].startswith("- "):
        return _parse_seq(toks, idx, indent)
    return _parse_map(toks, idx, indent)


def _child_index(toks: list[dict[str, Any]], idx: int, indent: int) -> int | None:
    if idx < len(toks) and toks[idx]["indent"] > indent:
        return toks[idx]["indent"]
    return None


def _parse_map(toks: list[dict[str, Any]], idx: int, indent: int) -> tuple[Any, int]:
    out: dict[str, Any] = {}
    while idx < len(toks) and toks[idx]["indent"] == indent:
        tok = toks[idx]
        if tok["content"].startswith("- ") or tok["content"] == "-":
            break
        if tok["value"] is not None:  # pre-resolved block scalar
            key = tok["content"][:-1].strip()
            out[key] = tok["value"]
            idx += 1
            continue
        split = _split_key(tok["content"])
        if split is None:
            raise YamlError(f"{WORKFLOW}:{tok['line']}: expected `key: value`, got {tok['content']!r}")
        key, rest = split
        if rest:
            out[key] = _scalar(rest)
            idx += 1
            continue
        idx += 1
        child = _child_index(toks, idx, indent)
        if child is None:
            out[key] = None
            continue
        out[key], idx = _parse_node(toks, idx, child)
    return out, idx


def _parse_seq(toks: list[dict[str, Any]], idx: int, indent: int) -> tuple[Any, int]:
    out: list[Any] = []
    while idx < len(toks) and toks[idx]["indent"] == indent:
        tok = toks[idx]
        content = tok["content"]
        if not (content == "-" or content.startswith("- ")):
            break
        if content == "-":
            idx += 1
            child = _child_index(toks, idx, indent)
            if child is None:
                out.append(None)
                continue
            item, idx = _parse_node(toks, idx, child)
            out.append(item)
            continue
        offset = 1
        while offset < len(content) and content[offset] == " ":
            offset += 1
        rest = content[offset:]
        # `- 5432:5432` is a scalar, not a mapping: a colon only opens a key
        # when a space or the end of the line follows it.
        if tok["value"] is None and not rest.startswith("- ") and _split_key(rest) is None:
            out.append(_scalar(rest))
            idx += 1
            continue
        toks[idx] = {
            "indent": indent + offset,
            "content": content[offset:],
            "value": tok["value"],
            "line": tok["line"],
        }
        item, idx = _parse_node(toks, idx, indent + offset)
        out.append(item)
    return out, idx


def parse_yaml(text: str) -> Any:
    toks = _tokenize(text)
    if not toks:
        raise YamlError(f"{WORKFLOW}: empty")
    value, idx = _parse_node(toks, 0, toks[0]["indent"])
    if idx != len(toks):
        raise YamlError(f"{WORKFLOW}:{toks[idx]['line']}: unparsed trailing content")
    return value


# ==========================================================================
# Which CI steps can honestly be reproduced here, and which cannot
#
# Every rule below states its reason in the words the report prints. Adding a
# rule means admitting, in the output, that a check is not being run.
# ==========================================================================

SHELL_OPERATORS = re.compile(r"[|;<>`]|\$\(")

# Matched against the step's command. Order is significant only for reporting.
COMMAND_SKIPS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"^npm ci\b"),
        "reinstalls the root node_modules from the registry - destructive to a "
        "working tree and needs the network. Pass --with-install to include it.",
    ),
    (
        re.compile(r"\bplaywright install\b"),
        "downloads browsers and installs system packages with sudo. Provision "
        "them once yourself; PLAYWRIGHT_CHROMIUM_PATH points at a local build.",
    ),
]

PLAYWRIGHT_COMMAND = re.compile(r"\bplaywright\b|\btest:e2e\b")
DB_ENV_VAR = "TEST_DATABASE_URL"


@dataclass
class Step:
    """One step of the CI job, and what this harness decided to do with it."""

    index: int
    name: str
    commands: list[str]
    env: dict[str, str]
    uses: str | None
    condition: str | None

    decision: str = "RUN"  # RUN | SKIP
    reason: str = ""
    notes: list[str] = field(default_factory=list)
    status: str = "PENDING"  # PASS | FAIL | SKIP | PENDING
    seconds: float = 0.0
    log_path: str | None = None

    @property
    def display(self) -> str:
        if self.commands:
            return " && ".join(self.commands)
        if self.uses:
            return f"uses: {self.uses}"
        return "(no command)"


def load_steps(path: str) -> list[Step]:
    with open(path, "r", encoding="utf-8") as handle:
        doc = parse_yaml(handle.read())
    if not isinstance(doc, dict) or "jobs" not in doc:
        raise YamlError(f"{WORKFLOW}: no `jobs:` mapping")
    jobs = doc["jobs"]
    if not isinstance(jobs, dict) or JOB_ID not in jobs:
        raise YamlError(f"{WORKFLOW}: no `{JOB_ID}` job")
    job = jobs[JOB_ID]
    raw_steps = job.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise YamlError(f"{WORKFLOW}: job `{JOB_ID}` has no steps")

    job_env = {str(k): "" if v is None else str(v) for k, v in (job.get("env") or {}).items()}

    steps: list[Step] = []
    for i, raw in enumerate(raw_steps, 1):
        if not isinstance(raw, dict):
            raise YamlError(f"{WORKFLOW}: step {i} is not a mapping")
        run = raw.get("run")
        step_env = {str(k): "" if v is None else str(v) for k, v in (raw.get("env") or {}).items()}
        commands: list[str] = []
        if isinstance(run, str):
            commands = [line.strip() for line in run.strip().split("\n") if line.strip()]
        steps.append(
            Step(
                index=i,
                name=str(raw.get("name") or raw.get("uses") or (commands[0] if commands else f"step {i}")),
                commands=commands,
                env={**job_env, **step_env},
                uses=str(raw["uses"]) if raw.get("uses") else None,
                condition=str(raw["if"]) if raw.get("if") else None,
            )
        )
    return steps


def database_reachable(url: str) -> bool:
    """A TCP connect, not a query - stdlib only, and enough to tell 'no DB'."""
    match = re.match(r"^[a-z+]+://(?:[^@/]*@)?([^:/?]+)(?::(\d+))?", url)
    if not match:
        return False
    host = match.group(1)
    port = int(match.group(2) or 5432)
    try:
        with socket.create_connection((host, port), timeout=2.0):
            return True
    except OSError:
        return False


def classify(steps: list[Step], opts: argparse.Namespace, db_url: str | None) -> list[str]:
    """Decide RUN/SKIP per step. Returns the sorted 'not exercised' notes."""
    gaps: set[str] = set()
    degraded: list[str] = []

    # A step whose command is duplicated by another step that explicitly clears
    # TEST_DATABASE_URL exists *only* to re-run it against the service
    # container. Without a database that is not a degraded run, it is no run.
    command_counts: dict[str, int] = {}
    for step in steps:
        if step.commands:
            command_counts[step.display] = command_counts.get(step.display, 0) + 1

    for step in steps:
        wants_db = bool(step.env.get(DB_ENV_VAR))

        if step.uses:
            step.decision = "SKIP"
            step.reason = "GitHub Action - runs on the runner, has no local equivalent"
            continue
        if not step.commands:
            step.decision = "SKIP"
            step.reason = "no `run:` command"
            continue
        if step.condition:
            step.decision = "SKIP"
            step.reason = f"conditional on `{step.condition}`"
            continue

        skipped = False
        for pattern, reason in COMMAND_SKIPS:
            if any(pattern.search(cmd) for cmd in step.commands):
                if pattern.pattern.startswith("^npm ci") and opts.with_install:
                    break
                step.decision = "SKIP"
                step.reason = reason
                gaps.add(f"{step.name}: {reason.split('.')[0]}.")
                skipped = True
                break
        if skipped:
            continue

        bad = [cmd for cmd in step.commands if SHELL_OPERATORS.search(cmd)]
        if bad:
            step.decision = "SKIP"
            step.reason = (
                "contains shell operators; this harness runs explicit argv only, "
                "because a pipeline reports the exit status of its last command"
            )
            gaps.add(f"{step.name}: not run - {step.reason}.")
            continue

        if wants_db and not db_url:
            if command_counts.get(step.display, 0) > 1:
                step.decision = "SKIP"
                step.reason = (
                    f"needs the Postgres service container ({DB_ENV_VAR}); the same "
                    "command already ran above against the zero-config deployment"
                )
                gaps.add(
                    f"{step.name}: the signed-in browser tests (cross-device sync) "
                    "need a database. Export TEST_DATABASE_URL to include them."
                )
                continue
            # Not a per-step note: the job-level env hands TEST_DATABASE_URL to
            # *every* step, so guessing which ones actually open a connection
            # would be a heuristic, and a wrong heuristic is how this
            # repository gets burned. The names are collected and the
            # degradation is stated once, below.
            degraded.append(step.name)

        if opts.only and not any(fragment.lower() in step.name.lower() for fragment in opts.only):
            step.decision = "SKIP"
            step.reason = "excluded by --only (this is NOT a full preflight)"
            if step.name in degraded:
                degraded.remove(step.name)

    if degraded:
        gaps.add(
            f"Postgres: CI gives every step of this job a {DB_ENV_VAR} pointing at a "
            "service container; here it is unset, so the database-backed tests (the "
            "Postgres integration tests, and the signed-in E2E specs) skip "
            "themselves. Steps that ran without it: "
            + ", ".join(sorted(degraded))
            + ". Export TEST_DATABASE_URL to close this gap."
        )

    return sorted(gaps)


# ==========================================================================
# Parking `mobile/node_modules`, and getting it back no matter what
# ==========================================================================


GUARDED_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


class deferred_signals:
    """Ignore SIGINT/SIGTERM/SIGHUP for the length of a move.

    An impatient second Ctrl-C, landing in the microseconds between "the
    directory has left the tree" and "the directory is back", is exactly the
    accident this whole script exists to make impossible.
    """

    def __enter__(self) -> "deferred_signals":
        self.previous: dict[int, Any] = {}
        for sig in GUARDED_SIGNALS:
            try:
                self.previous[sig] = signal.signal(sig, signal.SIG_IGN)
            except (ValueError, OSError):
                pass
        return self

    def __exit__(self, *_exc: Any) -> bool:
        for sig, handler in self.previous.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass
        return False


class Parking:
    """Moves mobile/node_modules out of the tree and guarantees its return.

    Outside the tree, not beside it: `audit_assets.py` rightly fails on an
    untracked, un-ignored directory appearing in the repository, so a `.bak`
    sibling would break the very check this script exists to run.
    """

    def __init__(self, source: str) -> None:
        self.source = source
        self.parked: str | None = None
        self.holder: str | None = None
        self.entries_before: int | None = None
        self.existed = os.path.lexists(source)

    # -- the location outside the repository ------------------------------
    @staticmethod
    def _holder_root() -> str:
        parent = os.path.dirname(REPO_ROOT)
        if os.path.isdir(parent) and os.access(parent, os.W_OK):
            return parent
        return tempfile.gettempdir()

    def park(self) -> None:
        if not self.existed:
            return
        self.entries_before = len(os.listdir(self.source))
        self.holder = tempfile.mkdtemp(prefix=".mathmon-preflight-", dir=self._holder_root())
        target = os.path.join(self.holder, "node_modules")
        # The breadcrumb is written *before* the move, not after: a kill in the
        # window between them must leave a note that points somewhere, and a
        # breadcrumb describing a move that never happened is harmless (recovery
        # sees the source still in place and simply clears it).
        with open(BREADCRUMB, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "pid": os.getpid(),
                    "repo": REPO_ROOT,
                    "source": self.source,
                    "parked": target,
                    "holder": self.holder,
                },
                handle,
                indent=2,
                sort_keys=True,
            )
        with deferred_signals():
            try:
                os.rename(self.source, target)
            except OSError:
                shutil.move(self.source, target)  # different filesystem
            self.parked = target

    def restore(self) -> tuple[bool, str]:
        """Idempotent. Returns (ok, human-readable state)."""
        if not self.existed:
            self._forget()
            return True, "nothing was parked (mobile/node_modules absent - the CI state)"
        if self.parked is None:
            return True, "nothing was parked"
        if not os.path.lexists(self.parked):
            if os.path.lexists(self.source):
                self.parked = None
                self._forget()
                return True, "already restored"
            return False, f"parked copy has vanished from {self.parked}"
        if os.path.lexists(self.source):
            return False, (
                f"{self.source} reappeared while parked - refusing to overwrite it. "
                f"Your original is at {self.parked}"
            )
        with deferred_signals():
            try:
                os.rename(self.parked, self.source)
            except OSError:
                shutil.move(self.parked, self.source)
            self.parked = None
        after = len(os.listdir(self.source))
        if self.entries_before is not None and after != self.entries_before:
            return False, f"restored but entry count changed: {self.entries_before} -> {after}"
        self._cleanup_holder()
        self._forget()
        return True, f"restored ({after} top-level entries, unchanged)"

    def _cleanup_holder(self) -> None:
        if self.holder and os.path.isdir(self.holder) and not os.listdir(self.holder):
            os.rmdir(self.holder)

    @staticmethod
    def _forget() -> None:
        try:
            os.remove(BREADCRUMB)
        except FileNotFoundError:
            pass


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def recover_breadcrumb(emit) -> int:
    """Repair a run that was SIGKILLed (or is still running - then refuse)."""
    if not os.path.exists(BREADCRUMB):
        emit("  no interrupted run to recover")
        return 0
    try:
        with open(BREADCRUMB, "r", encoding="utf-8") as handle:
            crumb = json.load(handle)
        pid = int(crumb["pid"])
        source = str(crumb["source"])
        parked = str(crumb["parked"])
        holder = str(crumb.get("holder") or os.path.dirname(parked))
    except (OSError, ValueError, KeyError) as exc:
        emit(f"  ! unreadable breadcrumb at {BREADCRUMB}: {exc}")
        return 2

    if pid != os.getpid() and _pid_alive(pid):
        emit(f"  ! another preflight (pid {pid}) is running; parked at {parked}")
        emit("    Wait for it, or kill it and re-run with --restore.")
        return 2

    emit(f"  recovering an interrupted run (pid {pid}, dead)")
    here = os.path.lexists(source)
    there = os.path.lexists(parked)
    if here and there:
        emit(f"  ! {source} exists AND a parked copy sits at {parked}")
        emit("    Refusing to choose between them. Delete whichever is wrong.")
        return 2
    if here and not there:
        # Killed between writing the breadcrumb and moving: nothing moved.
        emit("  the tree was already intact (killed before the move); note cleared")
        Parking._forget()
        return 0
    if not there:
        emit(f"  ! mobile/node_modules is in neither place ({source}, {parked})")
        emit("    Reinstall it with `cd mobile && npm ci`.")
        Parking._forget()
        return 2
    with deferred_signals():
        try:
            os.rename(parked, source)
        except OSError:
            shutil.move(parked, source)
    if os.path.isdir(holder) and not os.listdir(holder):
        os.rmdir(holder)
    Parking._forget()
    emit(f"  restored {source} ({len(os.listdir(source))} top-level entries)")
    return 0


# ==========================================================================
# Running the checks
# ==========================================================================


class Interrupted(Exception):
    """A signal arrived. Raised so the `finally` that restores always runs."""


def _install_signal_handlers() -> None:
    def handler(signum, _frame):
        raise Interrupted(signal.Signals(signum).name)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):  # not on the main thread / unsupported
            pass


def run_step(step: Step, base_env: dict[str, str], opts: argparse.Namespace, log_dir: str) -> None:
    env = dict(base_env)
    env.update(step.env)
    log_path = os.path.join(log_dir, f"{step.index:02d}-{re.sub(r'[^a-z0-9]+', '-', step.name.lower()).strip('-')}.log")
    step.log_path = log_path
    started = time.monotonic()
    captured: list[str] = []
    code = 0

    with open(log_path, "w", encoding="utf-8") as log:
        for command in step.commands:
            # `a && b` is the only compound form allowed: each half still runs as
            # an explicit argv with its own return code checked. Nothing is piped
            # anywhere - a pipeline reports the status of its last command, which
            # has already hidden a real failure in this repository once.
            for part in [p.strip() for p in command.split("&&") if p.strip()]:
                argv = shlex.split(part)
                log.write(f"$ {part}\n")
                log.flush()
                if opts.stream:
                    proc = subprocess.run(argv, cwd=REPO_ROOT, env=env, check=False)
                    code = proc.returncode
                else:
                    proc = subprocess.run(
                        argv,
                        cwd=REPO_ROOT,
                        env=env,
                        check=False,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        errors="replace",
                    )
                    code = proc.returncode
                    log.write(proc.stdout)
                    captured.append(proc.stdout)
                log.write(f"\n[exit {code}]\n")
                if code != 0:
                    break
            if code != 0:
                break

    step.seconds = time.monotonic() - started
    step.status = "PASS" if code == 0 else "FAIL"
    if code != 0 and not opts.stream:
        step.notes.append(f"exit {code}")
        text = "".join(captured).rstrip().split("\n")
        tail = text[-opts.log_lines :]
        print(f"    --- {step.name}: output of the failing tool (not ours; verbatim) ---")
        if len(text) > len(tail):
            print(f"    [... {len(text) - len(tail)} earlier lines in {log_path} ...]")
        for line in tail:
            print(f"    | {line}")
        print("    --- end ---")
    elif code != 0:
        step.notes.append(f"exit {code}")


# ==========================================================================
# Report
# ==========================================================================

BAR = "=" * 78


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="preflight.py",
        description="Run the root CI job locally with mobile/node_modules parked outside the tree.",
    )
    parser.add_argument("--plan", action="store_true", help="print the plan and exit without running")
    parser.add_argument("--restore", action="store_true", help="repair an interrupted earlier run, then exit")
    parser.add_argument("--with-install", action="store_true", help="also run `npm ci` (destructive, needs network)")
    parser.add_argument("--stream", action="store_true", help="forward tool output live instead of on failure")
    parser.add_argument("--no-timings", dest="timings", action="store_false", help="omit durations (byte-identical output)")
    parser.add_argument("--no-ci-env", dest="ci_env", action="store_false", help="do not set CI=true for the checks")
    parser.add_argument("--log-lines", type=int, default=60, help="lines of failing output to echo (default 60)")
    parser.add_argument("--only", action="append", default=[], metavar="TEXT", help="run only steps whose name contains TEXT")
    opts = parser.parse_args(argv)

    def emit(text: str = "") -> None:
        print(text, flush=True)

    emit(BAR)
    emit("mathmon preflight - the root CI job, reproduced locally")
    emit(BAR)
    emit(f"  repo        {REPO_ROOT}")
    emit(f"  workflow    {WORKFLOW}  (job: {JOB_ID})")

    # A killed earlier run is repaired before anything else touches the tree.
    emit("")
    emit("PARKING RECOVERY")
    recovery = recover_breadcrumb(emit)
    if recovery != 0:
        return 2
    if opts.restore:
        return 0

    # -- read the plan out of ci.yml -------------------------------------
    workflow_path = os.path.join(REPO_ROOT, WORKFLOW)
    try:
        steps = load_steps(workflow_path)
    except (YamlError, OSError) as exc:
        emit(f"  ! cannot read the workflow: {exc}")
        return 2

    db_url = os.environ.get(DB_ENV_VAR) or None
    db_state = "not configured"
    if db_url:
        db_state = "reachable" if database_reachable(db_url) else "configured but unreachable"
        if db_state != "reachable":
            db_url = None

    base_env = dict(os.environ)
    # Forwarded tool output is the one thing here that cannot be deterministic;
    # stripping colour at least makes it diffable.
    base_env["NO_COLOR"] = "1"
    adaptations: list[str] = ["NO_COLOR=1 (so a forwarded failure is diffable, not ANSI soup)"]
    if opts.ci_env:
        base_env["CI"] = "true"
        adaptations.append("CI=true (matches the runner: playwright forbids .only and retries once)")
    if db_url:
        base_env[DB_ENV_VAR] = db_url
        adaptations.append(f"{DB_ENV_VAR} inherited from your environment ({db_state})")
    else:
        base_env.pop(DB_ENV_VAR, None)
    if not os.environ.get("PLAYWRIGHT_CHROMIUM_PATH"):
        for candidate in sorted(
            {
                os.path.join(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"), "chromium"),
                "/opt/pw-browsers/chromium",
            }
        ):
            if os.path.exists(candidate) and os.access(candidate, os.X_OK):
                base_env["PLAYWRIGHT_CHROMIUM_PATH"] = candidate
                adaptations.append(
                    f"PLAYWRIGHT_CHROMIUM_PATH={candidate} (this sandbox's Chromium predates "
                    "the bundled one; CLAUDE.md documents the substitution)"
                )
                break

    gaps = classify(steps, opts, db_url)
    if any(step.decision == "RUN" and PLAYWRIGHT_COMMAND.search(step.display) for step in steps):
        if not base_env.get("PLAYWRIGHT_CHROMIUM_PATH"):
            gaps.append("E2E: no PLAYWRIGHT_CHROMIUM_PATH found; Playwright will use its own browser.")
            gaps.sort()

    adaptations.sort()
    emit(f"  database    {DB_ENV_VAR} {db_state}")
    emit("  environment " + (adaptations[0] if adaptations else "unmodified"))
    for extra in adaptations[1:]:
        emit("              " + extra)

    emit("")
    emit("PLAN  (workflow order, as written in ci.yml)")
    for step in steps:
        mark = "RUN " if step.decision == "RUN" else "SKIP"
        emit(f"  {step.index:>2}  {mark}  {step.name}")
        emit(f"          {step.display}")
        if step.decision == "SKIP":
            emit(f"          -> skipped: {step.reason}")
        for note in step.notes:
            emit(f"          -> {note}")

    runnable = [step for step in steps if step.decision == "RUN"]
    if opts.plan:
        emit("")
        emit(f"--plan: {len(runnable)} step(s) would run, {len(steps) - len(runnable)} skipped. Nothing was executed.")
        return 0
    if not runnable:
        emit("")
        emit("  ! nothing to run - every step was skipped. That is not a preflight.")
        return 2

    log_dir = tempfile.mkdtemp(prefix="mathmon-preflight-logs-")
    emit("")
    emit(f"  logs        {log_dir}  (outside the repo: an untracked file here would fail audit_assets.py)")

    parking = Parking(MOBILE_MODULES)
    emit("")
    emit("PARKING mobile/node_modules")
    if not parking.existed:
        emit("  mobile/node_modules is absent - already the CI state, nothing to park")
    exit_code = 0
    restored_ok = True
    restored_state = "not parked"
    interrupted: str | None = None

    # atexit is the last line of defence: if anything below manages to exit
    # without unwinding (os._exit aside, which nothing here calls), the
    # directory still goes back. restore() is idempotent, so the belt and the
    # braces cannot fight each other.
    atexit.register(parking.restore)
    _install_signal_handlers()

    try:
        parking.park()
        if parking.existed:
            emit(f"  moved  {MOBILE_MODULES}")
            emit(f"    ->   {parking.parked}")
            emit(f"  breadcrumb {BREADCRUMB} (so a SIGKILL is repairable)")
        emit("")
        emit("RESULTS  (a failure does not stop the run - CI would abort there, but")
        emit("          one local pass showing you every broken check is worth more)")
        for step in runnable:
            emit(f"  .. {step.name}")
            run_step(step, base_env, opts, log_dir)
            suffix = f"   [{step.seconds:6.1f}s]" if opts.timings else ""
            emit(f"  {step.status}  {step.name}{suffix}")
            if step.status == "FAIL":
                exit_code = 1
    except Interrupted as exc:
        interrupted = str(exc)
        exit_code = 2
    except Exception as exc:  # noqa: BLE001 - the point is that nothing escapes
        emit("")
        emit(f"  ! harness error: {type(exc).__name__}: {exc}")
        interrupted = f"{type(exc).__name__}"
        exit_code = 2
    finally:
        restored_ok, restored_state = parking.restore()

    emit("")
    emit("RESTORE")
    emit(f"  mobile/node_modules: {restored_state}")
    if not restored_ok:
        emit("  ! RESTORE FAILED - fix this before doing anything else.")
        exit_code = 2
    if interrupted:
        emit(f"  run was cut short by {interrupted}; the tree was put back first")

    emit("")
    emit("SUMMARY  (workflow order)")
    for step in steps:
        status = step.status if step.decision == "RUN" else "SKIP"
        if step.decision == "RUN" and status == "PENDING":
            status = "NOTRUN"
        emit(f"  {status:<6} {step.index:>2}  {step.name}")

    passed = sum(1 for s in steps if s.status == "PASS")
    failed = sum(1 for s in steps if s.status == "FAIL")
    notrun = sum(1 for s in steps if s.decision == "RUN" and s.status == "PENDING")
    skipped = sum(1 for s in steps if s.decision == "SKIP")
    emit("")
    emit(f"  {passed} passed / {failed} failed / {notrun} not reached / {skipped} skipped")

    if gaps:
        emit("")
        emit("NOT EXERCISED LOCALLY  (CI does run these - sorted)")
        for gap in gaps:
            emit(f"  - {gap}")

    if opts.only:
        emit("")
        emit("  ! FILTERED RUN (--only): this is an iteration aid, NOT a preflight.")

    emit("")
    emit(BAR)
    if exit_code == 0:
        emit("PREFLIGHT PASS - everything CI runs that can run here, ran and passed.")
    elif exit_code == 1:
        emit("PREFLIGHT FAIL - a check CI runs failed here. It would fail there too.")
    else:
        emit("PREFLIGHT ERROR - the harness could not complete. Nothing is proven.")
    emit(BAR)
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Interrupted as exc:  # a signal outside the guarded region
        print(f"\ninterrupted by {exc}", flush=True)
        sys.exit(2)
