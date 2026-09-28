#!/usr/bin/env python3
"""Step 5 - turn an EDL into a cut video.

The EDL references segment ids; this script resolves them to real timestamps,
snaps every cut point into the middle of the neighbouring pause, renders each
piece to a normalised intermediate, then joins them.

Intermediates are content-hashed, so tweaking one cut in a 40-cut edit
re-renders one clip instead of forty.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

from common import (die, digest, fmt_ts, info, load_json, load_profile, preview_encoder,
                    project_paths, run, save_json)

DECLICK = 0.02          # audio fade at each cut boundary, seconds


# --------------------------------------------------------------------------
# resolving the EDL
# --------------------------------------------------------------------------

def snap_start(silences: list[list[float]], t: float, pad: float,
               reach: float) -> float:
    """Move a cut-in backwards into the tail of the preceding pause."""
    # The cut point often already sits inside a pause, because ASR segment
    # boundaries include the trailing space. Stay inside that pause.
    for s, e in silences:
        if s <= t <= e:
            return max(0.0, max(s + 0.06, t - pad))
    best = None
    for s, e in silences:
        if e <= t + 0.08 and t - e <= reach:
            if best is None or e > best[1]:
                best = (s, e)
    if best is None:
        return max(0.0, t - pad)
    s, e = best
    return max(0.0, min(max(s + 0.06, e - pad), t))


def snap_end(silences: list[list[float]], t: float, pad: float, reach: float,
             limit: float) -> float:
    """Move a cut-out forwards into the head of the following pause."""
    for s, e in silences:
        if s <= t <= e:
            # Never let the padding run past the pause into the next word.
            return min(limit, max(t, min(t + pad, e - 0.06)))
    best = None
    for s, e in silences:
        if s >= t - 0.08 and s - t <= reach:
            if best is None or s < best[0]:
                best = (s, e)
    if best is None:
        return min(limit, t + pad)
    s, e = best
    return min(limit, max(t, min(max(e - 0.06, s), s + pad)))


def contiguous_runs(chosen: list[dict], order: dict) -> list[list[dict]]:
    """Split a cut's segments into runs that are adjacent in the take.

    A cut renders as one continuous span of source time, so a segment the
    editorial pass deliberately left out has to break the cut in two -
    otherwise the dropped line is still in the video. Listing only the
    segments you want to keep is the natural way to write an EDL, so the
    splitting happens here rather than being the editor's problem."""
    chosen = sorted(chosen, key=lambda s: order[s["id"]])
    runs = [[chosen[0]]]
    for seg in chosen[1:]:
        if order[seg["id"]] == order[runs[-1][-1]["id"]] + 1:
            runs[-1].append(seg)
        else:
            runs.append([seg])
    return runs


def coalesce(silences: list, bridge: float = 0.05
             ) -> list[tuple[float, float]]:
    """Join silences that are really one pause reported in pieces.

    The silence map splits on its own detection boundaries, so a single
    three-second pause can arrive as four abutting entries. Measured one by
    one none of them looks long enough to cut, and the pause survives.
    """
    merged: list[list[float]] = []
    for raw_s, raw_e in sorted((float(a), float(b)) for a, b in silences):
        if merged and raw_s - merged[-1][1] <= bridge:
            merged[-1][1] = max(merged[-1][1], raw_e)
        else:
            merged.append([raw_s, raw_e])
    return [(a, b) for a, b in merged]


def excise(start: float, end: float, drops: list) -> list[tuple[float, float]]:
    """Remove source-time ranges from inside a span.

    Segment ids cannot address a sentence that restarts itself *inside* one
    segment, and that is where most of the duplication in talking-head footage
    lives. The renderer already knows how to split a span and rejoin it for a
    pause, so this reuses that: the join lands where the duplicate was.

    Derive the range from the word timings in the transcript. Never estimate
    it - a range guessed from the audio clips a syllable.
    """
    spans = [(start, end)]
    for raw_a, raw_b in sorted((float(a), float(b)) for a, b in drops):
        out: list[tuple[float, float]] = []
        for a, b in spans:
            if raw_b <= a or raw_a >= b:
                out.append((a, b))
                continue
            if a < raw_a:
                out.append((a, raw_a))
            if raw_b < b:
                out.append((raw_b, b))
        spans = out
    return [(a, b) for a, b in spans if b - a >= 0.08]


def compress_pauses(start: float, end: float, silences: list,
                    max_pause: float, min_saving: float = 0.4
                    ) -> list[tuple[float, float]]:
    """Split a span at long internal pauses, dropping the dead air.

    A pause the speaker took mid-thought is just dead air on the timeline.
    Removing it means ending one clip as the pause starts and beginning the
    next one just before they speak again - the join lands inside silence,
    which is the least noticeable place to put one. `max_pause` of the
    original is kept, split either side of the join, so the delivery still
    breathes instead of snapping shut.

    The second and later spans are flagged so merge_adjacent leaves them
    alone - they sit close together by construction, and fusing them back
    would silently undo the trim.
    """
    if not max_pause or max_pause <= 0:
        return [(start, end)]
    keep = max_pause / 2.0
    sil = coalesce(silences)

    # A segment's transcribed end can sit well past the last word, so a span
    # may begin or end deep inside a pause. Snapping alone will not pull it
    # back out, and the result is dead air at the head or tail of the clip.
    for a, b in sil:
        if b - a <= max_pause + min_saving:
            continue
        if a <= start < b < end:
            start = max(start, b - keep)
        if start < a < end <= b:
            end = min(end, a + keep)
    if end - start < 0.08:
        return [(start, end, False)]

    spans: list[tuple[float, float]] = []
    cursor = start
    for s, e in sil:
        if e - s <= max_pause + min_saving:
            continue
        if s <= cursor + keep or e >= end - keep:
            continue
        spans.append((cursor, s + keep))
        cursor = e - keep
    spans.append((cursor, end))
    return [(a, b, i > 0) for i, (a, b) in enumerate(spans) if b - a >= 0.08]


def resolve_cuts(edl: dict, segments: list[dict], sources: list[dict],
                 profile: dict) -> list[dict]:
    by_id = {s["id"]: s for s in segments}
    by_name = {s["name"]: s for s in sources}
    order = {s["id"]: i for i, s in enumerate(segments)}
    pad = profile["audio"]["cut_padding"]
    reach = profile["audio"]["snap_reach"]
    max_pause = float(profile["audio"].get("max_pause") or 0.0)
    min_saving = float(profile["audio"].get("min_pause_saving") or 0.4)
    trimmed = 0.0
    excised = 0.0

    resolved: list[dict] = []
    for n, cut in enumerate(edl["cuts"], 1):
        if cut.get("segments"):
            ids = cut["segments"]
            missing = [i for i in ids if i not in by_id]
            if missing:
                die(f"cut #{n} references unknown segment id(s): {missing}")
            chosen = [by_id[i] for i in ids]
            keys = {s["key"] for s in chosen}
            if len(keys) > 1:
                die(f"cut #{n} mixes takes {sorted(keys)} - split it into "
                    f"one cut per take")
            source = by_name[chosen[0]["source"]]
            spans = [([s["id"] for s in run],
                      min(s["start"] for s in run),
                      max(s["end"] for s in run))
                     for run in contiguous_runs(chosen, order)]
            if len(spans) > 1:
                dropped = sorted(
                    set(range(order[chosen[0]["id"]],
                              order[max(chosen, key=lambda s: order[s["id"]])["id"]]))
                    - {order[s["id"]] for s in chosen})
                info(f"  cut #{n} skips {len(dropped)} segment(s) inside its "
                     f"range - splitting into {len(spans)} spans")
        elif cut.get("source"):
            source = by_name.get(cut["source"])
            if source is None:
                die(f"cut #{n} references unknown source '{cut['source']}'")
            if "start" not in cut or "end" not in cut:
                die(f"cut #{n} needs both start and end")
            spans = [([], float(cut["start"]), float(cut["end"]))]
        else:
            die(f"cut #{n} has neither 'segments' nor 'source'")

        for span_n, (ids, raw_start, raw_end) in enumerate(spans):
            start = snap_start(source["silences"], raw_start, pad, reach)
            end = snap_end(source["silences"], raw_end, pad, reach,
                           source["duration"])
            # trims describe the edges of the cut, not of every span inside it
            if span_n == 0:
                start = max(0.0, start + float(cut.get("trim_start", 0.0)))
            if span_n == len(spans) - 1:
                end = min(source["duration"],
                          end + float(cut.get("trim_end", 0.0)))
            if end - start < 0.08:
                die(f"cut #{n} resolves to {end - start:.2f}s - check its "
                    f"segment ids")

            pieces = excise(start, end, cut.get("drop", []))
            if not pieces:
                die(f"cut #{n} has nothing left after its drop ranges")
            excised += (end - start) - sum(b - a for a, b in pieces)

            parts = []
            for piece_n, (piece_start, piece_end) in enumerate(pieces):
                for sub_n, part in enumerate(
                        compress_pauses(piece_start, piece_end,
                                        source["silences"], max_pause,
                                        min_saving)):
                    # anything after the first is held apart on purpose, so
                    # merge_adjacent must not fuse it back together
                    parts.append(part[:2] + (part[2] or piece_n or sub_n,
                                             piece_n > 0 and sub_n == 0))
            trimmed += sum(b - a for a, b in pieces) \
                - sum(b - a for a, b, *_ in parts)
            for sub_n, (sub_start, sub_end, pause_split, exact) in enumerate(parts):
                first = span_n == 0 and sub_n == 0
                resolved.append({
                    "source": source["name"],
                    "video": source["video"],
                    "start": round(sub_start, 3),
                    "end": round(sub_end, 3),
                    "segments": ids if first else [],
                    "note": cut.get("note", "") if first else "",
                    "transition": (cut.get("transition")
                                   if n > 1 and first else None),
                    "transition_duration": float(
                        cut.get("transition_duration", 0.4)),
                    "pause_split": pause_split,
                    # a start that came from an explicit drop range is exact -
                    # there is no snap slop to forgive when placing captions
                    "exact_start": exact,
                })
    if trimmed >= 0.5:
        info(f"  shortened long pauses inside cuts - {trimmed:.1f}s removed")
    if excised >= 0.1:
        info(f"  dropped {excised:.1f}s of duplicated speech inside cuts")
    return resolved


def merge_adjacent(cuts: list[dict], gap: float = 0.35) -> list[dict]:
    """Fuse cuts that are really one continuous run of the same take."""
    merged: list[dict] = []
    for cut in cuts:
        prev = merged[-1] if merged else None
        if (prev and not cut["transition"] and not cut.get("pause_split")
                and cut["source"] == prev["source"]
                and prev["start"] <= cut["start"] <= prev["end"] + gap):
            prev["end"] = max(prev["end"], cut["end"])
            prev["segments"] = prev["segments"] + cut["segments"]
            prev["note"] = "; ".join(x for x in (prev["note"], cut["note"]) if x)
        else:
            merged.append(dict(cut))
    return merged


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

def geometry(profile: dict, quality: str) -> tuple[int, int, float]:
    v = profile["video"]
    width, height, fps = v["width"], v["height"], float(v["fps"])
    if quality == "preview":
        scale = float(profile.get("preview", {}).get("scale", 0.5))
        width = int(width * scale) // 2 * 2
        height = int(height * scale) // 2 * 2
    return width, height, fps


def assign_punch(cuts: list[dict], profile: dict) -> float:
    """Alternate a slight zoom across clips so the frame is not locked off.

    The size change only lands where the edit already breaks - a boundary
    where a real pause was removed, or where the take changes. Those are
    sentence ends, which is where a size change reads as a decision rather
    than a wobble. `min_gap` keeps it from happening often enough to notice
    as a pattern.
    """
    amount = float(profile["video"].get("punch_in") or 0.0)
    min_gap = float(profile["video"].get("punch_in_min_gap") or 20.0)
    for cut in cuts:
        cut["zoom"] = 1.0
    if amount <= 0:
        return 0.0

    out_t, last_change, zoomed, changes = 0.0, -1e9, False, 0
    prev = None
    for cut in cuts:
        strong = (prev is None
                  or cut["source"] != prev["source"]
                  or cut["start"] - prev["end"] >= 0.35)
        if strong and out_t - last_change >= min_gap:
            zoomed = not zoomed
            last_change, changes = out_t, changes + 1
        cut["zoom"] = round(1.0 + amount, 4) if zoomed else 1.0
        out_t += cut["end"] - cut["start"]
        prev = cut
    return changes


def video_filter(profile: dict, width: int, height: int, fps: float,
                 focus: dict, zoom: float = 1.0) -> str:
    mode = profile["video"].get("fit", "fit")
    if mode == "fill":
        fx = float(focus.get("x", 0.5))
        fy = float(focus.get("y", 0.4))
        geo = (f"scale={width}:{height}:force_original_aspect_ratio=increase,"
               f"crop={width}:{height}:(iw-ow)*{fx:.4f}:(ih-oh)*{fy:.4f}")
    else:
        bg = profile["video"].get("pad_color", "black")
        geo = (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
               f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={bg}")
    if zoom > 1.0:
        # zoom by scaling past the frame and cropping back to it, centred
        zw = max(2, int(width * zoom) // 2 * 2)
        zh = max(2, int(height * zoom) // 2 * 2)
        geo += f",scale={zw}:{zh},crop={width}:{height}:(iw-ow)/2:(ih-oh)/2"
    return f"{geo},setsar=1,fps={fps},format=yuv420p"


def audio_filter(profile: dict, duration: float) -> str:
    parts = ["aresample=48000", "aformat=channel_layouts=stereo"]
    if profile["audio"].get("denoise"):
        parts.append("afftdn=nf=-25")
    # Room tone does not match across a cut; without these the join clicks.
    parts.append(f"afade=t=in:st=0:d={DECLICK}")
    parts.append(f"afade=t=out:st={max(0.0, duration - DECLICK):.3f}:d={DECLICK}")
    return ",".join(parts)


def encode_args(quality: str) -> list[str]:
    if quality == "preview":
        return preview_encoder("3000k")
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16"]


def render_clip(cut: dict, out: Path, profile: dict, quality: str,
                width: int, height: int, fps: float, focus: dict,
                 zoom: float = 1.0) -> None:
    duration = cut["end"] - cut["start"]
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".partial.mov")
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-accurate_seek", "-ss", f"{cut['start']:.3f}",
        "-i", cut["video"], "-t", f"{duration:.3f}",
        "-vf", video_filter(profile, width, height, fps, focus, zoom),
        "-af", audio_filter(profile, duration),
        *encode_args(quality),
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
        "-video_track_timescale", "90000",
        str(tmp),
    ]
    run(cmd)
    tmp.rename(out)


def concat_copy(clips: list[Path], out: Path, profile: dict,
                quality: str) -> None:
    """Join with the concat demuxer - the video is stream-copied, so the
    only encode that touches the picture already happened per clip."""
    listing = out.parent / f"{out.stem}.concat.txt"
    listing.write_text("".join(f"file '{c.as_posix()}'\n" for c in clips))
    af = loudnorm_filter(profile, quality)
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(listing),
        "-c:v", "copy",
        *(["-af", af] if af else []),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart", str(out),
    ])
    listing.unlink(missing_ok=True)


def concat_xfade(clips: list[Path], cuts: list[dict], durations: list[float],
                 out: Path, profile: dict, quality: str) -> None:
    """Join with dissolves. Needs a real video encode, so only used when the
    EDL actually asks for a transition."""
    inputs: list[str] = []
    for clip in clips:
        inputs += ["-i", str(clip)]
    filters: list[str] = []

    vlabel, alabel = "0:v", "0:a"
    offset = durations[0]
    for i in range(1, len(clips)):
        d = cuts[i]["transition_duration"] if cuts[i]["transition"] else 0.0
        kind = {"dissolve": "fade", "fade": "fade", "wipe": "wiperight",
                "slide": "slideleft"}.get(cuts[i]["transition"] or "", "fade")
        nv, na = f"v{i}", f"a{i}"
        if d > 0:
            start = max(0.0, offset - d)
            filters.append(f"[{vlabel}][{i}:v]xfade=transition={kind}:"
                           f"duration={d}:offset={start:.3f}[{nv}]")
            filters.append(f"[{alabel}][{i}:a]acrossfade=d={d}:c1=tri:c2=tri[{na}]")
            offset = offset + durations[i] - d
        else:
            filters.append(f"[{vlabel}][{i}:v]concat=n=2:v=1:a=0[{nv}]")
            filters.append(f"[{alabel}][{i}:a]concat=n=2:v=0:a=1[{na}]")
            offset += durations[i]
        vlabel, alabel = nv, na

    af = loudnorm_filter(profile, quality)
    if af:
        filters.append(f"[{alabel}]{af}[aout]")
        alabel = "aout"

    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
        "-filter_complex", ";".join(filters),
        "-map", f"[{vlabel}]", "-map", f"[{alabel}]",
        *encode_args(quality),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart", str(out),
    ])


def loudnorm_filter(profile: dict, quality: str) -> str:
    cfg = profile["audio"]
    if not cfg.get("loudnorm", True) or quality == "preview":
        return ""
    return (f"loudnorm=I={cfg['loudness_target']}:"
            f"TP={cfg.get('true_peak', -1.5)}:LRA={cfg.get('loudness_range', 11)}")


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("--edl", default=None, help="default: build/edl.json")
    ap.add_argument("--quality", default="preview", choices=["preview", "final"])
    ap.add_argument("--out", default=None)
    ap.add_argument("--clean", action="store_true",
                    help="discard cached clip renders first")
    args = ap.parse_args()

    paths = project_paths(args.project)
    edl_path = Path(args.edl) if args.edl else paths["build"] / "edl.json"
    if not edl_path.exists():
        die(f"no EDL at {edl_path}")
    edl = load_json(edl_path)
    if not edl.get("cuts"):
        die("EDL has no cuts")

    manifest = load_json(paths["build"] / "sources.json")
    sources = manifest["sources"]
    segments = load_json(paths["build"] / "segments.json")["segments"]
    profile_name = edl.get("profile") or manifest.get("profile", "long")
    profile = load_profile(profile_name)

    focus_file = paths["build"] / "focus.json"
    focus_map = load_json(focus_file) if focus_file.exists() else {}

    cuts = merge_adjacent(resolve_cuts(edl, segments, sources, profile))
    width, height, fps = geometry(profile, args.quality)

    changes = assign_punch(cuts, profile)
    if changes:
        info(f"  punch-in: {changes} size change(s) at sentence breaks "
             f"({float(profile['video']['punch_in']) * 100:.0f}%)")

    workdir = paths["build"] / f"clips_{args.quality}"
    if args.clean and workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    clips: list[Path] = []
    durations: list[float] = []
    reused = 0
    for i, cut in enumerate(cuts):
        focus = focus_map.get(cut["source"], {})
        key = digest(cut["video"], cut["start"], cut["end"], width, height, fps,
                     profile["video"].get("fit"), focus, args.quality,
                     profile["audio"].get("denoise"), cut.get("zoom", 1.0))
        clip = workdir / f"{i:03d}_{key}.mov"
        if not clip.exists():
            info(f"clip {i + 1}/{len(cuts)}  {cut['source']} "
                 f"{fmt_ts(cut['start'])}–{fmt_ts(cut['end'])}")
            render_clip(cut, clip, profile, args.quality, width, height,
                        fps, focus, cut.get("zoom", 1.0))
        else:
            reused += 1
        clips.append(clip)
        durations.append(cut["end"] - cut["start"])

    # Drop clip files from earlier runs that no cut refers to any more.
    keep = {c.name for c in clips}
    for stale in workdir.glob("*.mov"):
        if stale.name not in keep:
            stale.unlink()

    out = Path(args.out) if args.out else paths["build"] / f"cut_{args.quality}.mp4"
    uses_transitions = any(c["transition"] for c in cuts[1:])
    info(f"joining {len(clips)} clip(s)"
         + (" with transitions" if uses_transitions else ""))
    if uses_transitions:
        concat_xfade(clips, cuts, durations, out, profile, args.quality)
    else:
        concat_copy(clips, out, profile, args.quality)

    # Timeline maps output time back to source time - captions and overlays
    # both need it.
    timeline, position = [], 0.0
    for i, cut in enumerate(cuts):
        overlap = (cut["transition_duration"]
                   if i > 0 and cut["transition"] and uses_transitions else 0.0)
        position = max(0.0, position - overlap)
        length = durations[i]
        timeline.append({
            "source": cut["source"], "segments": cut["segments"],
            "note": cut["note"],
            "src_start": cut["start"], "src_end": cut["end"],
            "exact_start": bool(cut.get("exact_start")),
            "out_start": round(position, 3),
            "out_end": round(position + length, 3),
        })
        position += length

    save_json(paths["build"] / "timeline.json", {
        "profile": profile_name, "quality": args.quality,
        "width": width, "height": height, "fps": fps,
        "duration": round(position, 3), "cuts": timeline,
    })

    print(f"\n{out}")
    print(f"  {len(cuts)} cuts · {fmt_ts(position)} · {width}x{height}@{fps:g}"
          f" · {reused} clip(s) reused from cache")
    return 0


if __name__ == "__main__":
    sys.exit(main())
