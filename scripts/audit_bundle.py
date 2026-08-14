#!/usr/bin/env python3
"""Measure what a child's device actually downloads, and fail when it grows.

Why this exists
---------------
The player is seven, and the realistic device is a hand-me-down iPad on a slow
connection. This repository ships *no* image, font or audio assets at all - the
creatures are procedural geometry, and `scripts/audit_assets.py` proves that
about the source tree. Which means the payload is essentially JavaScript, and
JavaScript weight is the single thing most likely to make the game feel broken
on a cheap device.

That regression is invisible in code review. Someone imports a date library
into a component to format one streak label, the first load doubles, every unit
test still passes, every E2E test still passes, the screenshots look identical,
and the build is green. Nothing in this repository measured the payload until
this script existed.

So the payload is now a committed number. `BUDGETS` below records what the app
measured on the day it was written, and the ceiling it may not cross. Raising a
ceiling is a one-line diff a human has to write on purpose, next to the
measurement it replaces.

What it measures
----------------
The real build output, never an estimate. Every byte reported is
`os.path.getsize` of a file Next.js actually emitted, or `gzip.compress` of that
file's bytes.

First load is taken from the *prerendered HTML*, which is the literal truth
about what a browser fetches for a cold visit to a route: every `<script src>`
that is not `noModule`, every stylesheet `<link>`, the document itself, and the
manifest and icon it references. Where Next.js also writes
`.next/diagnostics/route-bundle-stats.json`, this script cross-checks its own
per-route JS total against Next's and stops with exit 2 if the two disagree -
two independent readings of the same build, so a parsing mistake here cannot
quietly become a smaller number.

Both raw and gzipped sizes are reported. Gzip is what actually crosses the
network, so gzip is what the transfer budgets are set on; raw is what the
device must parse and hold, so the emitted-asset budget is set on raw.

Which build shape
-----------------
The **default server build** (`npm run build`, read from `.next/`). That is what
`npm run build` produces with no flags, what the Vercel deployment serves, and
what CI runs on every push, so it is the shape a regression will actually be
introduced against.

The static export (`STATIC_EXPORT=1`, output in `out/`) is the same client
bundle wrapped differently, and `--shape static` measures it against the same
budgets - but it is not the default, because producing it requires moving
`src/app/api` out of the tree, and an audit must not mutate the repository it is
auditing. See `.github/workflows/pages.yml`.

Also asserted: the no-bundled-media property, in the build output
----------------------------------------------------------------
`scripts/audit_assets.py` proves the *repository* contains no raster, font or
audio file. This proves the same thing about what actually ships, which is not
the same claim: a bundler can inline a font or a PNG as a `data:` URI inside a
JavaScript chunk, and no file with a telltale extension ever appears in the
tree. So the emitted assets are checked twice - by extension, and by scanning
every emitted `.js` and `.css` for embedded media `data:` URIs and `@font-face`.

`data:image/svg+xml` is allowed, and `public/icon.svg` (the favicon and PWA
manifest icon) is a legitimate SVG served at the deployment root. An SVG emitted
*into the bundle* is not: it would mean an image asset got imported.

Diagnosability
--------------
A budget that only says "red" makes people raise the budget. So the per-route
table separates the shared baseline every route pays from each route's own
cost, and the chunk table lists every first-load chunk largest-first.

Module-level attribution is deliberately absent, and that is a limit of the
build rather than a choice: Turbopack strips module ids in a production build
and emits no client source maps, so there is nothing in `.next/static` to
attribute bytes to. Building once with `productionBrowserSourceMaps: true` in
`next.config.ts` would make that possible; it is not enabled today, and turning
it on ships maps to users, so it belongs in a diagnostic build rather than in
the default one.

Usage
-----
    python3 scripts/audit_bundle.py                  # measure an existing build
    python3 scripts/audit_bundle.py --build          # run `npm run build` first
    python3 scripts/audit_bundle.py --shape static   # measure out/ instead
    python3 scripts/audit_bundle.py --quiet          # budgets and verdict only

Exit status
-----------
0  every budget respected and no bundled media.
1  a budget was exceeded, or a property was violated. Both are named.
2  the audit could not run - no build to read, a build that failed, or the two
   independent readings disagreeing. A failure to measure is never a pass.

Determinism
-----------
Standard library only; no network, no clock, no randomness. Everything printed
is sorted, and nothing hash-derived is printed at all: content-hashed chunk
filenames change on every build even when the bytes do not move, so chunks are
identified by which routes load them and by their size rank, never by name. Ties
in size are broken by a SHA-256 of the file's contents, which is computed and
never shown - so the ordering is stable for identical bytes without putting a
churning token in the output. Absolute paths, the build id and the emitted
directory names are likewise never printed.

Two honest caveats, neither of which can decide a verdict:

- Gzipped sizes come from the local zlib, and a different zlib build can differ
  by a handful of bytes on the same input. Two runs on one machine against one
  build are byte-identical - `cmp` proves it - but the last digit of a gzip
  figure is not a cross-machine constant.
- The prerendered documents embed the build id, which is new on every build. So
  rebuilding *identical source* moves the document's compressed size by a byte
  or three, and with it the cold-transfer total. The chunk sizes do not move;
  only the HTML does.

Both are single-digit byte effects against budget headroom of twelve to thirteen
thousand bytes.

Note on shelling out: `npm run build` is an explicit argv list whose return code
is checked directly. Nothing is piped through `head`/`tail`; a pipeline reports
the status of its last command, and that has already produced a false all-clear
in this repository once.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------
# The budget
# --------------------------------------------------------------------------
#
# How the ceilings below were chosen, once, on purpose:
#
# The headroom is deliberately NARROW - roughly 8% on the transfer numbers -
# and the reason is the failure this script exists to catch. The regression is
# "someone imported a library". So the headroom has to be smaller than the
# smallest library anybody plausibly imports by accident, or the check cannot
# see the very thing it is for. Gzipped, the usual suspects cost:
#
#     moment              ~72 KB      chart.js          ~60 KB
#     framer-motion       ~35 KB      lodash            ~25 KB
#     date-fns (broad)    ~20 KB      axios             ~13 KB
#
# ~13 KB of headroom on first-load JS trips every one of those. It is also more
# than a normal change costs here: the heaviest single route's own code, on top
# of the shared baseline, is under 20 KB gzipped for the entire battle screen,
# and most routes cost 7-8 KB. So ordinary feature work fits, and a library does
# not - which is exactly the line worth drawing.
#
# The other half of the reasoning is the child, not the diff. At the ceiling
# below, a cold visit is ~192 KB over the wire. On the ~400 kbit/s a congested
# phone connection really delivers that is about four seconds before anything is
# interactive, which is already at the edge of what a seven-year-old will wait
# through. There is no version of "we grew 40% and it is fine".
#
# `measured` is what the app actually measured when each ceiling was set. It is
# recorded so that raising a limit forces you to also write down the new
# reality beside it, and so that a reviewer can see the headroom in the diff
# rather than having to run the build to work it out.


@dataclass(frozen=True)
class Budget:
    key: str
    limit: int
    measured: int
    unit: str  # "gzip" (crosses the network) or "raw" (parsed and held)
    what: str
    why: str

    @property
    def headroom(self) -> int:
        return self.limit - self.measured


BUDGETS: tuple[Budget, ...] = (
    Budget(
        key="route-first-load-js",
        limit=180_000,
        measured=166_552,
        unit="gzip",
        what="heaviest route's first-load JavaScript, gzipped",
        why=(
            "The number that decides whether the game starts. 13,448 bytes of "
            "headroom: under every library listed above, over any single "
            "screen's worth of app code."
        ),
    ),
    Budget(
        key="shared-baseline-js",
        limit=160_000,
        measured=147_614,
        unit="gzip",
        what="chunks every navigable route loads, gzipped",
        why=(
            "React and the Next.js client runtime. This is the floor under "
            "every page, so growth here is paid on every single visit rather "
            "than by one screen. It should be near-constant; 12,386 bytes of "
            "headroom covers a framework point release, not a new dependency."
        ),
    ),
    Budget(
        key="route-cold-transfer",
        limit=192_000,
        measured=177_976,
        unit="gzip",
        what="heaviest route's whole cold visit (HTML + CSS + JS + icon), gzipped",
        why=(
            "What the device downloads before the first battle. Budgeting JS "
            "alone would let CSS or an inlined payload grow unwatched, so this "
            "counts every byte the prerendered document asks for."
        ),
    ),
    Budget(
        key="emitted-client-assets",
        limit=880_000,
        measured=790_154,
        unit="raw",
        what="every client asset the build emitted, uncompressed",
        why=(
            "First load is not the whole story: a chunk fetched on navigation "
            "to /album is still weight a child waits for, and it never appears "
            "in a first-load figure. Raw rather than gzipped because this is "
            "about what the device parses and caches. A wider band (11.4%) "
            "because it is a coarser guard than the transfer numbers."
        ),
    ),
)


# A measurement that has fallen well below its recorded baseline means the
# budget has gone slack and stopped guarding anything. That is good news, not a
# failure, so it is reported as a note - but it is reported, because a ceiling
# nobody ratchets down is a ceiling that eventually permits anything.
SLACK_FRACTION = 0.15


# --------------------------------------------------------------------------
# Build shapes
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Shape:
    """Where one build shape puts the three things this script reads."""

    name: str
    html_root: Path  # prerendered documents
    asset_root: Path  # what a "/_next/..." URL resolves against
    public_root: Path  # files served verbatim at the deployment root
    emitted_root: Path  # the client assets whose total weight is budgeted
    how_to_build: str


SHAPES: dict[str, Shape] = {
    "server": Shape(
        name="server",
        html_root=REPO / ".next" / "server" / "app",
        asset_root=REPO / ".next",
        public_root=REPO / "public",
        emitted_root=REPO / ".next" / "static",
        how_to_build="npm run build",
    ),
    "static": Shape(
        name="static",
        html_root=REPO / "out",
        asset_root=REPO / "out" / "_next",
        public_root=REPO / "out",
        emitted_root=REPO / "out" / "_next" / "static",
        how_to_build=(
            "mv src/app/api /tmp/api-routes && STATIC_EXPORT=1 npm run build "
            "&& mv /tmp/api-routes src/app/api"
        ),
    ),
}


# `_global-error` is the shell React renders when the root error boundary itself
# fails. It is emitted as a document but it is not a destination - nobody
# navigates to it - and it loads a strict subset of the chunks. Counting it
# would drag the "every route pays this" baseline down to the subset and make
# the shared figure describe a page no child ever sees.
NON_NAVIGABLE = frozenset({"/_global-error"})


# --------------------------------------------------------------------------
# What must not ship
# --------------------------------------------------------------------------

# Opaque media. None of this has any business in a build whose art is geometry.
FORBIDDEN_EXTS = frozenset(
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
        ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac",
        ".ttf", ".otf", ".woff", ".woff2", ".eot",
        ".mp4", ".webm", ".mov", ".m4v",
    }
)

# An SVG is text and the app icon is legitimately one - but only as a file the
# host serves, never as something a bundler pulled into a chunk.
VECTOR_EXT = ".svg"

# Extensions that are unremarkable in a build output and are not media.
BENIGN_EXTS = frozenset(
    {".js", ".css", ".html", ".json", ".txt", ".map", ".webmanifest", ".rsc",
     ".meta", ".segments", ".nojekyll", ""}
)

# The other way media ships: inlined, with no filename to notice. A base64 font
# inside a CSS chunk is a font, and it costs a child exactly as much as a .woff2
# would have. `data:image/svg+xml` is excluded because inline vector geometry is
# the whole design of this app's art.
DATA_URI = re.compile(r"data:(image|font|audio|video|application/(?:font|x-font))/([a-zA-Z0-9.+-]+)")
FONT_FACE = re.compile(r"@font-face")


# --------------------------------------------------------------------------
# Reading the build
# --------------------------------------------------------------------------


def broke(message: str) -> "None":
    sys.stderr.write(f"audit_bundle: could not run the audit: {message}\n")
    raise SystemExit(2)


def gz(data: bytes) -> int:
    """Gzipped length. mtime=0 so the header carries no clock."""
    return len(gzip.compress(data, compresslevel=6, mtime=0))


@dataclass(frozen=True)
class Asset:
    """One emitted file, measured once."""

    path: Path
    raw: int
    gzip: int
    digest: str
    kind: str  # "js" | "css" | "doc" | "other"


_ASSET_CACHE: dict[Path, Asset] = {}


def measure(path: Path, kind: str) -> Asset:
    cached = _ASSET_CACHE.get(path)
    if cached is not None:
        return cached
    try:
        data = path.read_bytes()
    except OSError as error:
        broke(f"cannot read an emitted asset the HTML references: {error}")
        raise
    asset = Asset(
        path=path,
        raw=len(data),
        gzip=gz(data),
        digest=hashlib.sha256(data).hexdigest(),
        kind=kind,
    )
    _ASSET_CACHE[path] = asset
    return asset


TAG = re.compile(r"<(script|link)\b[^>]*>", re.IGNORECASE)
ATTR = re.compile(r'\b(?:src|href)\s*=\s*"([^"]*)"', re.IGNORECASE)
NOMODULE = re.compile(r"\bnomodule\b", re.IGNORECASE)
STYLESHEET = re.compile(r'\brel\s*=\s*"[^"]*\bstylesheet\b', re.IGNORECASE)
PRELOAD = re.compile(r'\brel\s*=\s*"[^"]*\bpreload\b', re.IGNORECASE)


@dataclass
class Route:
    name: str
    document: Asset
    js: list[Asset] = field(default_factory=list)
    css: list[Asset] = field(default_factory=list)
    other: list[Asset] = field(default_factory=list)  # icon, manifest
    legacy: list[Asset] = field(default_factory=list)  # noModule polyfills

    @property
    def js_raw(self) -> int:
        return sum(a.raw for a in self.js)

    @property
    def js_gzip(self) -> int:
        return sum(a.gzip for a in self.js)

    @property
    def transfer_gzip(self) -> int:
        return (
            self.document.gzip
            + sum(a.gzip for a in self.css)
            + self.js_gzip
            + sum(a.gzip for a in self.other)
        )

    @property
    def transfer_raw(self) -> int:
        return (
            self.document.raw
            + sum(a.raw for a in self.css)
            + self.js_raw
            + sum(a.raw for a in self.other)
        )


def route_name(html: Path, root: Path) -> str:
    """`index.html` -> `/`, `play.html` and `play/index.html` -> `/play`.

    Both shapes are handled by one rule because the server build writes
    `app/play.html` and the static export writes `out/play/index.html` (Next's
    `trailingSlash` directory style), and those are the same route.
    """
    parts = list(html.relative_to(root).parts)
    parts[-1] = parts[-1][: -len(".html")]
    if parts[-1] == "index":
        parts.pop()
    return "/" + "/".join(parts) if parts else "/"


def resolve(href: str, shape: Shape) -> Path | None:
    """Map a URL out of the prerendered HTML onto the file that answers it.

    Written to survive `basePath`: the static export is served from
    `/<repo>/`, so every URL carries a prefix that does not exist on disk. The
    `_next/` segment is found rather than assumed to be first, and a public file
    is looked up both with and without a leading path segment.
    """
    url = href.split("?")[0].split("#")[0]
    if not url or url.startswith(("data:", "http://", "https://", "//")):
        return None

    marker = "/_next/"
    at = url.find(marker)
    if at >= 0:
        candidate = shape.asset_root / url[at + len(marker) :]
        return candidate if candidate.is_file() else None

    trimmed = url.lstrip("/")
    if not trimmed:
        return None
    candidates = [trimmed]
    if "/" in trimmed:
        candidates.append(trimmed.split("/", 1)[1])
    for relative in candidates:
        candidate = shape.public_root / relative
        # `.resolve()` so a "../" in a href cannot walk out of the build.
        if candidate.is_file() and shape.public_root.resolve() in candidate.resolve().parents:
            return candidate
    return None


def read_route(html: Path, shape: Shape) -> Route:
    text = html.read_text(encoding="utf-8", errors="replace")
    route = Route(name=route_name(html, shape.html_root), document=measure(html, "doc"))

    seen: set[Path] = set()
    for match in TAG.finditer(text):
        tag = match.group(0)
        element = match.group(1).lower()
        href = ATTR.search(tag)
        if href is None:
            continue
        target = resolve(href.group(1), shape)
        if target is None or target in seen:
            continue

        if element == "script":
            seen.add(target)
            asset = measure(target, "js")
            # A `noModule` script is the legacy polyfill bundle. Every browser
            # that supports ES modules - which is every device this game is
            # played on - skips it entirely, so counting it in first load would
            # inflate the number by ~112 KB of bytes nobody downloads. It is
            # reported separately instead of being silently dropped.
            (route.legacy if NOMODULE.search(tag) else route.js).append(asset)
            continue

        # `<link rel=preload as=script>` names a chunk that a `<script>` tag
        # later in the same document also names. Counting both would double it;
        # `seen` prevents that, and preloads are otherwise ignored here.
        if PRELOAD.search(tag):
            continue
        if STYLESHEET.search(tag):
            seen.add(target)
            route.css.append(measure(target, "css"))
            continue
        # The manifest and the icon: small, but genuinely fetched on a cold
        # visit, so they belong in the transfer total rather than in a footnote.
        if target.suffix.lower() in (".webmanifest", VECTOR_EXT, ".json"):
            seen.add(target)
            route.other.append(measure(target, "other"))

    route.js.sort(key=lambda a: (-a.raw, a.digest))
    route.css.sort(key=lambda a: (-a.raw, a.digest))
    route.other.sort(key=lambda a: (-a.raw, a.digest))
    route.legacy.sort(key=lambda a: (-a.raw, a.digest))
    return route


def read_routes(shape: Shape) -> list[Route]:
    if not shape.html_root.is_dir():
        broke(
            f"no {shape.name} build to measure - "
            f"{shape.html_root.relative_to(REPO)} does not exist. "
            f"Run `{shape.how_to_build}` (or pass --build)."
        )
    documents = sorted(p for p in shape.html_root.rglob("*.html"))
    if not documents:
        broke(
            f"{shape.html_root.relative_to(REPO)} contains no prerendered HTML, "
            "so there is nothing to measure. Did the build finish?"
        )
    # The static export writes some routes twice - `out/404.html` and
    # `out/404/index.html` are one destination served two ways, because
    # `trailingSlash` wants the directory form and a static host wants the flat
    # one. Both are the same first load, so the route is measured once; taking
    # the lexicographically first document keeps the choice deterministic.
    seen: set[str] = set()
    routes: list[Route] = []
    for document in documents:
        route = read_route(document, shape)
        if route.name in seen:
            continue
        seen.add(route.name)
        routes.append(route)
    routes.sort(key=lambda r: r.name)
    return routes


def cross_check(routes: list[Route], shape: Shape) -> str:
    """Compare our per-route JS total against Next's own, where it publishes one.

    Two independent readings of one build. If they disagree, the parsing above
    is wrong and every number after it is fiction, so the audit stops rather
    than reporting a total it cannot defend.
    """
    stats = REPO / ".next" / "diagnostics" / "route-bundle-stats.json"
    if shape.name != "server" or not stats.is_file():
        return "not available for this build (no route-bundle-stats.json)"
    try:
        published = {
            entry["route"]: entry["firstLoadUncompressedJsBytes"]
            for entry in json.loads(stats.read_text(encoding="utf-8"))
        }
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        broke(f"route-bundle-stats.json is not the shape this expects: {error}")
        raise

    checked = 0
    for route in routes:
        expected = published.get(route.name)
        if expected is None:
            continue
        checked += 1
        if expected != route.js_raw:
            broke(
                f"disagreement on {route.name}: this script read "
                f"{route.js_raw:,} bytes of first-load JS from the prerendered "
                f"HTML, Next.js reports {expected:,}. One of the two is wrong, "
                "so no number here can be trusted."
            )
    if checked == 0:
        broke(
            "route-bundle-stats.json named none of the routes found in the "
            "prerendered HTML, so the cross-check verified nothing."
        )
    return f"agrees with Next.js on all {checked} route(s) it publishes"


# --------------------------------------------------------------------------
# The no-bundled-media property, applied to the build output
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Violation:
    section: str
    where: str
    detail: str

    def sort_key(self) -> tuple[str, str, str]:
        return (self.section, self.where, self.detail)


def scan_media(shape: Shape) -> tuple[list[Violation], list[str], int]:
    """(violations, notes, bytes of emitted client assets).

    Deliberately reports *where* by role rather than by filename: a chunk's name
    is a content hash that changes every build, so "a font inside a shared
    JavaScript chunk" is both more useful and more stable than a token that will
    not exist tomorrow.
    """
    violations: list[Violation] = []
    notes: list[str] = []

    # Both roots are scanned in both shapes. In the server build `public/` is
    # not part of `.next` at all, but the host serves it verbatim, so it ships;
    # in the static build the same files have already been copied into `out/`
    # alongside the bundle. Either way a dropped .png there reaches a browser,
    # which is the thing being checked.
    roots: list[tuple[str, Path]] = [
        ("the emitted bundle", shape.emitted_root),
        ("served verbatim at the site root", shape.public_root),
    ]

    emitted_bytes = 0
    if shape.emitted_root.is_dir():
        emitted_bytes = sum(
            p.stat().st_size for p in shape.emitted_root.rglob("*") if p.is_file()
        )
    else:
        broke(
            f"{shape.emitted_root.relative_to(REPO)} does not exist, so the "
            "emitted client assets cannot be weighed."
        )

    ext_census: dict[tuple[str, str], tuple[int, int]] = {}
    svg_in_bundle: list[str] = []
    svg_at_root: list[tuple[str, int]] = []

    for label, root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            # In the static shape `out/` holds both the bundle and the public
            # files; `_next/` is already covered by the bundle root.
            if shape.name == "static" and label != "the emitted bundle":
                if shape.asset_root.resolve() in path.resolve().parents:
                    continue
            ext = path.suffix.lower()
            size = path.stat().st_size
            count, total = ext_census.get((label, ext), (0, 0))
            ext_census[(label, ext)] = (count + 1, total + size)

            if ext in FORBIDDEN_EXTS:
                violations.append(
                    Violation(
                        "Media file in the build output",
                        f"{label} ({ext})",
                        f"{size:,} bytes. The app ships no raster, font or audio "
                        "asset; the creatures are geometry. Something imported "
                        "or copied one.",
                    )
                )
            elif ext == VECTOR_EXT:
                if label == "the emitted bundle":
                    svg_in_bundle.append(f"{size:,} bytes")
                else:
                    svg_at_root.append((path.name, size))
            elif ext not in BENIGN_EXTS:
                notes.append(f"unrecognised emitted extension {ext!r} ({label})")

            if ext in (".js", ".css"):
                text = path.read_text(encoding="utf-8", errors="replace")
                inlined = sorted(
                    {
                        f"{kind}/{subtype}"
                        for kind, subtype in DATA_URI.findall(text)
                        if not (kind == "image" and subtype.startswith("svg"))
                    }
                )
                for mime in inlined:
                    violations.append(
                        Violation(
                            "Media inlined as a data: URI inside a shipped chunk",
                            f"a {ext[1:]} chunk in {label}",
                            f"embeds data:{mime}. Inlining does not make an "
                            "asset weigh less - it makes it invisible to "
                            "scripts/audit_assets.py, which only sees files.",
                        )
                    )
                if FONT_FACE.search(text):
                    violations.append(
                        Violation(
                            "Web font declared in a shipped chunk",
                            f"a {ext[1:]} chunk in {label}",
                            "@font-face. The app uses the device's own system "
                            "fonts, which cost nothing and are already the "
                            "shapes the child reads elsewhere.",
                        )
                    )

    for size_text in sorted(svg_in_bundle):
        violations.append(
            Violation(
                "SVG emitted into the bundle",
                "the emitted bundle",
                f"{size_text}. An SVG served from the site root is fine - the "
                "app icon is one. An SVG the bundler emitted means an image "
                "asset was imported by code, which is the thing this app does "
                "not do.",
            )
        )
    for name, size in sorted(svg_at_root):
        notes.append(
            f"{name}: {size:,} bytes, vector, served at the site root - this is "
            "the favicon and PWA manifest icon, and it is legitimate"
        )
    # Kept per-root on purpose. Only the bundle root is budgeted, because
    # `public/` is hand-authored and every file in it is already audited by
    # name, size and content by scripts/audit_assets.py. Merging the two
    # censuses would make the budgeted total impossible to reconcile with the
    # printed one, which is how a number stops being checkable.
    for label, ext in sorted(ext_census):
        count, total = ext_census[(label, ext)]
        notes.append(
            f"{label}: {count} {ext or '(no extension)'} file(s), {total:,} bytes"
        )

    return violations, notes, emitted_bytes


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

WIDTH = 78


def kib(n: int) -> str:
    return f"{n / 1024:.1f} KiB"


def both(raw: int, gzipped: int) -> str:
    return f"{raw:>9,} {gzipped:>9,}"


def chunk_label(users: list[str], navigable: list[str]) -> str:
    if set(users) >= set(navigable):
        return "shared by every route"
    if len(users) == 1:
        return f"only {users[0]}"
    joined = ", ".join(users)
    return joined if len(joined) <= 40 else f"{len(users)} routes: {joined[:34]}..."


def render(
    shape: Shape,
    routes: list[Route],
    verdicts: list[tuple[Budget, int, bool]],
    media: list[Violation],
    media_notes: list[str],
    slack: list[str],
    check_note: str,
    quiet: bool,
) -> str:
    out: list[str] = []
    add = out.append

    navigable = [r.name for r in routes if r.name not in NON_NAVIGABLE]
    shared: set[str] = set()
    for name in navigable:
        route = next(r for r in routes if r.name == name)
        digests = {a.digest for a in route.js}
        shared = digests if not shared and name == navigable[0] else shared & digests
    by_digest = {a.digest: a for r in routes for a in r.js}
    shared_assets = sorted(
        (by_digest[d] for d in shared), key=lambda a: (-a.raw, a.digest)
    )

    add("=" * WIDTH)
    add("BUNDLE WEIGHT AUDIT - Mathmon Battle League")
    add("=" * WIDTH)
    add("")
    add(f"  build shape        {shape.name} (`{shape.how_to_build}`)")
    add(f"  routes measured    {len(routes)} prerendered document(s)")
    add(f"  cross-check        {check_note}")
    add("")
    add("  Every figure below is a byte count of a file this build emitted.")
    add("  'gzip' is what crosses the network; 'raw' is what the device parses.")
    add("")

    if not quiet:
        add("-" * WIDTH)
        add("FIRST LOAD, PER ROUTE")
        add("-" * WIDTH)
        add("")
        add(f"  {'route':<16}{'JS raw':>9}{'JS gzip':>9}{'own gzip':>10}{'total gzip':>12}")
        for route in routes:
            own = sum(a.gzip for a in route.js if a.digest not in shared)
            mark = "" if route.name in navigable else "  (not navigable)"
            add(
                f"  {route.name:<16}{route.js_raw:>9,}{route.js_gzip:>9,}"
                f"{own:>10,}{route.transfer_gzip:>12,}{mark}"
            )
        add("")
        add("  'own gzip'   this route's chunks beyond the shared baseline.")
        add("  'total gzip' the whole cold visit: document, CSS, JS, icon,")
        add("               manifest - everything the prerendered HTML asks for.")
        add("")

        add("-" * WIDTH)
        add("THE SHARED BASELINE - paid on every visit")
        add("-" * WIDTH)
        add("")
        add(f"  {'':<44}{'raw':>9}{'gzip':>9}")
        for index, asset in enumerate(shared_assets, start=1):
            add(f"  chunk #{index:<37}{asset.raw:>9,}{asset.gzip:>9,}")
        add(
            f"  {'total (' + str(len(shared_assets)) + ' chunks)':<44}"
            f"{sum(a.raw for a in shared_assets):>9,}"
            f"{sum(a.gzip for a in shared_assets):>9,}"
        )
        add("")

        add("-" * WIDTH)
        add("LARGEST FIRST-LOAD CHUNKS - where a regression would show")
        add("-" * WIDTH)
        add("")
        add(f"  {'':<4}{'raw':>9}{'gzip':>9}   loaded by")
        every = sorted(
            {a.digest: a for r in routes for a in r.js}.values(),
            key=lambda a: (-a.raw, a.digest),
        )
        for index, asset in enumerate(every, start=1):
            users = sorted(r.name for r in routes if asset.digest in {c.digest for c in r.js})
            add(
                f"  {'#' + str(index):<4}{asset.raw:>9,}{asset.gzip:>9,}   "
                f"{chunk_label(users, navigable)}"
            )
        add("")
        add("  Chunks are identified by which routes load them, never by")
        add("  filename: those are content hashes and change every build.")
        add("  Module-level attribution is not possible from this build - see")
        add("  the note at the top of this script.")
        add("")

        legacy = sorted(
            {a.digest: a for r in routes for a in r.legacy}.values(),
            key=lambda a: (-a.raw, a.digest),
        )
        if legacy:
            add("-" * WIDTH)
            add("NOT COUNTED - the legacy polyfill bundle")
            add("-" * WIDTH)
            add("")
            for asset in legacy:
                add(
                    f"  {asset.raw:>9,}{asset.gzip:>9,}   served with `noModule`"
                )
            add("")
            add("  Every browser that understands ES modules skips these, which")
            add("  is every device this game is played on. Counting them would")
            add("  inflate first load by bytes nobody downloads.")
            add("")

        add("-" * WIDTH)
        add("EMITTED ASSET CENSUS - what actually shipped")
        add("-" * WIDTH)
        add("")
        for note in sorted(set(media_notes)):
            add(f"  {note}")
        add("")
        add("  Every root above is checked for media; only the bundle root is")
        add("  budgeted. What the host serves verbatim is either hand-written -")
        add("  and scripts/audit_assets.py already checks those by name, size")
        add("  and content - or, in the static shape, the prerendered documents")
        add("  already counted per route above. Weighing them here as well would")
        add("  make the budgeted total disagree with the census beside it.")
        add("")

    add("-" * WIDTH)
    add("BUDGET")
    add("-" * WIDTH)
    add("")
    for budget, actual, ok in verdicts:
        used = actual - budget.measured
        add(f"  [{'ok  ' if ok else 'OVER'}] {budget.key}  ({budget.unit})")
        add(f"         {budget.what}")
        margin = budget.limit - actual
        add(
            f"         measured {actual:>9,}   limit {budget.limit:>9,}   "
            + (f"{kib(margin)} spare" if margin >= 0 else f"{kib(-margin)} OVER")
        )
        add(
            f"         baseline {budget.measured:>9,} when the limit was set "
            f"({used:+,} since)"
        )
        if not ok:
            add(f"         OVER BY {actual - budget.limit:,} bytes.")
        add("")

    if media:
        add("-" * WIDTH)
        add(f"PROPERTY VIOLATIONS ({len(media)})")
        add("-" * WIDTH)
        for violation in sorted(media, key=Violation.sort_key):
            add("")
            add(f"  {violation.section}")
            add(f"    in {violation.where}")
            add(f"    {violation.detail}")
        add("")

    if slack and not quiet:
        add("-" * WIDTH)
        add("BUDGETS THAT HAVE GONE SLACK (not a failure)")
        add("-" * WIDTH)
        add("")
        for line in slack:
            add(f"  {line}")
        add("")

    failed = [b for b, _, ok in verdicts if not ok] or media
    add("=" * WIDTH)
    if failed:
        over = [b.key for b, _, ok in verdicts if not ok]
        add("RESULT: FAIL")
        add("")
        if over:
            add(f"  budget exceeded: {', '.join(sorted(over))}")
        if media:
            add(f"  property violated: {len(media)} finding(s) above")
        add("")
        add("  Find the growth in the chunk table above before touching the")
        add("  numbers in BUDGETS. Raising a ceiling is a decision about how")
        add("  long a seven-year-old waits on a hand-me-down iPad, and it")
        add("  should look like one in the diff.")
    else:
        add("RESULT: PASS")
        add("")
        add("  Every budget respected. No raster, font or audio asset shipped,")
        add("  as a file or inlined as a data: URI.")
    add("=" * WIDTH)
    return "\n".join(out)


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------


def run_build(shape: Shape) -> None:
    """Run the real production build. Explicit argv, return code checked."""
    if shape.name != "server":
        broke(
            "--build only produces the default server build. The static export "
            "needs `src/app/api` moved out of the tree first, and this script "
            "will not move files in the repository it is auditing. Run "
            f"`{shape.how_to_build}` yourself, then re-run with --shape static."
        )
    proc = subprocess.run(
        ["npm", "run", "build"],
        cwd=str(REPO),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        broke(f"`npm run build` exited {proc.returncode}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Measure the production bundle against a committed budget."
    )
    parser.add_argument(
        "--shape",
        choices=sorted(SHAPES),
        default="server",
        help="which build shape to measure (default: server)",
    )
    parser.add_argument(
        "--build", action="store_true", help="run `npm run build` before measuring"
    )
    parser.add_argument(
        "--quiet", action="store_true", help="print the budget and verdict only"
    )
    args = parser.parse_args(argv[1:])

    shape = SHAPES[args.shape]
    if args.build:
        run_build(shape)

    routes = read_routes(shape)
    check_note = cross_check(routes, shape)
    media, media_notes, emitted_bytes = scan_media(shape)

    navigable = [r for r in routes if r.name not in NON_NAVIGABLE]
    if not navigable:
        broke("the build emitted no navigable route, so there is nothing to budget")

    shared_digests: set[str] | None = None
    for route in navigable:
        digests = {a.digest for a in route.js}
        shared_digests = digests if shared_digests is None else shared_digests & digests
    assert shared_digests is not None
    by_digest = {a.digest: a for r in routes for a in r.js}

    actuals = {
        "route-first-load-js": max(r.js_gzip for r in navigable),
        "shared-baseline-js": sum(by_digest[d].gzip for d in shared_digests),
        "route-cold-transfer": max(r.transfer_gzip for r in navigable),
        "emitted-client-assets": emitted_bytes,
    }

    verdicts: list[tuple[Budget, int, bool]] = []
    slack: list[str] = []
    for budget in BUDGETS:
        actual = actuals[budget.key]
        verdicts.append((budget, actual, actual <= budget.limit))
        if actual < budget.measured * (1 - SLACK_FRACTION):
            slack.append(
                f"{budget.key}: now {actual:,}, {budget.measured - actual:,} bytes "
                f"below the {budget.measured:,} this limit was set from. The "
                f"ceiling of {budget.limit:,} is no longer guarding much - "
                "consider ratcheting it down."
            )

    sys.stdout.write(
        render(
            shape, routes, verdicts, media, media_notes, slack, check_note, args.quiet
        )
        + "\n"
    )
    return 1 if (media or any(not ok for _, _, ok in verdicts)) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
