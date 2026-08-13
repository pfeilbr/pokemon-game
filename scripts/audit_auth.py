#!/usr/bin/env python3
"""Audit the security claims CLAUDE.md makes about the account layer.

CLAUDE.md states, as prose:

    "A 4-digit PIN is only 10,000 combinations. The hash is not the defence -
     the lockout is. Five wrong guesses lock an account for fifteen minutes.
     PINs are scrypt-hashed with a per-account salt so a database leak does
     not expose them, and login failures are indistinguishable between 'no
     such name' and 'wrong PIN' so the endpoint cannot enumerate trainers.
     If you touch accounts.ts, keep all three properties."

    "AUTH_SECRET falls back to an HKDF of DATABASE_URL when unset... It is a
     convenience, not a recommendation."

Prose does not fail a build. The behavioural half of those claims is pinned by
the Postgres integration tests in src/lib/server/db.integration.test.ts; this
script covers the half that needs no database and can therefore run on every
push, in any checkout, with no services attached:

  A. No plaintext PIN is logged, and no PIN or PIN hash is returned in a
     response body.
  B. scrypt (a real KDF) derives the stored value, over a per-account random
     salt, compared with timingSafeEqual - not a bare digest and not `===`.
  C. The lockout constants exist, are used, and match the documented
     5 attempts / 15 minutes - in the code AND in CLAUDE.md, so the two
     cannot drift apart silently.
  D. The session cookie is httpOnly and sameSite, on every path that sets it.
  E. The AUTH_SECRET -> DATABASE_URL fallback still emits its warning before
     handing back a derived key.
  F. The "no such trainer" branch still performs a key derivation, so the
     clock cannot enumerate trainer names. (This one is here because it was
     a real defect: the branch used to return immediately, which made an
     unknown name answer ~270x faster than a wrong PIN while returning a
     byte-identical body.)

What this script CANNOT prove: that the running server is constant-time, that
the lockout survives a concurrent race, or that a dependency does not log for
us. Those are behavioural and belong to the integration tests, or to nobody.

Standard library only. No network, no clock, no randomness, no git. Output is
derived from sorted inputs and is byte-identical across runs, so a diff in CI
output means a diff in the repository.

Usage:
    python3 scripts/audit_auth.py            # audit; exit 1 on violation
    python3 scripts/audit_auth.py --quiet    # violations and result only

Exit codes:  0 = clean   1 = violations found   2 = could not run the audit
"""

from __future__ import annotations

import bisect
import os
import re
import sys
from dataclasses import dataclass, field

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ACCOUNTS = "src/lib/server/accounts.ts"
SESSION = "src/lib/server/session.ts"
ENV = "src/lib/server/env.ts"
CLAUDE_MD = "CLAUDE.md"

# Every file that can see a PIN or mint a session. Missing any of these is a
# hard error rather than a pass: an audit that silently skips its subject is
# worse than no audit.
AUTH_SOURCES = (
    ACCOUNTS,
    SESSION,
    ENV,
    "src/lib/server/db.ts",
    "src/app/api/auth/pin/route.ts",
    "src/app/api/auth/google/route.ts",
    "src/app/api/auth/google/callback/route.ts",
    "src/app/api/auth/signout/route.ts",
    "src/app/api/session/route.ts",
    "src/app/api/profile/route.ts",
)

# Route handlers - the files that can put something in a response body.
ROUTE_SOURCES = tuple(f for f in AUTH_SOURCES if f.startswith("src/app/api/"))

# The documented lockout policy, in both the units the code uses and the words
# CLAUDE.md uses. Both are checked, so changing one without the other fails.
DOCUMENTED_MAX_FAILED_LOGINS = 5
DOCUMENTED_LOCKOUT_MINUTES = 15
DOC_ATTEMPTS_WORDS = ("five", "5")
DOC_MINUTES_WORDS = ("fifteen", "15")

# A secret-bearing identifier appearing in a log line or a response body.
SECRET_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(pin|pins|pin_hash|pinHash|password|secret)(?![A-Za-z0-9_])",
    re.IGNORECASE,
)

# Identifiers that merely *contain* "pin" and are not secrets. Matched whole,
# so `loginWithPin` never trips the rule above while `body.pin` still does.
SAFE_IDENTIFIERS = ("loginWithPin", "registerWithPin", "isValidPin", "hashPin", "verifyPin")


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
# --------------------------------------------------------------------------


def read_text(path: str) -> str:
    """Read a required file. A missing subject aborts the audit (exit 2)."""
    try:
        with open(os.path.join(REPO_ROOT, path), "rb") as handle:
            return handle.read().decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        sys.stderr.write(f"audit_auth: cannot read {path}: {error}\n")
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
    """Per-character mask: True where the character sits inside a TS comment.

    A state machine rather than a regex, for the same reason audit_assets.py
    uses one: "is there a // earlier on the line" calls
    `const u = 'https://x'` a comment, and here it would call a real
    `console.log(pin)` a comment if a URL appeared above it. String literals
    are tracked, and `//` preceded by `:` is a URL scheme, never a comment.
    """
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


def balanced_span(text: str, open_at: int, opener: str = "(", closer: str = ")") -> str:
    """Text between a bracket at `open_at` and its match. '' if unbalanced.

    Quote- and comment-aware, so a ')' inside a string does not close a call.
    """
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
        if text.startswith("//", i):
            nl = text.find("\n", i)
            i = n if nl == -1 else nl
            continue
        if text.startswith("/*", i):
            close = text.find("*/", i)
            i = n if close == -1 else close + 2
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
    """The braces-balanced body of a named function, or '' if not found."""
    at = text.find(signature)
    if at == -1:
        return ""
    brace = text.find("{", at)
    if brace == -1:
        return ""
    return balanced_span(text, brace, "{", "}")


def strip_comments(text: str) -> str:
    """Same text with comment characters blanked, offsets preserved."""
    mask = comment_mask(text)
    return "".join(" " if mask[i] else ch for i, ch in enumerate(text))


def calls_to(text: str, pattern: str) -> list[tuple[int, str]]:
    """(offset, argument-text) for each call matching `pattern` in code."""
    code = strip_comments(text)
    found: list[tuple[int, str]] = []
    for match in re.finditer(pattern, code):
        paren = code.find("(", match.end() - 1)
        if paren == -1:
            continue
        found.append((match.start(), balanced_span(code, paren)))
    return found


def mentions_secret(fragment: str) -> str | None:
    """The secret-ish identifier in `fragment`, ignoring safe function names."""
    cleaned = fragment
    for safe in SAFE_IDENTIFIERS:
        cleaned = cleaned.replace(safe, " " * len(safe))
    match = SECRET_TOKEN.search(cleaned)
    return match.group(0) if match else None


# --------------------------------------------------------------------------
# A. Nothing leaks the PIN
# --------------------------------------------------------------------------

SECTION_A = "A. A PIN or PIN hash reaches a log line or a response body"


def check_no_leak(report: Report) -> None:
    logged = 0
    responses = 0

    for path in AUTH_SOURCES:
        text = read_text(path)
        starts = line_index(text)

        for offset, args in calls_to(text, r"console\.\w+\s*\("):
            logged += 1
            token = mentions_secret(args)
            if token is not None:
                lineno = locate(starts, offset)
                report.violation(
                    SECTION_A,
                    Finding(
                        path,
                        lineno,
                        f"console call references {token!r}. A PIN in a log is a "
                        "PIN in a log aggregator, a support ticket and a backup.",
                        excerpt_at(text, starts, lineno),
                    ),
                )

    for path in ROUTE_SOURCES:
        text = read_text(path)
        starts = line_index(text)
        for offset, args in calls_to(text, r"(?:NextResponse|Response)\s*\.\s*json\s*\("):
            responses += 1
            token = mentions_secret(args)
            if token is not None:
                lineno = locate(starts, offset)
                report.violation(
                    SECTION_A,
                    Finding(
                        path,
                        lineno,
                        f"response body references {token!r}",
                        excerpt_at(text, starts, lineno),
                    ),
                )

    # The AuthResult union is what every caller of the account layer receives.
    # A PIN field here would leak through every route at once.
    accounts = strip_comments(read_text(ACCOUNTS))
    union_at = accounts.find("export type AuthResult")
    union = accounts[union_at : accounts.find(";", union_at)] if union_at != -1 else ""
    if union and mentions_secret(union) is not None:
        report.violation(
            SECTION_A,
            Finding(ACCOUNTS, 0, "AuthResult carries a PIN-shaped field to its callers"),
        )

    report.confirm(
        f"A. {logged} console call(s) and {responses} JSON response(s) across "
        f"{len(AUTH_SOURCES)} auth file(s); none names a PIN, PIN hash or secret."
    )


# --------------------------------------------------------------------------
# B. A real KDF, a real salt, a real comparison
# --------------------------------------------------------------------------

SECTION_B = "B. The stored PIN is not protected by a real KDF"


def check_kdf(report: Report) -> None:
    text = read_text(ACCOUNTS)
    code = strip_comments(text)
    starts = line_index(text)

    if not re.search(r"from\s+'node:crypto'", code) or "scrypt" not in code:
        report.violation(
            SECTION_B, Finding(ACCOUNTS, 0, "scrypt is not imported from node:crypto")
        )

    hash_body = function_body(code, "export async function hashPin")
    verify_body = function_body(code, "export async function verifyPin")

    if not hash_body:
        report.violation(SECTION_B, Finding(ACCOUNTS, 0, "hashPin is missing"))
    if not verify_body:
        report.violation(SECTION_B, Finding(ACCOUNTS, 0, "verifyPin is missing"))

    if hash_body and "scrypt" not in hash_body:
        lineno = locate(starts, code.find("export async function hashPin"))
        report.violation(
            SECTION_B,
            Finding(
                ACCOUNTS,
                lineno,
                "hashPin does not call scrypt. A 4-digit PIN under a bare digest "
                "is a 10,000-entry rainbow table, computable in milliseconds.",
            ),
        )
    if verify_body and "scrypt" not in verify_body:
        report.violation(
            SECTION_B, Finding(ACCOUNTS, 0, "verifyPin does not call scrypt")
        )

    # Per-account salt. randomBytes inside hashPin is what makes two children
    # who both chose 1234 store different rows.
    if hash_body and "randomBytes" not in hash_body:
        report.violation(
            SECTION_B,
            Finding(
                ACCOUNTS,
                0,
                "hashPin derives no per-account random salt, so identical PINs "
                "collide and one cracked row cracks the table",
            ),
        )

    if verify_body and "timingSafeEqual" not in verify_body:
        report.violation(
            SECTION_B,
            Finding(ACCOUNTS, 0, "verifyPin compares digests without timingSafeEqual"),
        )

    # A bare digest anywhere near the PIN path is the downgrade this guards.
    for match in re.finditer(r"createHash\s*\(", code):
        lineno = locate(starts, match.start())
        report.violation(
            SECTION_B,
            Finding(
                ACCOUNTS,
                lineno,
                "createHash() in the account layer - a fast digest is not a KDF",
                excerpt_at(text, starts, lineno),
            ),
        )

    if not report.violations.get(SECTION_B):
        report.confirm(
            "B. hashPin derives with scrypt over a randomBytes salt; verifyPin "
            "re-derives and compares with timingSafeEqual; no createHash anywhere."
        )


# --------------------------------------------------------------------------
# C. The lockout constants, in code and in the documentation
# --------------------------------------------------------------------------

SECTION_C = "C. The lockout does not match the documented 5 attempts / 15 minutes"


def read_int_const(code: str, name: str) -> int | None:
    match = re.search(rf"export\s+const\s+{name}\s*=\s*(\d+)\s*;", code)
    return int(match.group(1)) if match else None


def check_lockout(report: Report) -> None:
    text = read_text(ACCOUNTS)
    code = strip_comments(text)

    attempts = read_int_const(code, "MAX_FAILED_LOGINS")
    minutes = read_int_const(code, "LOCKOUT_MINUTES")

    for name, actual, expected in (
        ("MAX_FAILED_LOGINS", attempts, DOCUMENTED_MAX_FAILED_LOGINS),
        ("LOCKOUT_MINUTES", minutes, DOCUMENTED_LOCKOUT_MINUTES),
    ):
        if actual is None:
            report.violation(
                SECTION_C,
                Finding(ACCOUNTS, 0, f"exported const {name} is missing"),
            )
        elif actual != expected:
            report.violation(
                SECTION_C,
                Finding(
                    ACCOUNTS,
                    0,
                    f"{name} is {actual}, but CLAUDE.md documents {expected}. "
                    "Change both or neither.",
                ),
            )

    # A constant nobody reads is a comment with a type. Both must be used by
    # the sign-in path itself.
    login = function_body(code, "export async function loginWithPin")
    if not login:
        report.violation(SECTION_C, Finding(ACCOUNTS, 0, "loginWithPin is missing"))
    else:
        for name in ("MAX_FAILED_LOGINS", "LOCKOUT_MINUTES"):
            if name not in login:
                report.violation(
                    SECTION_C,
                    Finding(
                        ACCOUNTS,
                        0,
                        f"loginWithPin never reads {name}, so the exported "
                        "constant does not describe what the code does",
                    ),
                )
        if "locked_until" not in login:
            report.violation(
                SECTION_C,
                Finding(ACCOUNTS, 0, "loginWithPin never consults locked_until"),
            )

    # And the prose has to still say the same thing.
    doc = read_text(CLAUDE_MD).lower()
    attempts_ok = any(f"{w} wrong guesses lock" in doc for w in DOC_ATTEMPTS_WORDS)
    minutes_ok = any(f"{w} minutes" in doc for w in DOC_MINUTES_WORDS)
    if not attempts_ok:
        report.violation(
            SECTION_C,
            Finding(
                CLAUDE_MD,
                0,
                "no sentence of the form '<five|5> wrong guesses lock ...' - the "
                "documented policy and the constants can no longer be compared",
            ),
        )
    if not minutes_ok:
        report.violation(
            SECTION_C,
            Finding(CLAUDE_MD, 0, "the lockout window is no longer stated in minutes"),
        )

    if not report.violations.get(SECTION_C):
        report.confirm(
            f"C. MAX_FAILED_LOGINS = {attempts} and LOCKOUT_MINUTES = {minutes}, "
            "both read by loginWithPin, both matching CLAUDE.md."
        )


# --------------------------------------------------------------------------
# D. The session cookie
# --------------------------------------------------------------------------

SECTION_D = "D. The session cookie is not hardened"


def check_cookie(report: Report) -> None:
    text = read_text(SESSION)
    code = strip_comments(text)

    at = code.find("COOKIE_OPTIONS")
    brace = code.find("{", at) if at != -1 else -1
    options = balanced_span(code, brace, "{", "}") if brace != -1 else ""

    if not options:
        report.violation(
            SECTION_D, Finding(SESSION, 0, "COOKIE_OPTIONS could not be found or parsed")
        )
        return

    if not re.search(r"httpOnly\s*:\s*true", options):
        report.violation(
            SECTION_D,
            Finding(
                SESSION,
                0,
                "httpOnly is not true - any XSS on the page can then read the "
                "session token out of document.cookie",
            ),
        )

    same_site = re.search(r"sameSite\s*:\s*'(\w+)'", options)
    if same_site is None:
        report.violation(SECTION_D, Finding(SESSION, 0, "sameSite is not set"))
    elif same_site.group(1) not in ("lax", "strict"):
        report.violation(
            SECTION_D,
            Finding(
                SESSION,
                0,
                f"sameSite is {same_site.group(1)!r}; only 'lax' or 'strict' "
                "defends the PIN routes against cross-site submission",
            ),
        )

    if "secure" not in options:
        report.violation(
            SECTION_D, Finding(SESSION, 0, "the cookie has no `secure` setting at all")
        )

    # Both setters must inherit the hardened options rather than re-declaring
    # a looser set of their own.
    for fn in ("setSessionCookie", "clearSessionCookie"):
        body = function_body(code, f"export async function {fn}")
        if not body:
            report.violation(SECTION_D, Finding(SESSION, 0, f"{fn} is missing"))
        elif "COOKIE_OPTIONS" not in body:
            report.violation(
                SECTION_D,
                Finding(
                    SESSION,
                    0,
                    f"{fn} sets the cookie without spreading COOKIE_OPTIONS, so "
                    "its flags are not the audited ones",
                ),
            )

    if not report.violations.get(SECTION_D):
        flags = same_site.group(1) if same_site else "?"
        report.confirm(
            f"D. Session cookie is httpOnly, sameSite='{flags}', secure in "
            "production, and both setters spread the same options."
        )


# --------------------------------------------------------------------------
# E. The AUTH_SECRET fallback still warns
# --------------------------------------------------------------------------

SECTION_E = "E. The AUTH_SECRET -> DATABASE_URL fallback is silent"


def check_secret_fallback(report: Report) -> None:
    text = read_text(ENV)
    code = strip_comments(text)
    body = function_body(code, "export function authSecret")

    if not body:
        report.violation(SECTION_E, Finding(ENV, 0, "authSecret is missing"))
        return

    if "hkdfSync" not in body:
        # No derivation at all is not a violation of this claim - it is a
        # stricter deployment. Say so and stop.
        report.confirm(
            "E. authSecret performs no DATABASE_URL derivation at all, so there "
            "is no silent fallback to warn about."
        )
        return

    warn_at = body.find("console.warn")
    derive_at = body.find("hkdfSync")

    if warn_at == -1:
        report.violation(
            SECTION_E,
            Finding(
                ENV,
                0,
                "authSecret derives a session key from DATABASE_URL without "
                "console.warn. The fallback is a convenience, and a convenience "
                "that says nothing becomes a default nobody knows they chose.",
            ),
        )
    elif warn_at > derive_at:
        report.violation(
            SECTION_E,
            Finding(
                ENV,
                0,
                "the warning is emitted after the key is derived and returned, "
                "so it can never be reached",
            ),
        )
    elif "AUTH_SECRET" not in body[warn_at : warn_at + 400]:
        report.violation(
            SECTION_E,
            Finding(ENV, 0, "the warning does not name AUTH_SECRET, so it is not actionable"),
        )

    if not report.violations.get(SECTION_E):
        report.confirm(
            "E. authSecret warns, naming AUTH_SECRET, before returning an "
            "HKDF-derived key."
        )


# --------------------------------------------------------------------------
# F. The unknown-name branch still costs a key derivation
# --------------------------------------------------------------------------

SECTION_F = "F. An unknown trainer name is answered without doing the work"


def check_enumeration_timing(report: Report) -> None:
    text = read_text(ACCOUNTS)
    code = strip_comments(text)
    login = function_body(code, "export async function loginWithPin")

    if not login:
        report.violation(SECTION_F, Finding(ACCOUNTS, 0, "loginWithPin is missing"))
        return

    # The branch taken when the row is absent or holds no PIN hash.
    match = re.search(r"if\s*\(\s*!\s*trainer\?\.\s*pin_hash\s*\)", login)
    if match is None:
        report.violation(
            SECTION_F,
            Finding(
                ACCOUNTS,
                0,
                "could not find the `if (!trainer?.pin_hash)` branch; this audit "
                "can no longer tell whether an unknown name short-circuits",
            ),
        )
        return

    tail = login[match.end() :]
    brace = tail.find("{")
    single_statement = tail[: tail.find(";") + 1]
    branch = balanced_span(tail, brace, "{", "}") if 0 <= brace < tail.find(";") else single_statement

    if "verifyPin" not in branch and "scrypt" not in branch:
        report.violation(
            SECTION_F,
            Finding(
                ACCOUNTS,
                0,
                "the unknown-name branch returns without deriving a key. The "
                "bodies match, but the clock does not: a wrong PIN pays ~45ms of "
                "scrypt and an unknown name pays none, which enumerates trainer "
                "names just as well as a different error message would. Verify "
                "the offered PIN against a decoy hash before returning.",
            ),
        )
    else:
        report.confirm(
            "F. The unknown-name branch verifies against a decoy hash, so a miss "
            "costs the same key derivation as a wrong PIN."
        )


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------


def render(report: Report, quiet: bool) -> str:
    out: list[str] = []
    add = out.append

    add("=" * 74)
    add("ACCOUNT SECURITY AUDIT - Mathmon Battle League")
    add("=" * 74)
    add("")
    add(f"Files examined: {len(AUTH_SOURCES)} auth source(s) plus {CLAUDE_MD}")
    for path in AUTH_SOURCES:
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
        add("  These live in src/lib/server/db.integration.test.ts instead, and")
        add("  need TEST_DATABASE_URL to run:")
        add("")
        add("    - that five wrong PINs really lock the row, and the sixth")
        add("      attempt is refused even with the correct PIN;")
        add("    - that the lock expires, and that a success resets the count;")
        add("    - that an unknown name and a wrong PIN return equal values.")
        add("")
        add("  And these are proved by nothing here, by design:")
        add("")
        add("    - constant-time behaviour under a real attacker's sampling;")
        add("    - the lockout under concurrent requests (two failures racing")
        add("      read-modify-write on failed_logins can cost one attempt);")
        add("    - rate limiting of the endpoint as a whole, which is per-account")
        add("      only - see the note in the task report.")
        add("")

    add("=" * 74)
    if report.failed:
        add(f"RESULT: FAIL - {report.violation_count} violation(s)")
        add("")
        add("The account-layer security claims in CLAUDE.md are not all true of")
        add("the code as it currently stands.")
    else:
        add("RESULT: PASS")
        add("")
        add("No PIN reaches a log or a response body; scrypt with a per-account")
        add("salt protects the stored value; the lockout constants match the")
        add("documentation and are used; the session cookie is httpOnly and")
        add("sameSite; the AUTH_SECRET fallback still warns; and an unknown")
        add("trainer name costs the same key derivation as a wrong PIN.")
    add("=" * 74)
    return "\n".join(out)


def main(argv: list[str]) -> int:
    quiet = "--quiet" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--quiet"]
    if unknown:
        sys.stderr.write(f"audit_auth: unknown argument(s): {' '.join(unknown)}\n")
        sys.stderr.write(__doc__ or "")
        return 2

    report = Report()
    check_no_leak(report)
    check_kdf(report)
    check_lockout(report)
    check_cookie(report)
    check_secret_fallback(report)
    check_enumeration_timing(report)

    sys.stdout.write(render(report, quiet) + "\n")
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
