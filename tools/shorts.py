#!/usr/bin/env python3
"""Vertical shorts cut out of a finished long-form edit.

  shorts.py list   <project>              the long cut's kept lines, by segment id
  shorts.py crops  <project>              9:16 crop per take -> build/shorts/crops.jpg
  shorts.py render <project> --quality preview|final [--count N] [--only slug]

The picks live in build/shorts.json, written by the editor (see the edit_video
skill): which segments make each short, in what order, and optionally a title
and a per-take crop. Each short becomes a small project of its own under
<project>/shorts/<slug>/ - same takes, same transcripts, the short-form profile
- and goes through the ordinary render.py -> captions.py -> finish.py chain, so
it gets the short form's tighter pauses, burned-in karaoke captions and no
fade-in for free. Output: shorts/<slug>/preview.mp4 or final.mp4.

{
  "count": 3,
  "crops": {"IMG_6526.mov": 0.55},
  "shorts": [
    {"slug": "speed", "title": "The #1 startup rule",
     "note": "why this one stands alone",
     "cuts": [{"segments": ["b03"], "note": "hook"},
              {"segments": ["b05", "b06", "b07"]}]}
  ]
}

`cuts` are EDL cuts (segment ids, trim_start/trim_end, drop) in the order they
play, so the hook can come first. Whatever the long edit dropped inside the
same segments - a restart, a doubled clause - is dropped here too, without
being restated. `crops` is where the crop is centred, as a fraction of the
take's width (or [x, y]); a take without one is centred on the face found in
its frames, which `crops` draws for checking.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

from common import (die, fmt_ts, find_font, info, load_json, load_profile,
                    load_sources, normalize_words, project_paths, run, save_json)

TOOLS = Path(__file__).resolve().parent
PROFILE = "short"
MAX_SECONDS = 59.0        # over a minute is not a Short on every platform
CROP_SAMPLES = 6          # frames per take for the crop sheet


# --------------------------------------------------------------------------
# the long edit
# --------------------------------------------------------------------------

def load_spec(paths: dict) -> dict:
    path = paths["build"] / "shorts.json"
    if not path.exists():
        die(f"no {path} - pick the shorts first (see the edit_video skill)")
    try:
        spec = load_json(path)
    except json.JSONDecodeError as exc:
        die(f"{path} is not valid JSON: {exc}")
    shorts = spec.get("shorts") or []
    if not shorts:
        die(f"{path} lists no shorts")
    slugs = [s.get("slug") for s in shorts]
    if any(not s or "/" in s for s in slugs) or len(set(slugs)) != len(slugs):
        die("every short needs a unique slug (a folder name)")
    for s in shorts:
        if not s.get("cuts"):
            die(f"short '{s['slug']}' has no cuts")
    return spec


def long_cuts(paths: dict) -> list[dict]:
    edl = paths["build"] / "edl.json"
    if not edl.exists():
        die("no build/edl.json - the long edit comes first")
    return load_json(edl)["cuts"]


def inherit(cut: dict, cuts: list[dict], order: dict,
            segments: dict) -> tuple[dict, list[str]]:
    """Carry the long edit's fixes inside these segments over to the short.

    A `drop` is a source-time range, so it applies wherever its segments are
    reused. A trim only describes the edge of a cut, so it carries over only
    when the short's cut shares that edge."""
    ids = cut.get("segments") or []
    if not ids:
        return cut, []
    out, log = dict(cut), []
    mine = sorted(ids, key=lambda i: order.get(i, 0))
    drops = [list(d) for d in cut.get("drop", [])]
    # a drop written on the short's own cut replaces any inherited one it
    # overlaps: that is how a short corrects a range the long edit got wrong
    own = [(float(a), float(b)) for a, b in cut.get("own_drop", [])]
    lo = min(segments[i]["start"] for i in ids) - 0.5
    hi = max(segments[i]["end"] for i in ids) + 0.5
    for lc in cuts:
        theirs = sorted(lc.get("segments") or [], key=lambda i: order.get(i, 0))
        if not set(theirs) & set(ids):
            continue
        for d in lc.get("drop", []):
            if not (d[0] < hi and lo < d[1]):
                continue
            if any(d[0] < b and a < d[1] for a, b in own):
                log.append(f"drop {d[0]:.2f}-{d[1]:.2f} replaced")
                continue
            if list(d) not in drops:
                drops.append(list(d))
                log.append(f"drop {d[0]:.2f}-{d[1]:.2f}")
        if theirs[0] == mine[0] and "trim_start" in lc and "trim_start" not in cut:
            out["trim_start"] = lc["trim_start"]
            log.append(f"trim_start {lc['trim_start']}")
        if theirs[-1] == mine[-1] and "trim_end" in lc and "trim_end" not in cut:
            out["trim_end"] = lc["trim_end"]
            log.append(f"trim_end {lc['trim_end']}")
    # edge_anchors already cut both edges on a word, with a drop reaching
    # 1.5 s past the segment. An inherited trim that pushes the edge further
    # out (the long edit carrying a sentence the first transcript missed)
    # would reach past that drop and play the next word - so widen it.
    first, last = segments[mine[0]], segments[mine[-1]]
    extend = (("trim_end", 1, round(last["end"] + 1.5, 3), lambda t: last["end"] + t + 0.5),
              ("trim_start", 0, round(first["start"] - 1.5, 3), lambda t: first["start"] + t - 0.5))
    for key, side, edge, wider in extend:
        trim = float(out.get(key, 0.0))
        if (trim > 0) if key == "trim_end" else (trim < 0):
            for d in drops:
                if d[side] == edge:
                    d[side] = round(wider(trim), 3)
    out.pop("own_drop", None)
    if drops:
        out["drop"] = drops
    return out, log


def edge_anchors(cut: dict, segments: dict, order: dict, paths: dict,
                 sources: dict, warnings: list[str]) -> dict:
    """Cut every edge of a short's cut on a word, not on a segment boundary.

    Segment boundaries come from the speech recogniser and are loose: a
    segment can end on the first syllable of the next one ("So", then a long
    pause) or begin on the tail of the last one. The long edit gets away with
    that because its neighbours are usually kept; a short skips most of the
    take, so every edge borders material that must not leak in. Each run of
    adjacent segments is therefore trimmed to its first and last word.

    `start_at` / `end_at` move the first or last edge onto a phrase inside the
    segment instead: open on "marketing is more important than your code",
    not on "The third thing I learned is" that leads into it. Every time
    comes from the transcript's word timings; none is typed by hand."""
    ids = cut.get("segments") or []
    if not ids:
        return cut
    out = {k: v for k, v in cut.items() if k not in ("start_at", "end_at")}
    drops = [list(d) for d in cut.get("drop", [])]
    out["own_drop"] = [list(d) for d in cut.get("drop", [])]
    source = segments[ids[0]]["source"]
    silences = sources[source]["silences"]
    data = load_json(paths["transcripts"] / f"{Path(source).stem}.json")
    every = [w for sg in data["segments"] for w in sg["words"]]

    def words_of(sid: str) -> list[dict]:
        seg = segments[sid]
        return [w for w in every if seg["start"] - 0.05 <= w["s"] < seg["end"]]

    def find(sid: str, phrase: str) -> tuple[dict, dict]:
        want = normalize_words(phrase)
        flat = [(w, t) for w in words_of(sid) for t in normalize_words(w["w"])]
        for k in range(len(flat) - len(want) + 1):
            if [t for _, t in flat[k:k + len(want)]] == want:
                return flat[k][0], flat[k + len(want) - 1][0]
        die(f"phrase {phrase!r} is not in segment {sid}: "
            f"{segments[sid]['text'].strip()!r}")

    def head(word: dict) -> float:
        # recognised onsets run early, if anything: cutting just before one
        # lands in the silence ahead of the word
        return round(word["s"] - 0.04, 3)

    def tail(word: dict) -> float:
        # a word's recognised end is the next word's onset, so it can swallow
        # the whole pause after it - and the start of whatever follows. End
        # inside the first silence after the word instead.
        # The recognised onset can itself land a little late, so a silence
        # that starts just before it still counts as the one after the word.
        for a, b in silences:
            if b > word["s"] + 0.1 and a <= word["e"] + 0.05 and b - a >= 0.15:
                return round(min(max(a, word["s"] + 0.1) + 0.12, b), 3)
        return round(word["e"] - 0.03, 3)

    runs: list[list[str]] = []
    for sid in sorted(ids, key=lambda i: order[i]):
        if runs and order[sid] == order[runs[-1][-1]] + 1:
            runs[-1].append(sid)
        else:
            runs.append([sid])

    for k, run_ids in enumerate(runs):
        first_seg, last_seg = run_ids[0], run_ids[-1]
        fw = words_of(first_seg)
        lw = words_of(last_seg)
        if not fw or not lw:
            continue
        first = find(first_seg, cut["start_at"])[0] if k == 0 and cut.get("start_at") else fw[0]
        last = find(last_seg, cut["end_at"])[1] if k == len(runs) - 1 and cut.get("end_at") else lw[-1]
        h, t = head(first), tail(last)
        drops.append([round(segments[first_seg]["start"] - 1.5, 3), h])
        drops.append([t, round(segments[last_seg]["end"] + 1.5, 3)])
        # an edge with no pause at it cuts through running speech: the
        # neighbouring word is likely audible ("see. Can I repeat...")
        for at, word in ((h, first), (t, last)):
            if not any(a - 0.1 <= at <= b + 0.1 for a, b in silences):
                warnings.append(f"no pause at '{word['w']}' ({fmt_ts(at)}): the "
                                f"neighbouring word may be heard - start or end "
                                f"the cut on a sentence next to a pause")
    out["drop"] = drops
    return out


# --------------------------------------------------------------------------
# list
# --------------------------------------------------------------------------

def cmd_list(paths: dict) -> int:
    """The kept material of the long cut, so a short is picked from lines that
    already survived the editorial pass, never from a retake."""
    segments = {s["id"]: s for s in load_json(paths["build"] / "segments.json")["segments"]}
    timeline = load_json(paths["build"] / "timeline.json")
    starts: dict[str, float] = {}
    for tc in timeline["cuts"]:
        for sid in tc["segments"]:
            starts.setdefault(sid, tc["out_start"])
    total = 0.0
    print(f"Long cut {fmt_ts(timeline['duration'])}. Kept segments in play order "
          f"(id, length, words), each cut headed by where it plays:\n")
    for n, cut in enumerate(long_cuts(paths), 1):
        ids = cut.get("segments") or []
        if not ids:
            continue
        note = cut.get("note", "").split(".")[0][:90]
        at = next((starts[i] for i in ids if i in starts), None)
        when = f" @ {fmt_ts(at)[:-3]}" if at is not None else ""
        print(f"## cut {n}{when}" + (f" - {note}" if note else ""))
        extras = [k for k in ("trim_start", "trim_end", "drop") if k in cut]
        if extras:
            print(f"   (long edit applies {', '.join(extras)} here; inherited)")
        for sid in ids:
            seg = segments.get(sid)
            if not seg:
                continue
            length = seg["end"] - seg["start"]
            total += length
            print(f"  {sid:<4} {length:4.1f}s  {seg['text'].strip()}")
        print()
    print(f"{total / 60:.1f} min of kept speech. A short is 20-55s: one idea, "
          f"a hook in the first two seconds, an ending that lands.")
    return 0


# --------------------------------------------------------------------------
# crops
# --------------------------------------------------------------------------

def used_ranges(spec: dict, segments: dict) -> dict[str, list[tuple[float, float]]]:
    """Source-time ranges each take contributes to any short."""
    out: dict[str, list[tuple[float, float]]] = {}
    for short in spec["shorts"]:
        for cut in short["cuts"]:
            for sid in cut.get("segments") or []:
                seg = segments.get(sid)
                if seg is None:
                    die(f"short '{short['slug']}' uses unknown segment {sid}")
                out.setdefault(seg["source"], []).append((seg["start"], seg["end"]))
            if cut.get("source"):
                out.setdefault(cut["source"], []).append(
                    (float(cut["start"]), float(cut["end"])))
    return out


def sample_times(ranges: list[tuple[float, float]], n: int) -> list[float]:
    """n moments spread evenly across the material actually used."""
    total = sum(b - a for a, b in ranges)
    times = []
    for k in range(n):
        target = total * (k + 0.5) / n
        for a, b in sorted(ranges):
            if target <= b - a:
                times.append(round(a + target, 2))
                break
            target -= b - a
    return times


def grab(video: str, t: float, out: Path) -> bool:
    """One display-oriented frame (ffmpeg applies the rotation tag)."""
    if out.exists():
        return True
    out.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                           "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
                           "-vf", "scale=640:-2", "-q:v", "3", str(out)],
                          capture_output=True)
    return proc.returncode == 0 and out.exists()


def faces(frame: Path) -> tuple[float, float, float] | None:
    """Centre (x, y) and height of the biggest face, as frame fractions."""
    import cv2
    cascade = cv2.CascadeClassifier(
        str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"))
    img = cv2.imread(str(frame))
    if img is None:
        return None
    gray = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    found = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6,
                                     minSize=(32, 32))
    if len(found) == 0:
        return None
    x, y, w, h = max(found, key=lambda f: f[2] * f[3])
    H, W = img.shape[:2]
    return (x + w / 2) / W, (y + h / 2) / H, h / H


def detect_crops(paths: dict, spec: dict, sources: dict) -> dict[str, dict]:
    """Per take: the sampled frames, the faces in them, the crop centre."""
    segments = {s["id"]: s for s in load_json(paths["build"] / "segments.json")["segments"]}
    work = paths["build"] / "shorts" / "frames"
    result = {}
    for name, ranges in used_ranges(spec, segments).items():
        src = sources.get(name)
        if src is None:
            die(f"unknown take {name}")
        times = sample_times(ranges, CROP_SAMPLES)
        frames, found = [], []
        for t in times:
            jpg = work / f"{Path(name).stem}_{t:08.2f}.jpg"
            if not grab(src["video"], t, jpg):
                continue
            face = faces(jpg)
            frames.append({"t": t, "file": jpg, "face": face})
            if face:
                found.append(face)
        if found:
            auto = round(statistics.median(f[0] for f in found), 3)
        else:
            auto = 0.5
        manual = (spec.get("crops") or {}).get(name)
        if isinstance(manual, (int, float)):
            manual = [float(manual), None]
        result[name] = {"frames": frames, "auto": auto,
                        "faces": f"{len(found)}/{len(frames)}",
                        "x": float(manual[0]) if manual else auto,
                        "y": manual[1] if manual and manual[1] is not None else None,
                        "manual": bool(manual), "width": src["width"],
                        "height": src["height"]}
    return result


def crop_offsets(centre_x: float, centre_y: float | None, src_w: int, src_h: int,
                 out_w: int, out_h: int) -> dict:
    """render.py's fill crop takes an *offset* fraction of the slack, not a
    centre: left = (iw - ow) * x. Convert, so the face sits where asked."""
    s = max(out_w / src_w, out_h / src_h)
    iw, ih = src_w * s, src_h * s

    def offset(centre: float, inner: float, outer: float) -> float:
        if inner - outer < 1:
            return 0.5
        return min(1.0, max(0.0, (centre * inner - outer / 2) / (inner - outer)))

    return {"x": round(offset(centre_x, iw, out_w), 4),
            "y": round(offset(centre_y if centre_y is not None else 0.42, ih, out_h), 4)}


def crop_window(c: dict, out_w: int, out_h: int) -> tuple[float, float]:
    """Left and right edge of the 9:16 window, as fractions of the take."""
    s = max(out_w / c["width"], out_h / c["height"])
    span = min(1.0, out_w / s / c["width"])
    left = min(max(c["x"] - span / 2, 0.0), 1.0 - span)
    return left, left + span


def cmd_crops(paths: dict, spec: dict, sources: dict, profile: dict) -> dict:
    from PIL import Image, ImageDraw, ImageFont

    crops = detect_crops(paths, spec, sources)
    out_w, out_h = profile["video"]["width"], profile["video"]["height"]
    font_path = find_font("bold")
    font = ImageFont.truetype(str(font_path), 22) if font_path else ImageFont.load_default()
    small = ImageFont.truetype(str(font_path), 16) if font_path else ImageFont.load_default()

    rows = []
    for name, c in crops.items():
        left, right = crop_window(c, out_w, out_h)
        tiles = []
        for f in c["frames"]:
            im = Image.open(f["file"]).convert("RGB")
            W, H = im.size
            shade = Image.new("RGBA", im.size, (0, 0, 0, 0))
            d = ImageDraw.Draw(shade)
            d.rectangle([0, 0, int(left * W), H], fill=(0, 0, 0, 150))
            d.rectangle([int(right * W), 0, W, H], fill=(0, 0, 0, 150))
            im = Image.alpha_composite(im.convert("RGBA"), shade).convert("RGB")
            d = ImageDraw.Draw(im)
            d.rectangle([int(left * W), 0, int(right * W) - 1, H - 1],
                        outline=(255, 214, 0), width=3)
            if f["face"]:
                fx, fy, fh = f["face"]
                r = fh * H / 2
                d.ellipse([fx * W - r, fy * H - r, fx * W + r, fy * H + r],
                          outline=(255, 60, 60), width=2)
            d.text((6, H - 22), fmt_ts(f["t"]), font=small, fill=(255, 255, 255))
            tiles.append(im)
        if not tiles:
            continue
        label = (f"{name}   crop centre x={c['x']:.2f}"
                 + (" (set in shorts.json)" if c["manual"] else
                    f" (face found in {c['faces']} frames)"))
        rows.append((label, tiles))

    if not rows:
        die("no frames could be read for any take")
    tw, th = rows[0][1][0].size
    cols = max(len(t) for _, t in rows)
    gap, head = 6, 34
    sheet = Image.new("RGB", (cols * (tw + gap) + gap,
                              len(rows) * (th + head + gap) + gap), (24, 24, 24))
    d = ImageDraw.Draw(sheet)
    y = gap
    for label, tiles in rows:
        d.text((gap + 2, y + 6), label, font=font, fill=(255, 255, 255))
        for k, tile in enumerate(tiles):
            sheet.paste(tile, (gap + k * (tw + gap), y + head))
        y += th + head + gap
    out = paths["build"] / "shorts" / "crops.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=85)
    print(f"{out}")
    for name, c in crops.items():
        print(f"  {name}: centre x={c['x']:.2f}"
              + ("  (manual)" if c["manual"] else
                 f"  (face in {c['faces']} frames; auto {c['auto']:.2f})"))
    return crops


# --------------------------------------------------------------------------
# render
# --------------------------------------------------------------------------

def map_fixes(fixes: dict, long_tl: dict, short_tl: dict) -> dict:
    """Re-time the long edit's spelling fixes onto the short's timeline.

    An `at` is an output time, so it means nothing in another cut. Go back to
    the take and forward again: an entry whose word the short does not use
    is left out."""
    def to_source(at: float):
        for c in long_tl["cuts"]:
            if c["out_start"] - 0.05 <= at <= c["out_end"] + 0.05:
                return c["source"], c["src_start"] + (at - c["out_start"])
        return None

    def to_short(source: str, t: float):
        for c in short_tl["cuts"]:
            if c["source"] == source and c["src_start"] - 0.3 <= t <= c["src_end"]:
                return round(max(c["out_start"], c["out_start"] + t - c["src_start"]), 3)
        return None

    # Only spelling travels: a product name, a numeral. A `drop` or a pure
    # change of case was a judgement about one of the long edit's joins - a
    # syllable nobody hears, a sentence that now starts mid-flow - and the
    # short's joins are different (sentence_starts redoes the casing).
    entries = fixes.get("replace", [])
    if isinstance(entries, dict):
        entries = [{"from": k, "to": v} for k, v in entries.items()]
    kept = []
    for e in entries:
        if str(e.get("from", "")).lower() == str(e.get("to", "")).lower():
            continue
        if "at" not in e:
            kept.append(e)
            continue
        src = to_source(float(e["at"]))
        at = to_short(*src) if src else None
        if at is not None:
            kept.append({**e, "at": at})
    out = {"replace": kept} if kept else {}
    if fixes.get("emoji"):
        out["emoji"] = fixes["emoji"]
    return out


def sentence_starts(root: Path, timeline: dict, fixes: dict) -> list[dict]:
    """A short opens mid-sentence and joins lines from far apart, so its
    captions can start a sentence in lower case ("marketing is more
    important...", "zone. but it was"). Capitalise every such word."""
    from captions import apply_fixes, collect_words
    words = collect_words(project_paths(str(root)), timeline)
    words, _ = apply_fixes(words, json.loads(json.dumps(fixes)))
    out = []
    for i, w in enumerate(words):
        starts = i == 0 or words[i - 1]["w"].endswith((".", "?", "!"))
        if starts and w["w"][:1].islower():
            out.append({"at": w["s"], "from": w["w"],
                        "to": w["w"][:1].upper() + w["w"][1:]})
    return out


def title_png(text: str, width: int, out: Path) -> int:
    """A title bar for the top of the frame: dark text on a white rounded
    card, lines centred. Drawn here because drawtext cannot centre lines."""
    from PIL import Image, ImageDraw, ImageFont
    size = int(width * 0.068)
    font_path = find_font("black") or find_font("bold")
    font = ImageFont.truetype(str(font_path), size)

    def wrap(limit: float) -> list[str]:
        lines, line = [], ""
        for word in text.split():
            trial = f"{line} {word}".strip()
            if line and font.getlength(trial) > limit:
                lines.append(line)
                line = word
            else:
                line = trial
        return lines + [line]

    # as few lines as fit, then as even as they can be: no orphaned last word
    lines = wrap(width * 0.8)
    for step in range(1, 40):
        tighter = wrap(width * 0.8 - step * width * 0.015)
        if len(tighter) > len(lines):
            break
        lines = tighter
    pad_x, pad_y, lead = int(size * 0.6), int(size * 0.45), int(size * 1.18)
    text_w = max(font.getlength(ln) for ln in lines)
    w, h = int(text_w + pad_x * 2), int(lead * len(lines) + pad_y * 2 - size * 0.18)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(size * 0.35),
                        fill=(255, 255, 255, 245))
    for k, ln in enumerate(lines):
        d.text(((w - font.getlength(ln)) / 2, pad_y + k * lead), ln,
               font=font, fill=(17, 17, 17))
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    return w


def tool(name: str, *args: str) -> None:
    proc = subprocess.run([sys.executable, str(TOOLS / name), *args],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout[-3000:] + proc.stderr[-3000:])
        die(f"{name} failed for {args[0]}")
    for line in (proc.stdout + proc.stderr).splitlines():
        if line.strip().startswith("check:"):
            print(f"    {line.strip()}")


def setup_short(paths: dict, short: dict, manifest: dict, crops: dict,
                cuts: list[dict], order: dict, profile: dict) -> tuple[Path, list[str]]:
    """Lay out shorts/<slug>/ as a project the ordinary tools can render."""
    root = paths["root"] / "shorts" / short["slug"]
    build = root / "build"
    build.mkdir(parents=True, exist_ok=True)
    link = root / "transcripts"
    if not link.exists():
        os.symlink(os.path.relpath(paths["transcripts"], root), link)

    save_json(build / "sources.json", {**manifest, "profile": PROFILE})
    shutil.copyfile(paths["build"] / "segments.json", build / "segments.json")

    segments = {s["id"]: s for s in load_json(paths["build"] / "segments.json")["segments"]}
    sources = {s["name"]: s for s in manifest["sources"]}
    log, edl_cuts = [], []
    for cut in short["cuts"]:
        edges: list[str] = []
        c, why = inherit(edge_anchors(cut, segments, order, paths, sources, edges),
                         cuts, order, segments)
        edl_cuts.append(c)
        log += why
        for w in edges:
            print(f"  note: {short['slug']}: {w}")
    # every edge of a short is a fresh join next to a long pause, which is
    # exactly where the recogniser's word timings drift (see captions.py)
    save_json(build / "edl.json", {"profile": PROFILE, "note": short.get("note", ""),
                                   "realign_words": True, "cuts": edl_cuts})

    out_w, out_h = profile["video"]["width"], profile["video"]["height"]
    focus = {name: {**crop_offsets(c["x"], c["y"], c["width"], c["height"], out_w, out_h),
                    "centre": c["x"]}
             for name, c in crops.items()}
    save_json(build / "focus.json", focus)
    return root, log


def estimate(short: dict, segments: dict) -> float:
    total = 0.0
    for cut in short["cuts"]:
        for sid in cut.get("segments") or []:
            total += segments[sid]["end"] - segments[sid]["start"]
        if cut.get("source"):
            total += float(cut["end"]) - float(cut["start"])
        total -= sum(float(b) - float(a) for a, b in cut.get("drop", []))
    return total


def review_sheet(paths: dict, done: list[tuple[str, Path, float]], quality: str) -> Path:
    """Four frames from each rendered short, side by side."""
    from PIL import Image, ImageDraw, ImageFont
    work = paths["build"] / "shorts" / "review"
    work.mkdir(parents=True, exist_ok=True)
    font_path = find_font("bold")
    font = ImageFont.truetype(str(font_path), 22) if font_path else ImageFont.load_default()
    rows = []
    for slug, video, dur in done:
        tiles = []
        for k, frac in enumerate((0.04, 0.3, 0.6, 0.9)):
            jpg = work / f"{slug}_{quality}_{k}.jpg"
            jpg.unlink(missing_ok=True)
            run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                 "-ss", f"{dur * frac:.2f}", "-i", str(video), "-frames:v", "1",
                 "-vf", "scale=270:-2", str(jpg)])
            tiles.append(Image.open(jpg).convert("RGB"))
        rows.append((f"{slug}  ({fmt_ts(dur)[:-3]})", tiles))
    tw, th = rows[0][1][0].size
    gap, head = 8, 34
    sheet = Image.new("RGB", (4 * (tw + gap) + gap, len(rows) * (th + head + gap) + gap),
                      (24, 24, 24))
    d = ImageDraw.Draw(sheet)
    y = gap
    for label, tiles in rows:
        d.text((gap, y + 6), label, font=font, fill=(255, 255, 255))
        for k, tile in enumerate(tiles):
            sheet.paste(tile, (gap + k * (tw + gap), y + head))
        y += th + head + gap
    out = paths["build"] / "shorts" / f"review_{quality}.jpg"
    sheet.save(out, quality=85)
    return out


def cmd_render(paths: dict, spec: dict, args) -> int:
    manifest = load_sources(paths)
    sources = {s["name"]: s for s in manifest["sources"]}
    profile = load_profile(PROFILE)
    segments = {s["id"]: s for s in load_json(paths["build"] / "segments.json")["segments"]}
    order = {sid: i for i, sid in enumerate(segments)}
    cuts = long_cuts(paths)
    kept = {sid for c in cuts for sid in c.get("segments") or []}

    shorts = spec["shorts"]
    if args.only:
        shorts = [s for s in shorts if s["slug"] in args.only]
        if not shorts:
            die(f"no short called {', '.join(args.only)}")
    count = args.count or spec.get("count") or len(shorts)
    shorts = shorts[:count]

    long_tl = load_json(paths["build"] / "timeline.json")
    fixes = {}
    fpath = paths["build"] / "caption_fixes.json"
    if fpath.exists() and fpath.stat().st_size > 0:
        fixes = load_json(fpath)

    crops = cmd_crops(paths, {**spec, "shorts": shorts}, sources, profile)
    print()

    done = []
    for n, short in enumerate(shorts, 1):
        slug = short["slug"]
        stray = [sid for c in short["cuts"] for sid in c.get("segments") or []
                 if sid not in kept]
        if stray:
            print(f"  note: '{slug}' uses {', '.join(stray)}, which the long "
                  f"edit left out - check it is not a retake")
        guess = estimate(short, segments)
        info(f"[{n}/{len(shorts)}] {slug}: {len(short['cuts'])} cut(s), "
             f"~{guess:.0f}s of speech before pause trimming")
        take_crops = {name: crops[name] for name in
                      {segments[sid]["source"] for c in short["cuts"]
                       for sid in c.get("segments") or []}
                      | {c["source"] for c in short["cuts"] if c.get("source")}}
        root, log = setup_short(paths, short, manifest, take_crops, cuts, order, profile)
        if log:
            info(f"    from the long edit: {', '.join(log)}")

        tool("render.py", str(root), "--quality", args.quality)
        short_tl = load_json(root / "build" / "timeline.json")
        dur = short_tl["duration"]

        mapped = map_fixes(fixes, long_tl, short_tl)
        extra = short.get("caption_fixes") or {}
        for key in ("replace", "drop"):
            if extra.get(key):
                mapped[key] = mapped.get(key, []) + extra[key]
        caps = sentence_starts(root, short_tl, mapped)
        if caps:
            mapped.setdefault("replace", []).extend(caps)
        save_json(root / "build" / "caption_fixes.json", mapped)

        overlays = list(short.get("overlays") or [])
        if short.get("title"):
            png_w = title_png(short["title"], short_tl["width"],
                              root / "build" / "title.png")
            overlays.insert(0, {"type": "image", "file": "build/title.png",
                                "start": 0, "end": dur,
                                "scale": round(png_w / short_tl["width"], 4),
                                "position": [0.5, 0.075], "fade": 0.0,
                                "note": "title"})
        save_json(root / "build" / "overlays.json", {"overlays": overlays})

        tool("captions.py", str(root))
        tool("finish.py", str(root), "--quality", args.quality)
        out = root / f"{args.quality}.mp4"
        flag = "  OVER A MINUTE" if dur > MAX_SECONDS else ""
        print(f"  {slug:<24} {fmt_ts(dur)[:-3]:>6}  {out}{flag}")
        tool("words.py", str(root))
        if not args.no_listen:
            from listen import listen
            problems, _ = listen(root, out)
            for problem in problems:
                print(f"    check: {problem}")
        done.append((slug, out, dur))

    sheet = review_sheet(paths, done, args.quality)
    print(f"\n{sheet}   (look at it: crop, captions, title)")
    others = sorted(p.name for p in (paths["root"] / "shorts").iterdir()
                    if p.is_dir() and p.name not in {s["slug"] for s in spec["shorts"]})
    if others:
        print(f"  not in shorts.json any more: {', '.join(others)}")
    return 0


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["list", "crops", "render"])
    ap.add_argument("project")
    ap.add_argument("--quality", default="preview", choices=["preview", "final"])
    ap.add_argument("--count", type=int, default=None,
                    help="render only the first N shorts in shorts.json")
    ap.add_argument("--no-listen", action="store_true",
                    help="skip re-transcribing each short to check it")
    ap.add_argument("--only", action="append", default=[],
                    help="render only this slug; repeatable")
    args = ap.parse_args()

    paths = project_paths(args.project)
    if not (paths["build"] / "timeline.json").exists():
        die("no build/timeline.json - render the long edit first")
    if args.command == "list":
        return cmd_list(paths)
    spec = load_spec(paths)
    if args.command == "crops":
        sources = {s["name"]: s for s in load_sources(paths)["sources"]}
        cmd_crops(paths, spec, sources, load_profile(PROFILE))
        return 0
    return cmd_render(paths, spec, args)


if __name__ == "__main__":
    sys.exit(main())
