#!/usr/bin/env python3
"""Audit the response headers: what the browser is actually told, and by whom.

`scripts/audit_api.py` audits what a route does with a request - the body
limits, the throttle, the cookie flags, the error vocabulary.
`scripts/audit_auth.py` audits the account behind it - the PIN, the KDF, the
lockout, non-enumerability. Neither has ever looked at a *response header*, and
nothing in this repository checked that a header promised in a config reaches a
browser at all. For most of this app's life `next.config.ts` sent three headers
and no Content-Security-Policy, which is the gap this script exists to keep
closed.

A CSP is unusually easy to get wrong in a way that still looks right. Four of
its directives - `base-uri`, `form-action`, `frame-ancestors`, `object-src` -
do NOT inherit from `default-src`, so a policy can read as locked down and
leave `<base href="//attacker/">` free to repoint every relative script URL on
the page. And a policy can be widened one token at a time until it forbids
nothing while still being a Content-Security-Policy header that a checklist
ticks off. So this script does not merely assert that a CSP exists.

Six properties:

  A. The policy exists, is attached to every path, and parses - one value per
     directive name, no empties, no unknown names, no unquoted keywords.
  B. No directive defeats itself: no `'unsafe-eval'`, no wildcard `*` or bare
     scheme in a fetch directive, no `data:` in script-src, no `'unsafe-inline'`
     in script-src without a nonce or hash beside it, no `'strict-dynamic'`
     without one either, no `http:` source anywhere.
  C. The four non-inheriting directives are set explicitly, because omitting
     them means "anything" no matter how strict `default-src` looks.
  D. The tight values this particular app can afford are actually taken:
     `connect-src` and `img-src` are same-origin at most, which is what makes
     the policy an exfiltration lock rather than a decoration.
  E. The companion headers are present and deny what a maths game never needs,
     and the three headers that predate this script are still there.
  F. The static-export shape's asymmetry is stated in the config rather than
     quietly assumed away - `output: 'export'` never calls `headers()`, so the
     Pages deployment gets no CSP at all, and a reader must be told so.

The policy is not scraped out of the file with a regular expression. This
script *evaluates* `next.config.ts` with node and reads the headers the config
really returns, for both deployment shapes - so it is checking the deployed
value rather than a hopeful pattern match, and it cannot be fooled by a
constant that is defined and then never used.

What this script CANNOT prove: that the header leaves a real server, or that
the app still works underneath it. A config value nobody serves is not a
header. That half is `e2e/headers.spec.ts`, which reads the CSP off a live
response from `next start` and then plays the game under it - including a cold,
un-onboarded first load, which is the only pass where the server-rendered
shell's own inline style attributes are parsed and therefore the only pass in
which a `style-src` violation can appear at all.

Standard library only. No network, no clock, no randomness, no git. Output is
derived from sorted inputs and is byte-identical across runs.

Usage:
    python3 scripts/audit_headers.py            # audit; exit 1 on violation
    python3 scripts/audit_headers.py --quiet    # violations and result only

Exit codes:  0 = clean   1 = violations found   2 = could not run the audit
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CONFIG = "next.config.ts"

SECTION_A = "A. The policy exists, covers every path, and parses"
SECTION_B = "B. No directive defeats itself"
SECTION_C = "C. The four non-inheriting directives are set explicitly"
SECTION_D = "D. The exfiltration channels are shut"
SECTION_E = "E. The companion headers are present and deny the right things"
SECTION_F = "F. The static-export shape's asymmetry is stated, not assumed"

# Directives that do NOT fall back to default-src. Leaving one out does not
# inherit a safe value; it inherits nothing, which means "anything".
NON_INHERITING = ("base-uri", "form-action", "frame-ancestors", "object-src")

# Directives that fetch code or content, and are therefore the ones a wildcard
# actually costs something in.
FETCH_DIRECTIVES = (
    "connect-src",
    "default-src",
    "font-src",
    "frame-src",
    "img-src",
    "manifest-src",
    "media-src",
    "object-src",
    "script-src",
    "script-src-attr",
    "script-src-elem",
    "style-src",
    "style-src-attr",
    "style-src-elem",
    "worker-src",
)

# Every directive name this script will accept. A typo in a directive name is
# silently ignored by browsers, which is the quietest possible way to ship a
# policy that does less than it reads as doing.
KNOWN_DIRECTIVES = frozenset(
    FETCH_DIRECTIVES
    + NON_INHERITING
    + (
        "base-uri",
        "child-src",
        "form-action",
        "frame-ancestors",
        "prefetch-src",
        "report-to",
        "report-uri",
        "require-trusted-types-for",
        "sandbox",
        "trusted-types",
        "upgrade-insecure-requests",
    )
)

# Directives that legitimately carry no source list.
VALUELESS_DIRECTIVES = frozenset({"upgrade-insecure-requests", "sandbox"})

# Keywords that must be single-quoted to mean anything. `script-src self` is a
# host named "self", not the origin, and it silently allows nothing useful.
MUST_BE_QUOTED = (
    "self",
    "none",
    "unsafe-inline",
    "unsafe-eval",
    "unsafe-hashes",
    "strict-dynamic",
    "wasm-unsafe-eval",
    "report-sample",
    "inline-speculation-rules",
)

# Tokens that hand back what the policy is for.
SELF_DEFEATING = ("'unsafe-eval'", "'wasm-unsafe-eval'")

# The one concession this app cannot currently avoid, recorded here rather than
# waved through by a check that does not look.
#
# The App Router serves its RSC flight payload as inline <script> tags whose
# contents differ per route and per build. A nonce needs dynamic rendering that
# these nine statically prerendered routes do not do (and that the static-export
# shape cannot do at all); a hash needs the HTML, which does not exist when
# `headers()` runs. Both were measured against a real browser before this
# constant was written - see the comment in next.config.ts.
#
# It is pinned to an EXACT source list. That is the whole point: the concession
# is 'unsafe-inline' and nothing else, so this cannot become the line somebody
# appends an origin to. Adding a nonce or a hash removes the concession
# entirely, and the audit then reports a plain pass instead.
ACCEPTED_INLINE = {
    "script-src": ("'self'", "'unsafe-inline'"),
    # Inline style ATTRIBUTES only, for the server-rendered shell. Weaker than
    # the script concession by a wide margin - a style attribute cannot execute
    # - but still a concession, so it is stated rather than assumed.
    "style-src": ("'self'", "'unsafe-inline'"),
}

# The capabilities a maths game has no code path to. Each must be denied with
# an empty allowlist.
DENIED_CAPABILITIES = (
    "camera",
    "display-capture",
    "geolocation",
    "microphone",
    "payment",
    "serial",
    "usb",
)

# Headers that must be on every response, with the value each must carry.
# X-Frame-Options / nosniff / Referrer-Policy predate this script; they are
# asserted here so that adding a CSP cannot quietly drop one of them.
REQUIRED_HEADERS = {
    "content-security-policy": None,  # checked directive by directive below
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": None,  # checked capability by capability below
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
}

# Sentences the config must contain, so that the Pages gap is documented rather
# than inferred. Matched case-insensitively on collapsed whitespace.
STATIC_GAP_PHRASES = (
    "gets NONE of the headers above",
    "Not a weaker CSP - no CSP",
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
    concessions: list[str] = field(default_factory=list)

    def violation(self, section: str, finding: Finding) -> None:
        self.violations.setdefault(section, []).append(finding)

    def confirm(self, line: str) -> None:
        self.confirmations.append(line)

    def concede(self, line: str) -> None:
        self.concessions.append(line)

    @property
    def failed(self) -> bool:
        return any(self.violations.values())

    @property
    def violation_count(self) -> int:
        return sum(len(v) for v in self.violations.values())


# --------------------------------------------------------------------------
# Reading the config
#
# The config is evaluated rather than pattern-matched. A regex over the source
# would happily approve a beautifully strict policy string that nothing ever
# returns, which is the exact failure mode - a value in a config that never
# reaches a browser - this script was written to catch.
# --------------------------------------------------------------------------

# Prints the resolved headers as JSON on stdout. Node's type-stripping runs the
# TypeScript directly; the config's only import is `import type`, which strips
# to nothing.
READER = """
const shape = process.argv[1];
import('./next.config.ts')
  .then(async (module) => {
    const config = module.default;
    const groups = typeof config.headers === 'function' ? await config.headers() : null;
    process.stdout.write(
      JSON.stringify({
        shape,
        output: config.output ?? null,
        hasHeadersFn: typeof config.headers === 'function',
        groups,
      }),
    );
  })
  .catch((error) => {
    process.stderr.write(String((error && error.stack) || error));
    process.exit(3);
  });
"""


def read_text(path: str) -> str:
    try:
        with open(os.path.join(REPO_ROOT, path), "rb") as handle:
            return handle.read().decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        sys.stderr.write(f"audit_headers: cannot read {path}: {error}\n")
        raise SystemExit(2) from error


def evaluate_config(static_export: bool) -> dict:
    """Runs `next.config.ts` and returns what it resolves to."""
    shape = "static" if static_export else "server"
    env = dict(os.environ)
    env.pop("PAGES_BASE_PATH", None)
    if static_export:
        env["STATIC_EXPORT"] = "1"
    else:
        env.pop("STATIC_EXPORT", None)

    argv = [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "--eval",
        READER,
        shape,
    ]
    try:
        completed = subprocess.run(
            argv,
            cwd=REPO_ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        sys.stderr.write(f"audit_headers: cannot run node: {error}\n")
        raise SystemExit(2) from error

    if completed.returncode != 0:
        sys.stderr.write(
            f"audit_headers: evaluating {CONFIG} for the {shape} shape failed "
            f"(exit {completed.returncode}):\n"
        )
        sys.stderr.write(completed.stderr.decode("utf-8", "replace") + "\n")
        raise SystemExit(2)

    try:
        return json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        sys.stderr.write(f"audit_headers: {CONFIG} produced unreadable output: {error}\n")
        raise SystemExit(2) from error


def header_map(groups: object) -> dict[str, str]:
    """Lower-cased header name -> value, for the group covering every path."""
    if not isinstance(groups, list):
        return {}
    found: dict[str, str] = {}
    for group in groups:
        if not isinstance(group, dict):
            continue
        for entry in group.get("headers") or []:
            if isinstance(entry, dict) and "key" in entry and "value" in entry:
                found[str(entry["key"]).lower()] = str(entry["value"])
    return found


def covered_sources(groups: object) -> list[str]:
    if not isinstance(groups, list):
        return []
    return sorted(str(g.get("source", "")) for g in groups if isinstance(g, dict))


def parse_csp(policy: str) -> tuple[dict[str, list[str]], list[str]]:
    """Directive name -> source list, plus the malformed pieces found."""
    directives: dict[str, list[str]] = {}
    problems: list[str] = []
    for raw in policy.split(";"):
        chunk = raw.strip()
        if not chunk:
            # A trailing `;` is legal and idiomatic; an empty piece in the
            # middle means two semicolons in a row, which is a typo.
            continue
        parts = chunk.split()
        name = parts[0].lower()
        values = parts[1:]
        if name in directives:
            problems.append(f"directive '{name}' appears more than once")
            continue
        if name not in KNOWN_DIRECTIVES:
            problems.append(f"unknown directive '{name}' (browsers ignore it silently)")
        if not values and name not in VALUELESS_DIRECTIVES:
            problems.append(f"directive '{name}' has no source list")
        for value in values:
            if value.lower() in MUST_BE_QUOTED:
                problems.append(
                    f"directive '{name}' has bare '{value}' where "
                    f"\"'{value}'\" was meant (a bare word is a hostname)"
                )
        directives[name] = values
    return directives, problems


def has_nonce_or_hash(values: list[str]) -> bool:
    return any(
        value.startswith("'nonce-") or value.startswith(("'sha256-", "'sha384-", "'sha512-"))
        for value in values
    )


def config_line(text: str, needle: str) -> int:
    at = text.find(needle)
    return text.count("\n", 0, at) + 1 if at != -1 else 0


# --------------------------------------------------------------------------
# Properties
# --------------------------------------------------------------------------


def check_policy_parses(report: Report, headers: dict[str, str], groups: object) -> None:
    policy = headers.get("content-security-policy", "")
    if not policy:
        report.violation(
            SECTION_A,
            Finding(
                CONFIG,
                0,
                "the server build sends no Content-Security-Policy header at all",
            ),
        )
        return

    sources = covered_sources(groups)
    if not any(source in ("/:path*", "/(.*)", "/:path*/") for source in sources):
        report.violation(
            SECTION_A,
            Finding(
                CONFIG,
                0,
                "no header group covers every path; a CSP on some routes is a "
                f"CSP on none of the ones that matter (sources: {', '.join(sources) or 'none'})",
            ),
        )

    directives, problems = parse_csp(policy)
    for problem in problems:
        report.violation(SECTION_A, Finding(CONFIG, 0, problem))

    if not report.violations.get(SECTION_A):
        report.confirm(
            f"A. A Content-Security-Policy of {len(directives)} directives is attached to "
            f"{', '.join(sources)}; every directive name is known, quoted and unique."
        )


def check_self_defeating(report: Report, headers: dict[str, str]) -> None:
    policy = headers.get("content-security-policy", "")
    if not policy:
        return
    directives, _ = parse_csp(policy)

    for name, values in sorted(directives.items()):
        lowered = [value.lower() for value in values]

        for token in SELF_DEFEATING:
            if token in lowered:
                report.violation(
                    SECTION_B,
                    Finding(CONFIG, 0, f"{name} allows {token}, which hands back arbitrary code"),
                )

        if name in FETCH_DIRECTIVES:
            for value in lowered:
                if value == "*" or value.startswith("*."):
                    report.violation(
                        SECTION_B,
                        Finding(CONFIG, 0, f"{name} contains the wildcard '{value}'"),
                    )
                if value in ("http:", "https:", "data:", "blob:", "filesystem:"):
                    # A bare scheme allows every host that speaks it.
                    if not (name == "img-src" and value in ("data:", "blob:")):
                        report.violation(
                            SECTION_B,
                            Finding(
                                CONFIG,
                                0,
                                f"{name} allows the bare scheme '{value}', which is every "
                                "host that speaks it",
                            ),
                        )
                if value.startswith("http://"):
                    report.violation(
                        SECTION_B,
                        Finding(CONFIG, 0, f"{name} allows the cleartext origin '{value}'"),
                    )

        # 'unsafe-inline' with no nonce or hash beside it. Allowed for exactly
        # the directives and exactly the source lists recorded in
        # ACCEPTED_INLINE, and nowhere else - including script-src-elem, which
        # overrides script-src for <script> elements and would otherwise be a
        # way to reintroduce the same hole under a different name.
        if "'unsafe-inline'" in lowered and not has_nonce_or_hash(values):
            accepted = ACCEPTED_INLINE.get(name)
            if accepted is None:
                report.violation(
                    SECTION_B,
                    Finding(
                        CONFIG,
                        0,
                        f"{name} allows 'unsafe-inline' with no nonce or hash beside it, and "
                        "is not one of the two directives this app has a measured reason to "
                        "concede it on",
                    ),
                )
            elif tuple(lowered) != accepted:
                report.violation(
                    SECTION_B,
                    Finding(
                        CONFIG,
                        0,
                        f"{name} concedes 'unsafe-inline' AND widens beyond {' '.join(accepted)} "
                        f"to {' '.join(values)}. The concession is 'unsafe-inline' alone; with "
                        "inline script already allowed, an extra source here is given away for "
                        "nothing. Add a nonce instead",
                    ),
                )
            else:
                report.concede(
                    f"{name}: {' '.join(values)} - no nonce or hash. "
                    + (
                        "An injected inline <script> WOULD run; connect-src and img-src are "
                        "what stop it phoning home."
                        if name == "script-src"
                        else "Server-rendered style attributes only; a style attribute cannot "
                        "execute."
                    )
                )

        if name == "script-src":
            if "data:" in lowered:
                report.violation(
                    SECTION_B,
                    Finding(CONFIG, 0, "script-src allows data:, which is an XSS vector outright"),
                )
            if "'strict-dynamic'" in lowered and not has_nonce_or_hash(values):
                report.violation(
                    SECTION_B,
                    Finding(
                        CONFIG,
                        0,
                        "script-src uses 'strict-dynamic' with no nonce or hash, which makes "
                        "'self' be ignored and refuses every script on the page",
                    ),
                )

    if not report.violations.get(SECTION_B):
        report.confirm(
            "B. No 'unsafe-eval', no wildcard or bare scheme in a fetch directive, no "
            "cleartext origin, no data: in script-src. The two 'unsafe-inline' "
            "concessions are pinned to an exact source list and listed below."
        )


def check_non_inheriting(report: Report, headers: dict[str, str]) -> None:
    policy = headers.get("content-security-policy", "")
    if not policy:
        return
    directives, _ = parse_csp(policy)
    for name in NON_INHERITING:
        if name not in directives:
            report.violation(
                SECTION_C,
                Finding(
                    CONFIG,
                    0,
                    f"{name} is not set. It does not fall back to default-src, so leaving "
                    "it out allows everything however strict the rest of the policy reads",
                ),
            )
    if not report.violations.get(SECTION_C):
        report.confirm(
            "C. base-uri, form-action, frame-ancestors and object-src are all set "
            "explicitly, so none of them silently means 'anything'."
        )


def check_exfiltration(report: Report, headers: dict[str, str]) -> None:
    policy = headers.get("content-security-policy", "")
    if not policy:
        return
    directives, _ = parse_csp(policy)

    for name in ("connect-src", "img-src"):
        values = directives.get(name)
        if values is None:
            report.violation(
                SECTION_C if name in NON_INHERITING else SECTION_D,
                Finding(
                    CONFIG,
                    0,
                    f"{name} is not set, so it inherits default-src. This app can afford "
                    "same-origin, and this directive is what stops injected code sending "
                    "a child's profile somewhere else",
                ),
            )
            continue
        allowed = {value.lower() for value in values} - {"'none'", "'self'"}
        if allowed:
            report.violation(
                SECTION_D,
                Finding(
                    CONFIG,
                    0,
                    f"{name} allows {', '.join(sorted(allowed))} beyond this origin. The app "
                    "loads no third-party scripts, fonts, images or media, so anything here "
                    "is an exfiltration channel bought for nothing",
                ),
            )

    if not report.violations.get(SECTION_D):
        report.confirm(
            "D. connect-src and img-src are same-origin at most: injected code has "
            "nowhere to send a session cookie or a saved profile."
        )


def check_companion_headers(report: Report, headers: dict[str, str]) -> None:
    for name in sorted(REQUIRED_HEADERS):
        expected = REQUIRED_HEADERS[name]
        actual = headers.get(name)
        if actual is None:
            report.violation(SECTION_E, Finding(CONFIG, 0, f"the {name} header is not sent"))
            continue
        if expected is not None and actual != expected:
            report.violation(
                SECTION_E,
                Finding(CONFIG, 0, f"{name} is {actual!r}, expected {expected!r}"),
            )

    permissions = headers.get("permissions-policy", "")
    if permissions:
        granted = {}
        for raw in permissions.split(","):
            chunk = raw.strip()
            if not chunk or "=" not in chunk:
                if chunk:
                    report.violation(
                        SECTION_E,
                        Finding(CONFIG, 0, f"Permissions-Policy entry {chunk!r} has no allowlist"),
                    )
                continue
            feature, _, allowlist = chunk.partition("=")
            granted[feature.strip().lower()] = allowlist.strip()
        for capability in DENIED_CAPABILITIES:
            allowlist = granted.get(capability)
            if allowlist is None:
                report.violation(
                    SECTION_E,
                    Finding(
                        CONFIG,
                        0,
                        f"Permissions-Policy does not mention '{capability}', which this "
                        "app has no code path to and should therefore deny",
                    ),
                )
            elif allowlist not in ("()", "( )"):
                report.violation(
                    SECTION_E,
                    Finding(
                        CONFIG,
                        0,
                        f"Permissions-Policy grants '{capability}' to {allowlist} rather "
                        "than denying it with an empty allowlist",
                    ),
                )

    if not report.violations.get(SECTION_E):
        report.confirm(
            "E. Permissions-Policy denies "
            + ", ".join(DENIED_CAPABILITIES)
            + "; Cross-Origin-Opener-Policy is same-origin; nosniff, Referrer-Policy "
            "and X-Frame-Options all survived the change."
        )


def check_static_shape(report: Report, static_shape: dict, text: str) -> None:
    if static_shape.get("output") != "export":
        report.violation(
            SECTION_F,
            Finding(
                CONFIG,
                0,
                "STATIC_EXPORT=1 does not produce output: 'export'; this audit can no "
                "longer tell the two deployment shapes apart",
            ),
        )

    if static_shape.get("hasHeadersFn"):
        report.violation(
            SECTION_F,
            Finding(
                CONFIG,
                0,
                "the static-export shape defines headers(). `output: 'export'` never "
                "calls it, so this would read as protection the Pages deployment does "
                "not have",
            ),
        )

    collapsed = " ".join(text.split())
    for phrase in STATIC_GAP_PHRASES:
        if " ".join(phrase.split()).lower() not in collapsed.lower():
            report.violation(
                SECTION_F,
                Finding(
                    CONFIG,
                    config_line(text, "STATIC_EXPORT"),
                    f"the config no longer says {phrase!r}. The Pages deployment gets no "
                    "CSP whatsoever, and a config that stops saying so invites the next "
                    "reader to assume both shapes are equally protected",
                ),
            )

    if not report.violations.get(SECTION_F):
        report.confirm(
            "F. The static-export shape defines no headers() and the config says plainly "
            "that the Pages deployment therefore has no CSP at all."
        )


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------


def render(report: Report, headers: dict[str, str], quiet: bool) -> str:
    out: list[str] = []
    add = out.append

    add("=" * 74)
    add("RESPONSE HEADER AUDIT - Mathmon Battle League")
    add("=" * 74)
    add("")
    add(f"Config evaluated: {CONFIG} (both deployment shapes)")
    add("")
    add("Headers the server build sends on every path:")
    for name in sorted(headers):
        add(f"  {name}: {headers[name]}")
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

    if not quiet and report.concessions:
        add("-" * 74)
        add("ACCEPTED CONCESSIONS - read these before calling the policy strict")
        add("-" * 74)
        add("")
        for line in report.concessions:
            add(f"  {line}")
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
        add("  This reads the config, not a socket. A header that parses")
        add("  perfectly and is never served is still not a header:")
        add("")
        add("    - e2e/headers.spec.ts reads the CSP off a live `next start`")
        add("      response and then plays the game under it, cold and warm.")
        add("      The cold pass is the load-bearing one: once a profile")
        add("      exists React re-renders through CSSOM, which CSP never")
        add("      sees, so a style-src violation can only appear on a first")
        add("      un-onboarded load.")
        add("")
        add("  And this is proved by nothing, by design:")
        add("")
        add("    - the static-export (GitHub Pages) deployment, which has no")
        add("      CSP at all. Property F asserts that the config SAYS so; it")
        add("      cannot make GitHub Pages send a header it has no way to")
        add("      configure. That shape ships without the account layer, so")
        add("      there is no session cookie and no PIN there to steal.")
        add("    - script-src 'unsafe-inline'. It is required by the App")
        add("      Router's own flight-data bootstrap and this policy does not")
        add("      defend against an injected inline script. It defends")
        add("      against that script reaching the network.")
        add("    - whatever the host adds or strips above this app. Vercel")
        add("      sends its own HSTS; a proxy could send a second CSP, and")
        add("      two CSP headers intersect rather than override.")
        add("")

    add("=" * 74)
    if report.failed:
        add(f"RESULT: FAIL - {report.violation_count} violation(s)")
        add("")
        add("A response header promises less than it appears to.")
    else:
        add("RESULT: PASS")
        add("")
        add("The policy exists on every path and parses; nothing in it defeats")
        add("itself; the four directives that do not inherit are set explicitly;")
        add("connect-src and img-src leave injected code nowhere to send data;")
        add("the companion headers deny what a maths game never needs; and the")
        add("static-export shape's missing headers are stated, not assumed away.")
    add("=" * 74)
    return "\n".join(out)


def main(argv: list[str]) -> int:
    quiet = "--quiet" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--quiet"]
    if unknown:
        sys.stderr.write(f"audit_headers: unknown argument(s): {' '.join(unknown)}\n")
        sys.stderr.write(__doc__ or "")
        return 2

    text = read_text(CONFIG)
    server_shape = evaluate_config(static_export=False)
    static_shape = evaluate_config(static_export=True)
    headers = header_map(server_shape.get("groups"))

    report = Report()
    check_policy_parses(report, headers, server_shape.get("groups"))
    check_self_defeating(report, headers)
    check_non_inheriting(report, headers)
    check_exfiltration(report, headers)
    check_companion_headers(report, headers)
    check_static_shape(report, static_shape, text)

    sys.stdout.write(render(report, headers, quiet) + "\n")
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
