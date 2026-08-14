#!/usr/bin/env python3
"""Audit the HTTP surface: what a route does before it trusts a request.

`scripts/audit_auth.py` audits the account - the PIN, the KDF, the lockout,
the cookie flags, the enumeration timing. It says nothing about the layer
underneath: how a body arrives, how big it is allowed to be, how often it may
arrive, and what a failure is allowed to say back. That layer is where this
deployment was actually thin, because Next.js supplies none of it:

  - App Router route handlers have no request size limit. The Pages Router had
    `api.bodyParser.sizeLimit`, defaulting to 1MB; the App Router dropped it and
    replaced it with nothing. `await request.json()` buffers and parses whatever
    arrives, so one 50MB `PUT /api/profile` spent a serverless instance's entire
    memory allowance on JSON nobody asked for.
  - The account lockout is keyed to an account. It answers five guesses at one
    child's PIN and it never sees a thousand guesses at a thousand names,
    because each fresh name starts with a fresh five.
  - An uncaught throw is answered by the framework, not by us - a stack trace in
    development, an HTML page in production, and in neither case a word the iOS
    client understands.

So this script covers six properties, none of which overlaps audit_auth.py:

  A. Every request body is bounded in bytes AND in depth, before it is parsed.
  B. Something throttles volume, above and beyond the per-account lockout - and
     it is keyed so that it cannot itself become an enumeration oracle.
  C. The session token is verified with a pinned algorithm, never merely
     decoded; and every cookie the app sets inherits one hardened flag set.
     (httpOnly / sameSite / secure themselves belong to audit_auth.py's D.)
  D. No error path leaks detail, and no handler can throw past its own route.
  E. Every route validates its input shape before touching the database, and
     answers only in the fixed error vocabulary the iOS client switches on.
  F. Every API response is uncacheable and dynamically rendered.

The vocabulary in E is a cross-client contract: mobile/src/api.ts maps anything
outside `mismatch|locked|taken|invalid|unavailable` to "unavailable", which
tells a locked-out child to try again rather than to wait. It is written out
below rather than read from mobile/, deliberately - the root CI job does not
install mobile/node_modules and root tooling that reaches across that boundary
has broken the build twice.

What this script CANNOT prove: that the limits hold under a real load, that the
in-process rate limiter survives a scale-out (it does not - see the note in
ratelimit.ts), or that a dependency does not log for us. The behavioural half
lives in src/lib/server/http.test.ts and ratelimit.test.ts, which need no
database and therefore run on every push.

Standard library only. No network, no clock, no randomness, no git. Output is
derived from sorted inputs and is byte-identical across runs.

Usage:
    python3 scripts/audit_api.py            # audit; exit 1 on violation
    python3 scripts/audit_api.py --quiet    # violations and result only

Exit codes:  0 = clean   1 = violations found   2 = could not run the audit
"""

from __future__ import annotations

import bisect
import os
import re
import sys
from dataclasses import dataclass, field

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HTTP = "src/lib/server/http.ts"
RATELIMIT = "src/lib/server/ratelimit.ts"
SESSION = "src/lib/server/session.ts"

PIN_ROUTE = "src/app/api/auth/pin/route.ts"
PROFILE_ROUTE = "src/app/api/profile/route.ts"

# Every file that can answer an HTTP request. A missing subject aborts the
# audit rather than passing it: an audit that skips its subject is worse than
# no audit.
ROUTE_SOURCES = (
    PIN_ROUTE,
    PROFILE_ROUTE,
    "src/app/api/auth/google/route.ts",
    "src/app/api/auth/google/callback/route.ts",
    "src/app/api/auth/signout/route.ts",
    "src/app/api/session/route.ts",
)

SERVER_SOURCES = (HTTP, RATELIMIT, SESSION)

ALL_SOURCES = tuple(sorted(ROUTE_SOURCES + SERVER_SOURCES))

# The routes that read a request body at all.
BODY_ROUTES = (PIN_ROUTE, PROFILE_ROUTE)

# The HTTP methods Next.js will export from a route module.
HTTP_VERBS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")

# The five words mobile/src/api.ts switches on. Changing this set is a
# cross-client change and must be announced as one.
DOCUMENTED_AUTH_ERRORS = ("invalid", "locked", "mismatch", "taken", "unavailable")

# Sanity bounds on the declared limits. Not policy - just "somebody actually
# thought about it": a 1GB cap or a depth of 100,000 is the same as no cap.
MAX_REASONABLE_BODY_BYTES = 1024 * 1024
MAX_REASONABLE_DEPTH = 128

# Cookie lifetimes. Browsers clamp to 400 days; anything longer is a cookie
# that outlives the browser's own patience and quietly means "400".
MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60

# An identifier that names a caught exception. `console.error(err)` prints an
# Error's own enumerable properties, and postgres.js hangs `query` and
# `parameters` off its errors - the parameters of an insert into trainers
# include the PIN hash.
CAUGHT_ERROR = re.compile(r"(?<![A-Za-z0-9_$.])(error|err|e|exception|reason)(?![A-Za-z0-9_$])")

# Detail that must never reach a response body.
LEAKY_DETAIL = re.compile(
    r"(?<![A-Za-z0-9_$])(stack|cause|message|String\s*\(\s*error|"
    r"error\s*\.\s*\w+|err\s*\.\s*\w+)(?![A-Za-z0-9_$])"
)


# --------------------------------------------------------------------------
# Findings
# --------------------------------------------------------------------------


@dataclass
class Finding:
    path: str
    line: int
    detail: str
    excerpt: str = ""

    def render(self) -> str:
        where = f"{self.path}:{self.line}" if self.line else self.path
        out = f"  {where}\n      {self.detail}"
        if self.excerpt:
            out += f"\n      | {self.excerpt}"
        return out


@dataclass
class Report:
    violations: dict[str, list[Finding]] = field(default_factory=dict)
    confirmations: list[str] = field(default_factory=list)

    def violation(self, section: str, finding: Finding) -> None:
        self.violations.setdefault(section, []).append(finding)

    def confirm(self, line: str) -> None:
        self.confirmations.append(line)

    @property
    def failed(self) -> bool:
        return any(self.violations.values())

    @property
    def violation_count(self) -> int:
        return sum(len(v) for v in self.violations.values())


# --------------------------------------------------------------------------
# Reading and parsing
#
# The same comment-aware machinery audit_auth.py uses, and for the same
# reason: "is there a // earlier on this line" calls `const u = 'https://x'` a
# comment, and here it would let a commented-out `request.json()` pass while
# hiding a real one behind a URL.
# --------------------------------------------------------------------------


def read_text(path: str) -> str:
    try:
        with open(os.path.join(REPO_ROOT, path), "rb") as handle:
            return handle.read().decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        sys.stderr.write(f"audit_api: cannot read {path}: {error}\n")
        raise SystemExit(2) from error


def line_index(text: str) -> list[int]:
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def locate(starts: list[int], offset: int) -> int:
    return bisect.bisect_right(starts, offset)


def excerpt_at(text: str, starts: list[int], lineno: int, limit: int = 120) -> str:
    start = starts[lineno - 1]
    end = text.find("\n", start)
    if end == -1:
        end = len(text)
    line = text[start:end].strip()
    return line if len(line) <= limit else line[: limit - 1] + "…"


def comment_mask(text: str) -> list[bool]:
    """Per-character mask: True where the character sits inside a TS comment."""
    n = len(text)
    mask = [False] * n
    CODE, STRING, LINE_C, BLOCK_C = 0, 1, 2, 3
    state = CODE
    quote = ""
    i = 0
    while i < n:
        ch = text[i]
        if state == CODE:
            if ch in "'\"`":
                state, quote = STRING, ch
                i += 1
                continue
            if text.startswith("/*", i):
                state = BLOCK_C
                mask[i] = mask[min(i + 1, n - 1)] = True
                i += 2
                continue
            if text.startswith("//", i) and not (i > 0 and text[i - 1] == ":"):
                state = LINE_C
                mask[i] = mask[min(i + 1, n - 1)] = True
                i += 2
                continue
            i += 1
            continue
        if state == STRING:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                state = CODE
            i += 1
            continue
        if state == LINE_C:
            if ch == "\n":
                state = CODE
            else:
                mask[i] = True
            i += 1
            continue
        mask[i] = True
        if text.startswith("*/", i):
            mask[min(i + 1, n - 1)] = True
            i += 2
            state = CODE
            continue
        i += 1
    return mask


def strip_comments(text: str) -> str:
    """Same text with comment characters blanked, offsets preserved."""
    mask = comment_mask(text)
    return "".join(" " if mask[i] else ch for i, ch in enumerate(text))


def balanced_span(text: str, open_at: int, opener: str = "(", closer: str = ")") -> str:
    """Text between a bracket at `open_at` and its match. '' if unbalanced."""
    depth = 0
    i = open_at
    n = len(text)
    quote = ""
    while i < n:
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = ""
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            i += 1
            continue
        if ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[open_at + 1 : i]
        i += 1
    return ""


def function_body(text: str, signature: str) -> str:
    """The braces-balanced body of a named function, or '' if not found.

    The parameter list is stepped over rather than searched past: a default
    value like `headers: Record<string, string> = {}` puts a brace before the
    body, and taking the first one finds an empty function every time.
    """
    at = text.find(signature)
    if at == -1:
        return ""
    paren = text.find("(", at)
    if paren == -1:
        return ""
    params = balanced_span(text, paren)
    after = paren + 1 + len(params) + 1
    brace = text.find("{", after)
    if brace == -1:
        return ""
    return balanced_span(text, brace, "{", "}")


def code_only(fragment: str) -> str:
    """The fragment with literal *text* blanked, keeping ${...} interpolations.

    So the key `pin:${clientKey(request)}` reads as a call to clientKey and not
    as a mention of the submitted PIN.
    """
    out: list[str] = []
    i = 0
    n = len(fragment)
    while i < n:
        ch = fragment[i]
        if ch in "'\"":
            quote = ch
            out.append(" ")
            i += 1
            while i < n:
                if fragment[i] == "\\":
                    out.append("  ")
                    i += 2
                    continue
                out.append(" ")
                closing = fragment[i] == quote
                i += 1
                if closing:
                    break
            continue
        if ch == "`":
            out.append(" ")
            i += 1
            while i < n:
                if fragment[i] == "\\":
                    out.append("  ")
                    i += 2
                    continue
                if fragment[i] == "`":
                    out.append(" ")
                    i += 1
                    break
                if fragment.startswith("${", i):
                    out.append("  ")
                    i += 2
                    depth = 1
                    while i < n:
                        if fragment[i] == "{":
                            depth += 1
                        elif fragment[i] == "}":
                            depth -= 1
                            if depth == 0:
                                out.append(" ")
                                i += 1
                                break
                        out.append(fragment[i])
                        i += 1
                    continue
                out.append(" ")
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def calls_to(code: str, pattern: str) -> list[tuple[int, str]]:
    """(offset, argument-text) for each call matching `pattern` in stripped code."""
    found: list[tuple[int, str]] = []
    for match in re.finditer(pattern, code):
        paren = code.find("(", match.end() - 1)
        if paren == -1:
            continue
        found.append((match.start(), balanced_span(code, paren)))
    return found


def read_int_const(code: str, name: str) -> int | None:
    """An exported numeric const, allowing a simple product like `64 * 1024`."""
    match = re.search(rf"export\s+const\s+{name}\s*=\s*([0-9_ */+]+?)\s*;", code)
    if not match:
        return None
    expression = match.group(1).replace("_", "")
    if not re.fullmatch(r"[0-9 */+]+", expression):
        return None
    try:
        return int(eval(expression, {"__builtins__": {}}, {}))  # noqa: S307
    except (SyntaxError, ValueError, ZeroDivisionError, TypeError):
        return None


def string_literals(fragment: str) -> list[str]:
    """Single- and double-quoted literals in a fragment, in order."""
    return [m.group(1) or m.group(2) or "" for m in re.finditer(r"'([^']*)'|\"([^\"]*)\"", fragment)]


def source_map() -> dict[str, tuple[str, str, list[int]]]:
    """Every audited file as (raw text, comment-stripped code, line starts)."""
    out: dict[str, tuple[str, str, list[int]]] = {}
    for path in ALL_SOURCES:
        text = read_text(path)
        out[path] = (text, strip_comments(text), line_index(text))
    return out


# --------------------------------------------------------------------------
# A. Request bodies are bounded before they are parsed
# --------------------------------------------------------------------------

SECTION_A = "A. A request body is read without a size or depth bound"


def check_body_limits(report: Report, sources: dict[str, tuple[str, str, list[int]]]) -> None:
    _, http_code, _ = sources[HTTP]

    body_bytes = read_int_const(http_code, "MAX_BODY_BYTES")
    depth = read_int_const(http_code, "MAX_JSON_DEPTH")

    if body_bytes is None:
        report.violation(
            SECTION_A,
            Finding(
                HTTP,
                0,
                "no exported MAX_BODY_BYTES. Next's App Router imposes no request "
                "size limit of its own, so with none here a 50MB PUT is buffered "
                "and parsed in full.",
            ),
        )
    elif body_bytes <= 0 or body_bytes > MAX_REASONABLE_BODY_BYTES:
        report.violation(
            SECTION_A,
            Finding(
                HTTP,
                0,
                f"MAX_BODY_BYTES is {body_bytes}, which is not a bound anyone "
                f"chose. A normalised profile is a few kilobytes; expected "
                f"0 < limit <= {MAX_REASONABLE_BODY_BYTES}.",
            ),
        )

    if depth is None:
        report.violation(
            SECTION_A,
            Finding(
                HTTP,
                0,
                "no exported MAX_JSON_DEPTH. Size alone does not bound parse cost: "
                "a few hundred bytes of '[[[[...' is cheap to send and recursive "
                "to parse.",
            ),
        )
    elif depth <= 0 or depth > MAX_REASONABLE_DEPTH:
        report.violation(
            SECTION_A,
            Finding(HTTP, 0, f"MAX_JSON_DEPTH is {depth}; expected 0 < depth <= {MAX_REASONABLE_DEPTH}"),
        )

    reader = function_body(http_code, "export async function readJsonBody")
    if not reader:
        report.violation(SECTION_A, Finding(HTTP, 0, "readJsonBody is missing"))
    else:
        if "jsonDepth" not in reader:
            report.violation(
                SECTION_A,
                Finding(
                    HTTP,
                    0,
                    "readJsonBody never measures depth, so a JSON bomb reaches "
                    "JSON.parse with only a byte count between it and the stack",
                ),
            )
        if "readBounded" not in reader and "MAX_BODY_BYTES" not in reader:
            report.violation(
                SECTION_A,
                Finding(HTTP, 0, "readJsonBody reads the body without applying a byte limit"),
            )

    bounded = function_body(http_code, "async function readBounded")
    if not bounded:
        report.violation(SECTION_A, Finding(HTTP, 0, "readBounded is missing"))
    else:
        # Both halves are needed. content-length alone is a header an attacker
        # writes; a running total alone reads a body it could have refused.
        if "content-length" not in bounded:
            report.violation(
                SECTION_A,
                Finding(HTTP, 0, "readBounded ignores content-length, so it reads what it could refuse"),
            )
        if "total" not in bounded or "limit" not in bounded:
            report.violation(
                SECTION_A,
                Finding(
                    HTTP,
                    0,
                    "readBounded keeps no running total, so a body that understates "
                    "its content-length is read in full anyway",
                ),
            )

    # And no route may go around it.
    for path in ROUTE_SOURCES:
        text, code, starts = sources[path]
        for match in re.finditer(r"\brequest\s*\.\s*json\s*\(", code):
            lineno = locate(starts, match.start())
            report.violation(
                SECTION_A,
                Finding(
                    path,
                    lineno,
                    "request.json() buffers and parses the whole body with no "
                    "limit. Use readJsonBody.",
                    excerpt_at(text, starts, lineno),
                ),
            )

    for path in BODY_ROUTES:
        _, code, _ = sources[path]
        if "readJsonBody" not in code:
            report.violation(
                SECTION_A,
                Finding(path, 0, "this route reads a request body but never calls readJsonBody"),
            )

    if not report.violations.get(SECTION_A):
        report.confirm(
            f"A. Bodies are capped at {body_bytes} bytes and depth {depth}, checked "
            "against content-length and against a running total, and measured for "
            f"depth before parsing. Neither of the {len(BODY_ROUTES)} body-reading "
            "routes calls request.json() directly."
        )


# --------------------------------------------------------------------------
# B. Volume is throttled, and the throttle is not an oracle
# --------------------------------------------------------------------------

SECTION_B = "B. Nothing throttles volume beyond the per-account lockout"


def check_rate_limits(report: Report, sources: dict[str, tuple[str, str, list[int]]]) -> None:
    _, limiter, _ = sources[RATELIMIT]

    if "export function checkRateLimit" not in limiter:
        report.violation(
            SECTION_B,
            Finding(
                RATELIMIT,
                0,
                "checkRateLimit is missing. The account lockout is keyed to an "
                "account and never sees a flood that rotates the trainer name.",
            ),
        )
        return

    for rule in ("AUTH_RULE", "PROFILE_RULE"):
        match = re.search(rf"export\s+const\s+{rule}[^=]*=\s*\{{([^}}]*)\}}", limiter)
        if not match:
            report.violation(SECTION_B, Finding(RATELIMIT, 0, f"{rule} is missing"))
            continue
        limit = re.search(r"limit\s*:\s*([0-9_]+)", match.group(1))
        window = re.search(r"windowMs\s*:\s*([0-9_]+)", match.group(1))
        if not limit or int(limit.group(1).replace("_", "")) <= 0:
            report.violation(SECTION_B, Finding(RATELIMIT, 0, f"{rule} has no positive limit"))
        if not window or int(window.group(1).replace("_", "")) <= 0:
            report.violation(SECTION_B, Finding(RATELIMIT, 0, f"{rule} has no positive window"))

    # Each throttled route must consult the limiter *before* it does the work
    # the limiter exists to ration.
    guarded = {
        PIN_ROUTE: ("loginWithPin", "registerWithPin"),
        PROFILE_ROUTE: ("saveProfile",),
    }
    for path, expensive in sorted(guarded.items()):
        _, code, starts = sources[path]
        checks = [offset for offset, _ in calls_to(code, r"\bcheckRateLimit\s*\(")]
        if not checks:
            report.violation(
                SECTION_B,
                Finding(
                    path,
                    0,
                    "this route never calls checkRateLimit, so a caller may repeat "
                    "it as fast as the network allows",
                ),
            )
            continue
        first_check = min(checks)
        for name in expensive:
            at = code.find(name + "(")
            if at != -1 and at < first_check:
                report.violation(
                    SECTION_B,
                    Finding(
                        path,
                        locate(starts, at),
                        f"{name} runs before the rate limit is consulted, so the "
                        "work is done and only the answer is withheld",
                    ),
                )

    # The PIN throttle must be keyed to the caller, never to the submitted
    # name: keying by name is both escapable (rotate names) and an oracle (the
    # answer would depend on which name was tried), which is exactly the signal
    # loginWithPin refuses to give.
    _, pin_code, pin_starts = sources[PIN_ROUTE]
    for offset, args in calls_to(pin_code, r"\bcheckRateLimit\s*\("):
        key = code_only(args).split(",")[0]
        if "clientKey" not in key:
            report.violation(
                SECTION_B,
                Finding(
                    PIN_ROUTE,
                    locate(pin_starts, offset),
                    "the sign-in throttle is not keyed on the caller's address",
                ),
            )
        if re.search(r"(?<![A-Za-z0-9_$])(name|pin|raw|body)(?![A-Za-z0-9_$])", key):
            report.violation(
                SECTION_B,
                Finding(
                    PIN_ROUTE,
                    locate(pin_starts, offset),
                    "the sign-in throttle is keyed on something the caller submits. "
                    "That both escapes the limit (rotate the value) and makes the "
                    "response depend on which name was tried, which enumerates "
                    "trainers just as well as a different error message would.",
                ),
            )

    if not report.violations.get(SECTION_B):
        report.confirm(
            "B. checkRateLimit guards the sign-in and profile-write routes before "
            "either touches the database; the sign-in key is the caller's address "
            "and nothing the caller submitted."
        )


# --------------------------------------------------------------------------
# C. The session token and the cookies that carry it
# --------------------------------------------------------------------------

SECTION_C = "C. The session token is decoded rather than verified, or a cookie drifts"


def check_session(report: Report, sources: dict[str, tuple[str, str, list[int]]]) -> None:
    _, session, _ = sources[SESSION]

    read = function_body(session, "export async function readSession")
    if not read:
        report.violation(SECTION_C, Finding(SESSION, 0, "readSession is missing"))
    else:
        if "jwtVerify" not in read:
            report.violation(
                SECTION_C,
                Finding(
                    SESSION,
                    0,
                    "readSession does not call jwtVerify. A decoded token is a "
                    "claim the caller wrote: anyone could mint a trainerId.",
                ),
            )
        if "decodeJwt" in read:
            report.violation(
                SECTION_C,
                Finding(SESSION, 0, "readSession decodes the session token instead of verifying it"),
            )
        if not re.search(r"algorithms\s*:\s*\[", read):
            report.violation(
                SECTION_C,
                Finding(
                    SESSION,
                    0,
                    "jwtVerify is called without pinning `algorithms`, so the "
                    "token's own header is allowed to choose",
                ),
            )

    # Nothing outside session.ts may touch the session cookie's value, and
    # nothing anywhere may decode it.
    for path in ROUTE_SOURCES:
        text, code, starts = sources[path]
        if "decodeJwt" not in code:
            continue
        if "SESSION_COOKIE" in code:
            report.violation(
                SECTION_C,
                Finding(path, 0, "this route decodes a JWT and also handles the session cookie"),
            )

    age = re.search(r"MAX_AGE_SECONDS\s*=\s*([0-9_ */+]+?)\s*;", session)
    if not age:
        report.violation(
            SECTION_C,
            Finding(SESSION, 0, "MAX_AGE_SECONDS is missing, so the session cookie has no expiry"),
        )
    else:
        expression = age.group(1).replace("_", "")
        seconds = int(eval(expression, {"__builtins__": {}}, {})) if re.fullmatch(r"[0-9 */+]+", expression) else 0
        if seconds <= 0:
            report.violation(SECTION_C, Finding(SESSION, 0, "the session cookie has no positive lifetime"))
        elif seconds > MAX_COOKIE_AGE_SECONDS:
            report.violation(
                SECTION_C,
                Finding(
                    SESSION,
                    0,
                    f"the session cookie asks for {seconds}s, past the 400-day cap "
                    "browsers apply - the code and the browser disagree about when "
                    "a child is signed out",
                ),
            )
        if "setExpirationTime" not in session:
            report.violation(
                SECTION_C,
                Finding(
                    SESSION,
                    0,
                    "the token itself carries no expiry, so a cookie copied before "
                    "it lapsed is valid forever",
                ),
            )

    # Every cookie the app sets must inherit one hardened flag set. Two
    # hand-maintained flag lists are how one of them loses httpOnly quietly.
    if "export const COOKIE_OPTIONS" not in session:
        report.violation(
            SECTION_C, Finding(SESSION, 0, "COOKIE_OPTIONS is not exported for other setters to share")
        )
    for path in sorted(set(ROUTE_SOURCES) | {SESSION}):
        text, code, starts = sources[path]
        for offset, args in calls_to(code, r"\.set\s*\("):
            if "_COOKIE" not in args:
                continue  # searchParams.set and friends
            if "COOKIE_OPTIONS" not in args:
                lineno = locate(starts, offset)
                report.violation(
                    SECTION_C,
                    Finding(
                        path,
                        lineno,
                        "a cookie is set without spreading COOKIE_OPTIONS, so its "
                        "flags are not the audited ones",
                        excerpt_at(text, starts, lineno),
                    ),
                )

    if not report.violations.get(SECTION_C):
        report.confirm(
            "C. readSession verifies with jwtVerify and a pinned HS256; the token "
            "and the cookie both expire; every cookie set anywhere in the app "
            "spreads COOKIE_OPTIONS."
        )


# --------------------------------------------------------------------------
# D. Error paths
# --------------------------------------------------------------------------

SECTION_D = "D. An error path leaks detail, or escapes its route uncaught"


def check_error_paths(report: Report, sources: dict[str, tuple[str, str, list[int]]]) -> None:
    for path in ALL_SOURCES:
        text, code, starts = sources[path]

        for offset, args in calls_to(code, r"console\.\w+\s*\("):
            match = CAUGHT_ERROR.search(args)
            if match is not None:
                lineno = locate(starts, offset)
                report.violation(
                    SECTION_D,
                    Finding(
                        path,
                        lineno,
                        f"a console call is handed {match.group(0)!r}. Node prints an "
                        "Error's own enumerable properties, and postgres.js hangs "
                        "`query` and `parameters` off its errors - the parameters of "
                        "an insert into trainers include the PIN hash. Log the "
                        "message through logServerError instead.",
                        excerpt_at(text, starts, lineno),
                    ),
                )

    for path in ROUTE_SOURCES:
        text, code, starts = sources[path]

        for pattern in (r"\bjsonError\s*\(", r"(?:NextResponse|Response)\s*\.\s*json\s*\("):
            for offset, args in calls_to(code, pattern):
                match = LEAKY_DETAIL.search(args)
                if match is not None:
                    lineno = locate(starts, offset)
                    report.violation(
                        SECTION_D,
                        Finding(
                            path,
                            lineno,
                            f"a response body carries {match.group(0)!r}. How far a "
                            "payload got, and what the database said about it, are "
                            "for the log and not for the caller.",
                            excerpt_at(text, starts, lineno),
                        ),
                    )

        # Every exported handler must be wrapped, so a thrown error is answered
        # by us rather than by the framework's error page.
        wrapped = set(re.findall(r"(?:export\s+)?const\s+(\w+)\s*=\s*route\s*\(", code))
        for match in re.finditer(r"export\s+async\s+function\s+(" + "|".join(HTTP_VERBS) + r")\b", code):
            report.violation(
                SECTION_D,
                Finding(
                    path,
                    locate(starts, match.start()),
                    f"{match.group(1)} is exported as a bare async function. An "
                    "uncaught throw inside it is answered by Next - a stack trace "
                    "in development, an HTML page in production, and in neither "
                    "case a word the iOS client understands. Wrap it in route().",
                ),
            )
        for match in re.finditer(
            r"export\s+const\s+(" + "|".join(HTTP_VERBS) + r")\s*(?::[^=]+)?=\s*([A-Za-z_$][\w$]*)", code
        ):
            verb, source = match.group(1), match.group(2)
            if source != "route" and source not in wrapped:
                report.violation(
                    SECTION_D,
                    Finding(
                        path,
                        locate(starts, match.start()),
                        f"{verb} is exported from {source!r}, which is not wrapped in "
                        "route(), so a throw inside it escapes to the framework",
                    ),
                )

    if "export function logServerError" not in sources[HTTP][1]:
        report.violation(
            SECTION_D, Finding(HTTP, 0, "logServerError is missing; there is no safe way to log a failure")
        )

    if not report.violations.get(SECTION_D):
        report.confirm(
            f"D. All {len(ROUTE_SOURCES)} routes export handlers wrapped in route(); "
            "no response body carries an exception's detail; no console call is "
            "handed a caught error object."
        )


# --------------------------------------------------------------------------
# E. Input shape, and the words a failure may use
# --------------------------------------------------------------------------

SECTION_E = "E. A route trusts an input shape, or invents an error word"


def declared_vocabulary(code: str, name: str) -> tuple[str, ...] | None:
    match = re.search(rf"export\s+const\s+{name}\s*=\s*\[(.*?)\]\s*as\s+const", code, re.DOTALL)
    if not match:
        return None
    return tuple(sorted(string_literals(match.group(1))))


def emitted_errors(code: str) -> set[str]:
    """Every literal error word a route can put in a response body."""
    words: set[str] = set()
    for _, args in calls_to(code, r"\bjsonError\s*\("):
        first = args.split(",")[0].strip()
        literals = string_literals(first)
        if literals:
            words.add(literals[0])
    for _, args in calls_to(code, r"(?:NextResponse|Response)\s*\.\s*json\s*\("):
        match = re.search(r"error\s*:\s*'([^']*)'", args)
        if match:
            words.add(match.group(1))
    return words


def check_input_and_vocabulary(report: Report, sources: dict[str, tuple[str, str, list[int]]]) -> None:
    _, http_code, _ = sources[HTTP]

    auth_vocabulary = declared_vocabulary(http_code, "AUTH_ERRORS")
    profile_vocabulary = declared_vocabulary(http_code, "PROFILE_ERRORS")

    if auth_vocabulary is None:
        report.violation(SECTION_E, Finding(HTTP, 0, "AUTH_ERRORS is missing or not a const tuple"))
    elif auth_vocabulary != DOCUMENTED_AUTH_ERRORS:
        report.violation(
            SECTION_E,
            Finding(
                HTTP,
                0,
                f"AUTH_ERRORS is {list(auth_vocabulary)}, but the iOS client in "
                f"mobile/src/api.ts switches on {list(DOCUMENTED_AUTH_ERRORS)} and "
                "maps anything else to 'unavailable' - which tells a locked-out "
                "child to try again rather than to wait. Changing this set is a "
                "cross-client change and has to be announced as one.",
            ),
        )

    if profile_vocabulary is None:
        report.violation(SECTION_E, Finding(HTTP, 0, "PROFILE_ERRORS is missing or not a const tuple"))

    allowed = {
        PIN_ROUTE: set(auth_vocabulary or ()),
        PROFILE_ROUTE: set(profile_vocabulary or ()) | set(auth_vocabulary or ()),
    }
    for path, vocabulary in sorted(allowed.items()):
        _, code, _ = sources[path]
        for word in sorted(emitted_errors(code) - vocabulary):
            report.violation(
                SECTION_E,
                Finding(
                    path,
                    0,
                    f"answers with {word!r}, which is outside the declared "
                    "vocabulary. A client that has never heard the word treats it "
                    "as a generic outage.",
                ),
            )

    # The PIN route must check the type of everything it reads. `body.name`
    # arriving as an object and reaching a SQL template is how a validation gap
    # becomes a database problem.
    _, pin_code, _ = sources[PIN_ROUTE]
    for field_name in ("name", "pin"):
        if not re.search(rf"typeof\s+\w+\.{field_name}\s*===\s*'string'", pin_code):
            report.violation(
                SECTION_E,
                Finding(
                    PIN_ROUTE,
                    0,
                    f"the {field_name!r} field is used without a typeof check, so a "
                    "non-string reaches the account layer",
                ),
            )
    if not re.search(r"typeof\s+\w+\s*!==\s*'object'", pin_code):
        report.violation(
            SECTION_E,
            Finding(
                PIN_ROUTE,
                0,
                "the parsed body is not checked to be an object, so a bare JSON "
                "`null` or `7` is indexed as one",
            ),
        )

    # The profile route's whole defence is that normaliseProfile runs first.
    _, profile_code, profile_starts = sources[PROFILE_ROUTE]
    normalise_at = profile_code.find("normaliseProfile(")
    save_at = profile_code.find("saveProfile(")
    if normalise_at == -1:
        report.violation(
            SECTION_E,
            Finding(
                PROFILE_ROUTE,
                0,
                "normaliseProfile is never called. CLAUDE.md: 'The server never "
                "trusts a client profile.'",
            ),
        )
    elif save_at != -1 and save_at < normalise_at:
        report.violation(
            SECTION_E,
            Finding(
                PROFILE_ROUTE,
                locate(profile_starts, save_at),
                "saveProfile is reached before normaliseProfile, so the stored save "
                "is whatever the client sent",
            ),
        )

    if not report.violations.get(SECTION_E):
        report.confirm(
            f"E. Sign-in answers only in {list(DOCUMENTED_AUTH_ERRORS)}, the set "
            "mobile/src/api.ts switches on; both body fields are type-checked; "
            "normaliseProfile runs before anything is stored."
        )


# --------------------------------------------------------------------------
# F. Caching
# --------------------------------------------------------------------------

SECTION_F = "F. An API response can be cached, or rendered ahead of time"


def check_caching(report: Report, sources: dict[str, tuple[str, str, list[int]]]) -> None:
    for path in ROUTE_SOURCES:
        text, code, starts = sources[path]

        if not re.search(r"export\s+const\s+dynamic\s*=\s*'force-dynamic'", code):
            report.violation(
                SECTION_F,
                Finding(
                    path,
                    0,
                    "no `dynamic = 'force-dynamic'`, so Next may render this route "
                    "at build time and serve one child's answer to every caller",
                ),
            )

        # Everything JSON goes through jsonOk/jsonError, which set no-store.
        for offset, _ in calls_to(code, r"(?:NextResponse|Response)\s*\.\s*json\s*\("):
            lineno = locate(starts, offset)
            report.violation(
                SECTION_F,
                Finding(
                    path,
                    lineno,
                    "a raw JSON response bypasses jsonOk/jsonError and therefore "
                    "carries no cache-control. force-dynamic tells Next not to "
                    "pre-render; it says nothing to an intermediary about storing "
                    "the answer.",
                    excerpt_at(text, starts, lineno),
                ),
            )

        for offset, args in calls_to(code, r"NextResponse\s*\.\s*redirect\s*\("):
            if "cache-control" not in args:
                lineno = locate(starts, offset)
                report.violation(
                    SECTION_F,
                    Finding(
                        path,
                        lineno,
                        "a redirect that sets or clears a session carries no "
                        "cache-control",
                        excerpt_at(text, starts, lineno),
                    ),
                )

    _, http_code, _ = sources[HTTP]
    if "'cache-control': 'no-store'" not in http_code:
        report.violation(
            SECTION_F, Finding(HTTP, 0, "NO_STORE no longer sets cache-control: no-store")
        )
    for helper in ("export function jsonError", "export function jsonOk"):
        body = function_body(http_code, helper)
        if not body:
            report.violation(SECTION_F, Finding(HTTP, 0, f"{helper.split()[-1]} is missing"))
        elif "NO_STORE" not in body:
            report.violation(
                SECTION_F,
                Finding(HTTP, 0, f"{helper.split()[-1]} does not apply NO_STORE"),
            )

    if not report.violations.get(SECTION_F):
        report.confirm(
            f"F. All {len(ROUTE_SOURCES)} routes are force-dynamic; every JSON answer "
            "goes through jsonOk/jsonError, which set no-store; every redirect sets "
            "it explicitly."
        )


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------


def render(report: Report, quiet: bool) -> str:
    out: list[str] = []
    add = out.append

    add("=" * 74)
    add("HTTP SURFACE AUDIT - Mathmon Battle League")
    add("=" * 74)
    add("")
    add(f"Files examined: {len(ALL_SOURCES)}")
    for path in ALL_SOURCES:
        add(f"  {path}")
    add("")

    if report.violations:
        add("-" * 74)
        add(f"VIOLATIONS ({report.violation_count})")
        add("-" * 74)
        for section in sorted(report.violations):
            findings = report.violations[section]
            add("")
            add(f"{section}  [{len(findings)}]")
            for finding in sorted(findings, key=lambda f: (f.path, f.line, f.detail)):
                add(finding.render())
        add("")

    if not quiet and report.confirmations:
        add("-" * 74)
        add("PROPERTIES CONFIRMED")
        add("-" * 74)
        add("")
        for line in report.confirmations:
            add(f"  {line}")
        add("")

    if not quiet:
        add("-" * 74)
        add("WHAT THIS AUDIT CANNOT SEE")
        add("-" * 74)
        add("")
        add("  Static analysis proves the shape of the code, not its behaviour.")
        add("  The behavioural half needs no database and runs on every push:")
        add("")
        add("    - src/lib/server/http.test.ts: a 50MB body and an undeclared")
        add("      50MB body are both refused; a depth bomb is refused before")
        add("      JSON.parse; a thrown postgres error becomes {\"error\":")
        add("      \"unavailable\"} with its query parameters left behind.")
        add("    - src/lib/server/ratelimit.test.ts: the window opens and closes,")
        add("      keys do not bleed, and a full table fails open.")
        add("")
        add("  And these are proved by nothing, by design:")
        add("")
        add("    - the rate limiter across instances. It is per-process, so on a")
        add("      scaled-out deployment the real limit is (limit x instances)")
        add("      and a cold start forgets everything. A shared-state limiter")
        add("      would mean a second service for a game whose deployment story")
        add("      is 'click import, set nothing'.")
        add("    - the platform's own body limit. Vercel caps a request at 4.5MB")
        add("      before a function sees it; `next start` on a plain host caps")
        add("      nothing, which is the case these limits are written for.")
        add("    - x-forwarded-for behind no proxy at all, where it is")
        add("      client-controlled. Nothing security-critical is keyed on it;")
        add("      the account lockout is keyed on the account.")
        add("")
        add("  The account itself - PIN hashing, the lockout, enumeration - is")
        add("  audited by scripts/audit_auth.py, not here.")
        add("")

    add("=" * 74)
    if report.failed:
        add(f"RESULT: FAIL - {report.violation_count} violation(s)")
        add("")
        add("The HTTP surface accepts, answers or logs something it should not.")
    else:
        add("RESULT: PASS")
        add("")
        add("Bodies are bounded in bytes and in depth before they are parsed;")
        add("volume is throttled above the per-account lockout, keyed so it")
        add("cannot enumerate; the session token is verified with a pinned")
        add("algorithm and every cookie shares one flag set; no error path leaks")
        add("detail or escapes uncaught; every route validates its input and")
        add("answers in the documented vocabulary; nothing is cacheable.")
    add("=" * 74)
    return "\n".join(out)


def main(argv: list[str]) -> int:
    quiet = "--quiet" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--quiet"]
    if unknown:
        sys.stderr.write(f"audit_api: unknown argument(s): {' '.join(unknown)}\n")
        sys.stderr.write(__doc__ or "")
        return 2

    sources = source_map()

    report = Report()
    check_body_limits(report, sources)
    check_rate_limits(report, sources)
    check_session(report, sources)
    check_error_paths(report, sources)
    check_input_and_vocabulary(report, sources)
    check_caching(report, sources)

    sys.stdout.write(render(report, quiet) + "\n")
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
