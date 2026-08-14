#!/usr/bin/env python3
"""Audit the committed iOS captures in mobile/docs/screens/, without a simulator.

Why this exists
---------------
`mobile/docs/screens/` is the visual record of the iOS client. It is produced by
`mobile/scripts/capture_screens.sh`, which needs macOS, Xcode, a Release build
and a booted simulator - forty minutes of `macos-26` runner, and nothing a
contributor can run on a laptop that is not a Mac. So the pictures are captured
rarely and read often, which is precisely the shape of artefact that rots
without anyone noticing.

And a screenshot is a uniquely dishonest artefact. `xcrun simctl io screenshot`
succeeds whether the app rendered the game, a redbox, or nothing at all: it
photographs whatever is on the display and exits 0. This repository has already
shipped a green iOS run that was photographing the "No script URL provided"
redbox for a Debug build with no JavaScript in it, and the web client shipped a
`12-chinese.png` that was a byte-identical copy of an English dashboard - the
README's only picture of the Chinese interface, wrong for weeks, with a passing
test suite over it the whole time.

So this audit checks the *artefacts*, from the bytes up, with the standard
library alone: no simulator, no Xcode, no build, about ten seconds. It cannot
tell you the button is in the right place. It can tell you the file is a real
PNG, is the size a phone screenshot should be, is not blank, is painted on this
app's own background rather than a redbox or a home screen, is not a copy of a
different screen, and is a screen the capture script actually knows how to
produce.

Properties
----------
P1  manifest    Every committed capture is a `.png` named `NN-kebab-case` that
                `capture_screens.sh` produces, with no orphan left behind by a
                rename, no two files claiming the same number, and no stray
                non-PNG. The record is never empty.
P2  decodable   Every file is a valid PNG all the way through: signature, chunk
                lengths and CRCs, an IHDR this audit can inspect, an IDAT stream
                that inflates to exactly the declared number of scanlines, and
                an IEND. A truncated capture - a run killed mid-write, a
                partially uploaded artifact - dies here rather than being served
                as a broken image on GitHub.
P3  geometry    Every capture is portrait, within the pixel bounds of a phone
                simulator, and the *same size as every other capture*. A mixed
                set means the record was assembled from two different devices,
                which reads as a broken gallery and usually means half of it is
                stale.
P4  legible     No capture is blank, near-blank, or bright - and the single most
                common colour in it is the app's own background, read out of
                `mobile/src/theme.ts`. That last clause is the redbox check: a
                React Native redbox is a live app on a red screen, the simulator
                home screen is a live device with the wrong app on it, and an
                unpainted window is white. All three pass "the process is still
                running", and none of them paints #0b1120 over most of the
                display.
P5  distinct    No two captures contain the same pixels. This is the property
                that matters most here, and the one that catches the bug this
                project has actually shipped: the Chinese captures are taken
                from a save identical to the English one except for
                `settings.language`, so if the translation never applied they
                would be byte-identical to their English counterparts and P5
                would say so by name.
P6  documented  Every `docs/screens/*.png` path referenced from the
                documentation resolves to a file that exists, from the
                referencing document's own directory. Captures no document
                embeds are reported as a note, not a violation.

On completeness, and where this audit is deliberately weaker than the web one
--------------------------------------------------------------------------
`scripts/audit_screenshots.py` fails when a screenshot the spec captures is
missing from disk, because on the web client one command regenerates the whole
set and anyone can run it. Here nobody can: the captures come off a macOS
runner, and someone has to commit the artifact afterwards. A missing capture is
therefore a **note** by default and a **violation** under `--require-complete`,
which is how `capture_screens.sh` calls this script - on that side of the fence
every screen was just captured, so a missing one is a failure rather than a
backlog.

The note is printed loudly and names each screen, so an incomplete record is
visible on every run rather than being something you have to go looking for.

Determinism
-----------
No clock, no randomness, no network, no set iteration reaching the output: every
list is sorted before it is printed and every ratio is rounded. The colour
statistics sample a fixed lattice - every third row, every third pixel, which on
a 3x phone capture is still every logical point - and that is a fixed function
of the image. Two runs on the same tree print byte-identical output.

Usage
-----
    python3 mobile/scripts/audit_ios_screenshots.py
    python3 mobile/scripts/audit_ios_screenshots.py --require-complete [DIR]

Exit status
-----------
0  every property holds.
1  at least one property is violated. Each violation is named by its property.
2  the harness could not run - an unparseable capture script, a missing theme,
   an unreadable directory. Never a silent pass: this audit fails loudly rather
   than reporting all-clear on files it did not manage to inspect.
"""

from __future__ import annotations

import hashlib
import os
import re
import struct
import sys
import zlib
from collections import Counter
from dataclasses import dataclass

MOBILE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(MOBILE_DIR)

CAPTURE_SCRIPT = "mobile/scripts/capture_screens.sh"
THEME_PATH = "mobile/src/theme.ts"
DEFAULT_SHOT_DIR = "mobile/docs/screens"

# Documents that may embed a capture. A link from a source file would be a bug
# of an entirely different kind.
DOC_FILES = ("mobile/README.md", "README.md", "CLAUDE.md", "docs/README.md")

NAME_PATTERN = re.compile(r"^(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$")


# ---------------------------------------------------------------------------
# P3 / P4 thresholds
# ---------------------------------------------------------------------------
#
# Every number below is a floor or a ceiling measured against the *worst* real
# capture in the set rather than guessed. That is `01-sign-up`, which is by some
# distance the sparsest screen this app has - a title, a text field, one button,
# and half a phone of empty background below it:
#
#     1206x2622   131,687 bytes   512 distinct rows   621 sampled colours
#     84.6% one colour   1.9% near-white   mean luminance 26.3
#
# For comparison, a capture showing nothing but the status bar over the app's
# background measures about 99% one colour, and a redbox has a red dominant.

MIN_FILE_BYTES = 8192
MIN_DISTINCT_ROWS = 32
MIN_DISTINCT_COLOURS = 64
MAX_DOMINANT_SHARE = 0.93
MAX_LIGHT_SHARE = 0.30
MAX_MEAN_LUMINANCE = 96.0

# "Near-white" for the light-share test. This app is dark on every screen; a
# third of the pixels this bright is a crash overlay or an unpainted window.
LIGHT_CHANNEL_FLOOR = 200

# A phone simulator screenshot, in pixels. Wide enough to admit any iPhone the
# runner might offer at 2x or 3x, narrow enough to reject a Mac window, an iPad
# in landscape, or a thumbnail.
MIN_WIDTH, MAX_WIDTH = 640, 2400
MIN_HEIGHT, MAX_HEIGHT = 1000, 3600

ROW_SAMPLE_STEP = 3
COL_SAMPLE_STEP = 3


def die(message: str) -> "NoReturn":  # type: ignore[valid-type]
    sys.stderr.write(f"audit_ios_screenshots: {message}\n")
    raise SystemExit(2)


def read_repo_text(relative: str) -> str:
    path = os.path.join(REPO_ROOT, relative)
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError as exc:
        die(f"cannot read {relative}: {exc}")


# ---------------------------------------------------------------------------
# The manifest the capture script claims to produce
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Capture:
    """One screen `capture_screens.sh` photographs."""

    name: str
    phase: str
    link: str
    expected_text: tuple[str, ...]
    line: int


# One record of the SCREENS array: "name|phase|link|text|text...".
RECORD_PATTERN = re.compile(r'^\s*"([^"|]+)\|([^"|]*)\|([^"|]*)\|(.*)"\s*$')


def parse_capture_script(source: str) -> list[Capture]:
    """Every screen in the `SCREENS=( ... )` array, in the order it is captured.

    Parsed rather than restated. A hard-coded list here would be a second source
    of truth, and drift between the two is the whole thing this audit exists to
    notice: add a screen to the capture script, forget to run it, and P1's note
    says so on the next push.
    """
    captures: list[Capture] = []
    inside = False

    for number, line in enumerate(source.split("\n"), start=1):
        if not inside:
            if line.startswith("SCREENS=("):
                inside = True
            continue
        if line.startswith(")"):
            break
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = RECORD_PATTERN.match(line)
        if not match:
            die(
                f"{CAPTURE_SCRIPT}:{number} is inside SCREENS=( ... ) but is neither a "
                f"comment nor a record this audit can read: {stripped!r}. Fix the parse "
                "rather than letting the audit check a manifest it cannot see."
            )
        name, phase, link, rest = match.groups()
        captures.append(
            Capture(
                name=name,
                phase=phase,
                link=link,
                expected_text=tuple(part for part in rest.split("|") if part),
                line=number,
            )
        )

    if not inside:
        die(f"could not find the `SCREENS=(` array in {CAPTURE_SCRIPT}")
    if not captures:
        die(
            f"parsed no screens out of {CAPTURE_SCRIPT}. Either the script stopped "
            "capturing anything or this parse is broken; both are worth a human look, "
            "and neither is a pass."
        )
    return captures


def parse_background_colour(source: str) -> tuple[int, int, int]:
    """`colors.bg` from mobile/src/theme.ts - the colour every screen paints."""
    match = re.search(r"\bbg:\s*'#([0-9a-fA-F]{6})'", source)
    if not match:
        die(
            f"could not find `bg: '#rrggbb'` in {THEME_PATH}. P4's redbox check needs "
            "the app's own background colour; it will not run on a guess."
        )
    value = match.group(1)
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


# ---------------------------------------------------------------------------
# PNG decoding (P2, and the pixels P3/P4/P5 need)
# ---------------------------------------------------------------------------

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Bytes per pixel by colour type, at bit depth 8. Type 3 (palette) is one index
# byte per pixel and is expanded after unfiltering.
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


class BadPng(Exception):
    """This file is not a PNG this audit can vouch for. Always a P2 violation."""


@dataclass
class Image:
    width: int
    height: int
    colour_type: int
    rows: list[bytes]
    bpp: int


def parse_png(raw: bytes) -> Image:
    """Decode far enough to have real pixels, verifying every chunk on the way.

    Deliberately strict. A PNG that is merely *probably* fine is exactly what
    this audit exists to refuse: a capture interrupted mid-write truncates
    inside IDAT and still renders its top half in a viewer, which is how a
    broken screenshot survives a human glance.
    """
    if len(raw) < len(PNG_SIGNATURE) or not raw.startswith(PNG_SIGNATURE):
        raise BadPng("does not start with the PNG signature")

    pos = len(PNG_SIGNATURE)
    header: tuple[int, ...] | None = None
    idat: list[bytes] = []
    palette = b""
    saw_end = False

    while pos < len(raw):
        if pos + 8 > len(raw):
            raise BadPng(f"file ends mid-chunk-header at byte {pos} of {len(raw)}")
        (length,) = struct.unpack(">I", raw[pos : pos + 4])
        kind = raw[pos + 4 : pos + 8]
        start = pos + 8
        end = start + length
        if end + 4 > len(raw):
            raise BadPng(
                f"chunk {kind.decode('latin-1')} at byte {pos} declares {length} bytes "
                f"but only {max(0, len(raw) - start)} remain - the file is truncated"
            )
        data = raw[start:end]
        (declared_crc,) = struct.unpack(">I", raw[end : end + 4])
        actual_crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        if declared_crc != actual_crc:
            raise BadPng(
                f"chunk {kind.decode('latin-1')} at byte {pos} fails its CRC "
                f"({declared_crc:08x} declared, {actual_crc:08x} computed)"
            )
        pos = end + 4

        if kind == b"IHDR":
            if length != 13:
                raise BadPng(f"IHDR is {length} bytes, expected 13")
            header = struct.unpack(">IIBBBBB", data)
        elif kind == b"PLTE":
            palette = data
        elif kind == b"IDAT":
            idat.append(data)
        elif kind == b"IEND":
            saw_end = True

    if header is None:
        raise BadPng("has no IHDR chunk")
    if not saw_end:
        raise BadPng("has no IEND chunk - the file was never finished")
    if not idat:
        raise BadPng("has no IDAT chunk - there are no pixels in it at all")

    width, height, depth, colour_type, compression, filter_method, interlace = header
    if width == 0 or height == 0:
        raise BadPng(f"declares a {width}x{height} image")
    if compression != 0 or filter_method != 0:
        raise BadPng(f"uses compression {compression}/filter method {filter_method}")
    if depth != 8:
        raise BadPng(
            f"is {depth}-bit. This audit inspects 8-bit PNGs, which is what "
            "`simctl io screenshot` emits; it will not pass a file whose pixels it "
            "cannot read."
        )
    if interlace != 0:
        raise BadPng("is interlaced, and this audit cannot inspect its pixels")
    if colour_type not in CHANNELS:
        raise BadPng(f"has unknown colour type {colour_type}")

    bpp = CHANNELS[colour_type]
    stride = width * bpp

    try:
        data = zlib.decompress(b"".join(idat))
    except zlib.error as exc:
        raise BadPng(f"IDAT stream will not inflate: {exc}") from exc

    expected = height * (stride + 1)
    if len(data) != expected:
        raise BadPng(
            f"IDAT inflates to {len(data)} bytes, expected {expected} "
            f"({height} scanlines of {stride}+1) - the image is truncated or malformed"
        )

    rows = _unfilter(data, width, height, bpp, stride)

    if colour_type == 3:
        if not palette:
            raise BadPng("is palette-coloured but carries no PLTE chunk")
        rows = [_expand_palette(row, palette) for row in rows]
        bpp = 3

    return Image(width, height, colour_type, rows, bpp)


def _unfilter(data: bytes, width: int, height: int, bpp: int, stride: int) -> list[bytes]:
    """Reverse the five PNG scanline filters. Hot loop; written for speed."""
    rows: list[bytes] = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        filter_type = data[pos]
        pos += 1
        line = bytearray(data[pos : pos + stride])
        pos += stride

        if filter_type == 0:
            pass
        elif filter_type == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif filter_type == 2:
            line = bytearray([(a + b) & 255 for a, b in zip(line, prev)])
        elif filter_type == 3:
            for i in range(min(bpp, stride)):
                line[i] = (line[i] + (prev[i] >> 1)) & 255
            for i in range(bpp, stride):
                line[i] = (line[i] + ((line[i - bpp] + prev[i]) >> 1)) & 255
        elif filter_type == 4:
            for i in range(min(bpp, stride)):
                line[i] = (line[i] + prev[i]) & 255
            for i in range(bpp, stride):
                a = line[i - bpp]
                b = prev[i]
                c = prev[i - bpp]
                p = a + b - c
                pa = p - a
                pb = p - b
                pc = p - c
                if pa < 0:
                    pa = -pa
                if pb < 0:
                    pb = -pb
                if pc < 0:
                    pc = -pc
                if pa <= pb and pa <= pc:
                    predictor = a
                elif pb <= pc:
                    predictor = b
                else:
                    predictor = c
                line[i] = (line[i] + predictor) & 255
        else:
            raise BadPng(f"scanline uses unknown filter type {filter_type}")

        rows.append(bytes(line))
        prev = line
    return rows


def _expand_palette(row: bytes, palette: bytes) -> bytes:
    out = bytearray(len(row) * 3)
    limit = len(palette) // 3
    for i, index in enumerate(row):
        if index >= limit:
            raise BadPng(f"palette index {index} is outside a {limit}-entry PLTE")
        out[i * 3 : i * 3 + 3] = palette[index * 3 : index * 3 + 3]
    return bytes(out)


# ---------------------------------------------------------------------------
# Image statistics (P4, P5)
# ---------------------------------------------------------------------------


@dataclass
class Stats:
    distinct_rows: int
    distinct_colours: int
    dominant_share: float
    dominant_rgb: tuple[int, int, int]
    light_share: float
    mean_luminance: float
    uniform: bool
    digest: str


def measure(image: Image) -> Stats:
    rows = image.rows
    bpp = image.bpp
    flat = b"".join(rows)
    uniform = flat == flat[:bpp] * (image.width * image.height)

    sampled: Counter[bytes] = Counter()
    step = bpp * COL_SAMPLE_STEP
    for y in range(0, image.height, ROW_SAMPLE_STEP):
        row = rows[y]
        sampled.update(row[x : x + bpp] for x in range(0, image.width * bpp, step))

    total = sum(sampled.values())
    # `most_common` breaks ties by insertion order, which depends on where in
    # the image a colour first appeared - a fixed function of the pixels, but
    # not an obvious one. Sort explicitly so the reported dominant colour is
    # reproducible even for a tie.
    dominant_pixel, dominant_count = sorted(
        sampled.items(), key=lambda item: (-item[1], item[0])
    )[0]

    luminance_sum = 0.0
    light = 0
    for pixel, count in sampled.items():
        if bpp >= 3:
            red, green, blue = pixel[0], pixel[1], pixel[2]
        else:
            red = green = blue = pixel[0]
        luminance_sum += (0.299 * red + 0.587 * green + 0.114 * blue) * count
        if (
            red >= LIGHT_CHANNEL_FLOOR
            and green >= LIGHT_CHANNEL_FLOOR
            and blue >= LIGHT_CHANNEL_FLOOR
        ):
            light += count

    if bpp >= 3:
        dominant_rgb = (dominant_pixel[0], dominant_pixel[1], dominant_pixel[2])
    else:
        grey = dominant_pixel[0]
        dominant_rgb = (grey, grey, grey)

    digest = hashlib.sha256()
    digest.update(f"{image.width}x{image.height}:".encode())
    digest.update(flat)

    return Stats(
        distinct_rows=len(set(rows)),
        distinct_colours=len(sampled),
        dominant_share=dominant_count / total,
        dominant_rgb=dominant_rgb,
        light_share=light / total,
        mean_luminance=luminance_sum / total,
        uniform=uniform,
        digest=digest.hexdigest(),
    )


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

Violation = tuple[str, str]


def check_manifest(
    captures: list[Capture],
    on_disk: list[str],
    extras: list[str],
    shot_dir: str,
    require_complete: bool,
) -> tuple[list[Violation], list[str]]:
    """P1. Returns the violations and the screens that are not committed yet."""
    violations: list[Violation] = []

    seen: dict[str, Capture] = {}
    numbers: dict[str, Capture] = {}
    for capture in captures:
        if capture.name in seen:
            first = seen[capture.name]
            violations.append(
                (
                    "P1 manifest",
                    f"{CAPTURE_SCRIPT} captures {capture.name!r} twice (lines "
                    f"{first.line} and {capture.line}) - the second overwrites the "
                    f"first, so one of those screens is never recorded",
                )
            )
        seen[capture.name] = capture

        match = NAME_PATTERN.match(capture.name)
        if not match:
            violations.append(
                (
                    "P1 manifest",
                    f"{CAPTURE_SCRIPT}:{capture.line} captures {capture.name!r}, which "
                    f"is not NN-kebab-case - the README orders these by their number",
                )
            )
            continue
        number = match.group(1)
        if number in numbers and numbers[number].name != capture.name:
            violations.append(
                (
                    "P1 manifest",
                    f"{CAPTURE_SCRIPT} uses the number {number} for both "
                    f"{numbers[number].name!r} (line {numbers[number].line}) and "
                    f"{capture.name!r} (line {capture.line})",
                )
            )
        numbers[number] = capture

        if not capture.expected_text:
            violations.append(
                (
                    "P1 manifest",
                    f"{CAPTURE_SCRIPT}:{capture.line} captures {capture.name!r} with no "
                    f"expected on-screen text - that capture is never read back, so it "
                    f"would photograph a redbox as happily as the screen",
                )
            )

    expected = set(seen)
    present = set(on_disk)

    if not present:
        violations.append(
            (
                "P1 manifest",
                f"{shot_dir}/ holds no captures at all - an empty visual record is not "
                f"an audited one",
            )
        )

    missing = sorted(expected - present)
    if require_complete:
        for name in missing:
            violations.append(
                (
                    "P1 manifest",
                    f"{shot_dir}/{name}.png is missing - {CAPTURE_SCRIPT}:"
                    f"{seen[name].line} captures it",
                )
            )

    for name in sorted(present - expected):
        violations.append(
            (
                "P1 manifest",
                f"{shot_dir}/{name}.png is an orphan - no screen in {CAPTURE_SCRIPT} "
                f"produces it, so nothing regenerates it and it will rot",
            )
        )

    by_number: dict[str, list[str]] = {}
    for name in on_disk:
        match = NAME_PATTERN.match(name)
        if match:
            by_number.setdefault(match.group(1), []).append(name)
    for number, names in sorted(by_number.items()):
        if len(names) > 1:
            violations.append(
                (
                    "P1 manifest",
                    f"{shot_dir}/ has {len(names)} files numbered {number} "
                    f"({', '.join(sorted(names))}) - a rename that left the old file "
                    f"behind",
                )
            )

    for extra in sorted(extras):
        violations.append(
            (
                "P1 manifest",
                f"{shot_dir}/{extra} is not a .png - this directory holds generated "
                f"captures and nothing else",
            )
        )

    return violations, missing


def check_file(
    name: str, path: str, shot_dir: str, background: tuple[int, int, int]
) -> tuple[list[Violation], Stats | None, Image | None]:
    """P2 and P4 for one file, plus the pixels P3 and P5 need."""
    violations: list[Violation] = []
    label = f"{shot_dir}/{name}.png"

    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as exc:
        return [("P2 decodable", f"{label} cannot be read: {exc}")], None, None

    if len(raw) < MIN_FILE_BYTES:
        violations.append(
            (
                "P2 decodable",
                f"{label} is {len(raw)} bytes. No real capture of this app is under "
                f"{MIN_FILE_BYTES}; this one is empty, stubbed or half-written",
            )
        )

    try:
        image = parse_png(raw)
    except BadPng as exc:
        violations.append(("P2 decodable", f"{label} {exc}"))
        return violations, None, None

    stats = measure(image)

    if stats.uniform:
        violations.append(
            (
                "P4 legible",
                f"{label} is a single flat colour over all "
                f"{image.width * image.height} pixels - it is blank",
            )
        )
    else:
        if stats.distinct_rows < MIN_DISTINCT_ROWS:
            violations.append(
                (
                    "P4 legible",
                    f"{label} has only {stats.distinct_rows} distinct scanline(s), "
                    f"minimum {MIN_DISTINCT_ROWS} - there is nothing drawn on it",
                )
            )
        if stats.distinct_colours < MIN_DISTINCT_COLOURS:
            violations.append(
                (
                    "P4 legible",
                    f"{label} samples only {stats.distinct_colours} distinct colour(s), "
                    f"minimum {MIN_DISTINCT_COLOURS}",
                )
            )
        if stats.dominant_share > MAX_DOMINANT_SHARE:
            violations.append(
                (
                    "P4 legible",
                    f"{label} is {stats.dominant_share:.1%} one single colour, "
                    f"limit {MAX_DOMINANT_SHARE:.0%} - very close to blank",
                )
            )

    if stats.dominant_rgb != background:
        violations.append(
            (
                "P4 legible",
                f"{label} is mostly rgb{stats.dominant_rgb}, not the app's background "
                f"rgb{background} from {THEME_PATH}. Every screen of this app paints "
                f"that colour behind everything, so this is a redbox, the simulator "
                f"home screen, or a window that never painted",
            )
        )

    if stats.light_share > MAX_LIGHT_SHARE:
        violations.append(
            (
                "P4 legible",
                f"{label} is {stats.light_share:.1%} near-white pixels, limit "
                f"{MAX_LIGHT_SHARE:.0%}. Every screen of this app is dark",
            )
        )
    if stats.mean_luminance > MAX_MEAN_LUMINANCE:
        violations.append(
            (
                "P4 legible",
                f"{label} has mean luminance {stats.mean_luminance:.1f}, limit "
                f"{MAX_MEAN_LUMINANCE:.0f} - far too bright to be a screen of this app",
            )
        )

    return violations, stats, image


def check_geometry(sizes: dict[str, tuple[int, int]], shot_dir: str) -> list[Violation]:
    """P3: phone-shaped, portrait, and one device for the whole set."""
    violations: list[Violation] = []

    for name in sorted(sizes):
        width, height = sizes[name]
        label = f"{shot_dir}/{name}.png"
        if height <= width:
            violations.append(
                (
                    "P3 geometry",
                    f"{label} is {width}x{height}, which is not portrait - the app is "
                    f"portrait-only (`orientation: portrait` in app.json)",
                )
            )
        if not (MIN_WIDTH <= width <= MAX_WIDTH and MIN_HEIGHT <= height <= MAX_HEIGHT):
            violations.append(
                (
                    "P3 geometry",
                    f"{label} is {width}x{height}, outside the {MIN_WIDTH}-{MAX_WIDTH} "
                    f"by {MIN_HEIGHT}-{MAX_HEIGHT} pixel range of a phone simulator - "
                    f"this is not a screenshot of an iPhone",
                )
            )

    distinct = sorted({size for size in sizes.values()})
    if len(distinct) > 1:
        grouped = {
            size: sorted(name for name, value in sizes.items() if value == size)
            for size in distinct
        }
        described = "; ".join(
            f"{size[0]}x{size[1]}: {', '.join(names)}" for size, names in sorted(grouped.items())
        )
        violations.append(
            (
                "P3 geometry",
                f"the captures are not all the same size ({described}) - the record was "
                f"assembled from more than one device, so part of it is stale. Re-run "
                f"the capture job and commit the whole set",
            )
        )

    return violations


def check_distinct(stats: dict[str, Stats], shot_dir: str) -> list[Violation]:
    """P5: no two captures are the same picture."""
    groups: dict[str, list[str]] = {}
    for name, stat in stats.items():
        groups.setdefault(stat.digest, []).append(name)

    violations: list[Violation] = []
    for digest, names in sorted(groups.items()):
        if len(names) > 1:
            listed = ", ".join(f"{n}.png" for n in sorted(names))
            violations.append(
                (
                    "P5 distinct",
                    f"{listed} contain identical pixels ({digest[:12]}) - they claim to "
                    f"be different screens, so at least one of them was never captured. "
                    f"If a Chinese capture is in that list, the language never applied",
                )
            )
    return violations


def check_documented() -> tuple[list[Violation], dict[str, list[str]]]:
    """P6: documented image paths resolve. Returns the reference map for the note.

    Deliberately checked against the committed location on disk rather than
    against whichever directory this run was pointed at: a document embeds the
    committed record, never a scratch directory a capture run happened to write
    to, so pointing this audit at a fresh capture must not turn the README's
    links into violations.
    """
    reference_re = re.compile(r"((?:[A-Za-z0-9_.-]+/)*docs/screens/([A-Za-z0-9_.-]+)\.png)")
    references: dict[str, list[str]] = {}
    violations: list[Violation] = []

    for doc in DOC_FILES:
        path = os.path.join(REPO_ROOT, doc)
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
        except OSError as exc:
            die(f"cannot read {doc}: {exc}")

        for match in reference_re.finditer(text):
            written, name = match.group(1), match.group(2)
            # Resolve from the referencing document's own directory, so a path
            # copied between README.md and mobile/README.md - which differ by
            # exactly one `mobile/` - is caught as the broken link it is.
            resolved = os.path.normpath(os.path.join(os.path.dirname(doc), written))
            references.setdefault(name, []).append(doc)
            if not os.path.exists(os.path.join(REPO_ROOT, resolved)):
                line = text.count("\n", 0, match.start()) + 1
                violations.append(
                    (
                        "P6 documented",
                        f"{doc}:{line} embeds {written}, which from {doc} resolves to "
                        f"{resolved} - that file does not exist, so it is a broken "
                        f"image on GitHub",
                    )
                )

    for name in references:
        references[name] = sorted(set(references[name]))
    return violations, references


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def list_directory(shot_dir: str) -> tuple[list[str], list[str]]:
    """(capture names, non-PNG entries) in the capture directory."""
    path = os.path.join(REPO_ROOT, shot_dir)
    if not os.path.isdir(path):
        die(f"{shot_dir}/ does not exist")
    try:
        entries = sorted(os.listdir(path))
    except OSError as exc:
        die(f"cannot list {shot_dir}/: {exc}")

    names = [e[:-4] for e in entries if e.endswith(".png")]
    extras = [e for e in entries if not e.endswith(".png")]
    return names, extras


def main(argv: list[str]) -> int:
    require_complete = False
    shot_dir = DEFAULT_SHOT_DIR
    positional: list[str] = []

    for argument in argv[1:]:
        if argument == "--require-complete":
            require_complete = True
        elif argument.startswith("-"):
            sys.stderr.write(f"audit_ios_screenshots: unknown option: {argument}\n")
            sys.stderr.write(__doc__ or "")
            return 2
        else:
            positional.append(argument)

    if len(positional) > 1:
        sys.stderr.write(
            f"audit_ios_screenshots: expected at most one directory, got "
            f"{len(positional)}: {' '.join(sorted(positional))}\n"
        )
        return 2
    if positional:
        # A directory inside the repository is named relative to it, the way
        # every other path in this report is. One outside it - a capture run
        # writing to a scratch directory - keeps its absolute path, because
        # `../../../tmp/...` in forty violation messages helps nobody.
        given = os.path.abspath(positional[0])
        relative = os.path.relpath(given, REPO_ROOT)
        shot_dir = given if relative.startswith("..") else relative

    captures = parse_capture_script(read_repo_text(CAPTURE_SCRIPT))
    background = parse_background_colour(read_repo_text(THEME_PATH))
    by_name = {capture.name: capture for capture in captures}

    on_disk, extras = list_directory(shot_dir)

    violations: list[Violation] = []
    manifest_violations, missing = check_manifest(
        captures, on_disk, extras, shot_dir, require_complete
    )
    violations += manifest_violations

    stats: dict[str, Stats] = {}
    sizes: dict[str, tuple[int, int]] = {}
    file_sizes: dict[str, int] = {}
    for name in on_disk:
        path = os.path.join(REPO_ROOT, shot_dir, f"{name}.png")
        file_sizes[name] = os.path.getsize(path)
        file_violations, stat, image = check_file(name, path, shot_dir, background)
        violations += file_violations
        if stat is not None and image is not None:
            stats[name] = stat
            sizes[name] = (image.width, image.height)

    violations += check_geometry(sizes, shot_dir)
    violations += check_distinct(stats, shot_dir)
    documented_violations, references = check_documented()
    violations += documented_violations

    print("Mathmon iOS capture audit")
    print("=========================")
    print(
        f"script: {CAPTURE_SCRIPT}   screens: {len(captures)}   "
        f"committed: {len(on_disk)}"
    )
    print(
        f"app background from {THEME_PATH}: "
        f"#{background[0]:02x}{background[1]:02x}{background[2]:02x}"
    )
    print()

    width = max([len(n) for n in on_disk] + [10])
    print(
        f"  {'capture'.ljust(width)}  {'pixels':>11}  {'KiB':>7}  {'colours':>7}  "
        f"{'top':>6}  {'white':>6}  {'lum':>6}  docs"
    )
    print(f"  {'-' * (width + 56)}")
    for name in on_disk:
        stat = stats.get(name)
        where = ",".join(references.get(name, [])) or "-"
        if stat is None:
            print(f"  {name.ljust(width)}  {'unreadable':>11}")
            continue
        size = sizes[name]
        print(
            f"  {name.ljust(width)}  {f'{size[0]}x{size[1]}':>11}  "
            f"{file_sizes[name] / 1024:>7.0f}  {stat.distinct_colours:>7}  "
            f"{stat.dominant_share:>6.1%}  {stat.light_share:>6.1%}  "
            f"{stat.mean_luminance:>6.1f}  {where}"
        )
    print()
    print("  top = share of the single most common colour, white = share of near-white")
    print("  pixels, lum = mean luminance. This app is dark on every screen and paints")
    print("  its own background behind everything, so a bright row here is a crash")
    print("  screen or the wrong app, not a screen of this one.")

    if missing and not require_complete:
        print()
        print("  Captured by the script but not committed (the record is incomplete;")
        print("  only a macOS runner can produce these - see mobile/README.md):")
        for name in missing:
            print(f"    {shot_dir}/{name}.png  <- {CAPTURE_SCRIPT}:{by_name[name].line}")

    unreferenced = sorted(set(on_disk) - set(references))
    if unreferenced:
        print()
        print("  Committed but embedded in no document (not a violation - a capture may")
        print("  exist purely as a record):")
        for name in unreferenced:
            print(f"    {shot_dir}/{name}.png")

    print()
    if violations:
        print("FAIL")
        for prop, message in sorted(violations):
            print(f"  {prop}: {message}")
        properties = sorted({prop for prop, _ in violations})
        print()
        print(
            f"  {len(violations)} violation(s) across {len(properties)} propert(ies): "
            f"{', '.join(properties)}"
        )
        return 1

    print(
        "OK: P1 manifest, P2 decodable, P3 geometry, P4 legible, P5 distinct, "
        "P6 documented."
    )
    print()
    print("Scope note: this proves each committed capture is a real, distinct,")
    print("phone-sized, non-blank picture of this app's own dark UI. It cannot prove")
    print("the picture is of the screen its filename claims, or that it is current -")
    print("only re-running mobile/scripts/capture_screens.sh on a simulator does that,")
    print("and only its OCR assertions prove which screen is in the frame.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
