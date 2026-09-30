#!/usr/bin/env python3
"""Step 6b - burn captions, images and titles onto the cut and encode.

This is the fast iteration loop: changing an overlay re-runs only this step,
not the transcription or the assembly.

Overlay spec (build/overlays.json):
{"overlays": [
  {"type": "image", "file": "assets/diagram.png", "start": 12, "end": 18,
   "scale": 0.8, "position": "center", "fade": 0.3, "opacity": 1.0},
  {"type": "text", "text": "1. Installing", "start": 2, "end": 6,
   "style": "lower_third"},
  {"type": "box", "start": 40, "end": 44, "color": "black@0.55"}
]}
Times are seconds on the *output* timeline.

`--variant edited` reads build/overlays_edited.json and writes
preview_edited.mp4 / final_edited.mp4 beside the plain version. That spec may
also use the edited-only layers:

  zoom    {"type": "zoom", "start", "end", "scale": 1.15, "focus": [0.5, 0.35],
           "ease": 0.0, "drift": 0.0}
  broll   {"type": "broll", "file", "start", "end", "from": 0, "fit": "cover",
           "kenburns": 1.0, "speaker": null, "fade": 0.0, "sfx": "whoosh"}
  split   {"type": "split", "file", "start", "end", "side": "right",
           "focus": 0.5, "from": 0}
  motion  {"type": "motion", "comp", "start", "end", "props": {...}}
  flash   {"type": "flash", "at", "duration": 0.25}
  sfx     {"type": "sfx", "at", "name": "whoosh" | "file": ..., "volume"}
plus top-level "auto_zoom": {"scale": 1.12, "min_hold": 4} and
"music": {"file", "volume": 0.12, "duck": true}. See the edit_video skill.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from common import (die, ffmpeg_filters, ffprobe, find_font, fmt_ts, info, load_json,
                    load_profile, preview_encoder, project_paths, run)

FONTS = {kind: find_font(kind) for kind in ("regular", "bold", "black")}

POSITIONS = {           # (x fraction, y fraction) of the free space
    "center": (0.5, 0.5), "top": (0.5, 0.08), "bottom": (0.5, 0.92),
    "left": (0.06, 0.5), "right": (0.94, 0.5),
    "tl": (0.06, 0.08), "tr": (0.94, 0.08),
    "bl": (0.06, 0.92), "br": (0.94, 0.92),
}

TEXT_STYLES = {
    "title":       {"size": 0.070, "font": "black", "pos": (0.5, 0.42),
                    "box": "black@0.0", "pad": 0},
    "lower_third": {"size": 0.040, "font": "bold", "pos": (0.07, 0.80),
                    "box": "black@0.60", "pad": 26},
    "chapter":     {"size": 0.038, "font": "bold", "pos": (0.06, 0.07),
                    "box": "black@0.60", "pad": 22},
    "caption":     {"size": 0.034, "font": "regular", "pos": (0.5, 0.88),
                    "box": "black@0.55", "pad": 20},
}

VIDEO_EXTS = (".mp4", ".mov", ".webm", ".m4v")

# Mix level per effect, for a voice at the -14 LUFS the final is normalised
# to. The kit is peak-normalised, so these are what keep a whoosh a texture
# under the voice rather than a noise over it.
SFX_VOLUME = {"whoosh": 0.45, "swoosh": 0.4, "pop": 0.6, "click": 0.6,
              "hit": 0.55, "riser": 0.35, "ding": 0.3, "cash": 0.4}


def resolve_pos(value, default: tuple[float, float]) -> tuple[float, float]:
    """Accept either a keyword ("center", "br") or an explicit [x, y] pair."""
    if value is None:
        return default
    if isinstance(value, str):
        return POSITIONS.get(value, default)
    return float(value[0]), float(value[1])


def between(start: float, end: float) -> str:
    return f"enable='between(t,{start:.3f},{end:.3f})'"


def build_text_filters(overlays: list[dict], width: int, height: int,
                       tmpdir: Path) -> list[str]:
    filters = []
    for i, ov in enumerate(overlays):
        style = dict(TEXT_STYLES.get(ov.get("style", "lower_third"),
                                     TEXT_STYLES["lower_third"]))
        style.update({k: ov[k] for k in ("size", "box", "pad") if k in ov})
        # textfile= sidesteps drawtext's escaping rules entirely.
        tfile = tmpdir / f"text_{i:02d}.txt"
        tfile.write_text(ov["text"])
        fx, fy = resolve_pos(ov.get("position"), style["pos"])
        font = FONTS.get(ov.get("font", style["font"])) or FONTS["bold"]
        if font is None:
            die("no usable font found for titles - install DejaVu or Arial")
        parts = [
            f"drawtext=fontfile={escape_path(font)}",
            f"textfile={escape_path(tfile)}",
            f"fontsize={max(12, int(height * float(style['size'])))}",
            f"fontcolor={ov.get('color', 'white')}",
            f"x=(w-text_w)*{fx}", f"y=(h-text_h)*{fy}",
            "line_spacing=8",
        ]
        if style["box"] and not style["box"].endswith("@0.0"):
            parts += ["box=1", f"boxcolor={style['box']}",
                      f"boxborderw={style['pad']}"]
        else:
            # the outline has to fade with the text, or a dimmed entry in a
            # progressively revealed list reads as muddy rather than pending
            parts += ["borderw=3",
                      f"bordercolor={ov.get('bordercolor', 'black@0.8')}"]
        parts.append(between(ov["start"], ov["end"]))
        filters.append(":".join(parts))
    return filters


def escape_path(path: Path) -> str:
    """drawtext parses ':' and '\\' inside option values."""
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


class Inputs:
    """ffmpeg input list; input 0 is always the cut."""

    def __init__(self, source: Path):
        self.args: list[str] = ["-i", str(source)]
        self.count = 1

    def add(self, *args: str) -> int:
        self.args += list(args)
        self.count += 1
        return self.count - 1

    def media(self, path: Path, duration: float, fps: int,
              seek: float = 0.0) -> int:
        """A still frozen for the slot, or a gif/clip looped to fill it."""
        ext = path.suffix.lower()
        if ext == ".gif":
            return self.add("-ignore_loop", "0", "-t", f"{duration:.3f}", "-i", str(path))
        if ext in VIDEO_EXTS:
            # libvpx is the only decoder that reads a WebM's alpha plane;
            # the native one drops it and the motion graphic arrives opaque
            dec = ["-c:v", "libvpx-vp9"] if ext == ".webm" else []
            ss = ["-ss", f"{seek:.3f}"] if seek > 0 else []
            return self.add("-stream_loop", "-1", *ss, "-t", f"{duration:.3f}",
                            *dec, "-i", str(path))
        return self.add("-loop", "1", "-framerate", str(fps),
                        "-t", f"{duration:.3f}", "-i", str(path))


def resolve_file(ov: dict, project_root: Path) -> Path:
    path = Path(ov["file"])
    if not path.is_absolute():
        path = project_root / path
    if not path.exists():
        die(f"overlay file not found: {path}")
    return path


def slot(ov: dict) -> tuple[float, float]:
    start, end = float(ov["start"]), float(ov["end"])
    if end <= start:
        die(f"overlay {ov.get('type')} at {start} has end <= start")
    return start, end - start


def build_image_graph(overlays: list[dict], width: int, height: int,
                      project_root: Path, inputs: Inputs, fps: int = 30
                      ) -> list[str]:
    """Filter chain entries producing [ov<n>] for each image overlay."""
    chain: list[str] = []
    for n, ov in enumerate(overlays):
        path = resolve_file(ov, project_root)
        start, duration = slot(ov)
        idx = inputs.media(path, duration, fps, float(ov.get("from", 0)))

        scale = float(ov.get("scale", 0.8))
        fade = float(ov.get("fade", 0.25))
        opacity = float(ov.get("opacity", 1.0))
        target_w = max(2, int(width * scale) // 2 * 2)

        steps = [f"scale={target_w}:-2", "format=rgba"]
        if path.suffix.lower() != ".png":
            # anything animated has to land on the timeline's own cadence
            steps.insert(0, f"fps={fps}")
        if opacity < 1.0:
            steps.append(f"colorchannelmixer=aa={opacity:.3f}")
        if fade > 0 and duration > fade * 2:
            steps.append(f"fade=t=in:st=0:d={fade}:alpha=1")
            steps.append(f"fade=t=out:st={duration - fade:.3f}:d={fade}:alpha=1")
        # Shift the still into its slot on the output timeline.
        steps.append(f"setpts=PTS-STARTPTS+{start:.3f}/TB")
        chain.append(f"[{idx}:v]{','.join(steps)}[ov{n}]")
    return chain


# ------------------------------------------------------------ edited layers

def even(x: float) -> int:
    return max(2, int(round(x)) // 2 * 2)


def auto_zooms(spec: dict, timeline: dict, explicit: list[dict],
               defaults: dict | None = None) -> list[dict]:
    """Alternate the framing at the cut's own joins, so every jump cut lands
    as a punch-in. Joins closer than `min_hold` are merged: a size change
    every two seconds reads as a shaky camera, not an edit.

    `"auto_zoom": true` takes the profile's values; a dict overrides them."""
    cfg = spec.get("auto_zoom")
    if not cfg:
        return []
    cfg = {**(defaults or {}), **(cfg if isinstance(cfg, dict) else {})}
    scale = float(cfg.get("scale", 1.06))
    min_hold = float(cfg.get("min_hold", 10.0))
    focus = cfg.get("focus", [0.5, 0.4])
    skip = [(float(o["start"]), float(o["end"])) for o in explicit]
    bounds = [c["out_start"] for c in timeline["cuts"]] + [timeline["duration"]]
    merged = [bounds[0]]
    for b in bounds[1:]:
        if b - merged[-1] >= min_hold:
            merged.append(b)
    merged[-1] = timeline["duration"]
    zooms = []
    for k in range(1, len(merged) - 1, 2):
        s, e = merged[k], merged[k + 1]
        if any(s < xe and xs < e for xs, xe in skip):
            continue
        zooms.append({"type": "zoom", "start": s, "end": e, "scale": scale,
                      "focus": focus})
    return zooms


def zoom_filter(zooms: list[dict], width: int, height: int, fps: int) -> str:
    """One zoompan over the whole base, with the zoom as a piecewise function
    of time. A single pass - splitting the base per zoom would make ffmpeg
    buffer every frame ahead of each window."""
    z_expr, x_expr, y_expr = "1", "0", "0"
    for zm in sorted(zooms, key=lambda z: z["start"], reverse=True):
        s, e = float(zm["start"]), float(zm["end"])
        target = float(zm.get("scale", 1.15))
        ease = float(zm.get("ease", 0.0))
        drift = float(zm.get("drift", 0.0))
        fx, fy = zm.get("focus", [0.5, 0.4])
        ramp = f"min((it-{s:.3f})/{ease:.3f},1)" if ease > 0 else "1"
        z = f"1+{target - 1:.4f}*{ramp}"
        if drift:
            z += f"+{drift:.4f}*(it-{s:.3f})/{e - s:.3f}"
        cond = f"between(it,{s:.3f},{e:.3f})"
        z_expr = f"if({cond},{z},{z_expr})"
        x_expr = f"if({cond},(iw-iw/zoom)*{fx},{x_expr})"
        y_expr = f"if({cond},(ih-ih/zoom)*{fy},{y_expr})"
    # fps= first: zoompan re-stamps frames by count, so a cut with gaps in
    # its timestamps would slide out of sync with the audio without it
    return (f"fps={fps},zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}'"
            f":d=1:s={width}x{height}:fps={fps}")


def cover(w: int, h: int) -> str:
    return (f"scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},setsar=1")


def kenburns(k: float, w: int, h: int, duration: float, fps: int,
             focus=(0.5, 0.5)) -> str:
    """Slow push from 1.0 to k. Pans at 2x and scales down: zoompan snaps
    its crop to whole pixels, which judders visibly at frame size."""
    frames = max(1, int(duration * fps))
    fx, fy = focus
    return (f"scale={w * 2}:{h * 2},zoompan=z='1+{k - 1:.4f}*on/{frames}'"
            f":x='(iw-iw/zoom)*{fx}':y='(ih-ih/zoom)*{fy}'"
            f":d=1:s={w}x{h}:fps={fps}")


def speaker_input(inputs: Inputs, source: Path, start: float,
                  duration: float) -> int:
    """The cut itself again, seeked to the window - a fresh decode rather than
    a split of input 0, for the same buffering reason as zoom_filter."""
    return inputs.add("-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
                      "-i", str(source))


def build_cutaway(ov: dict, n: int, width: int, height: int, fps: int,
                  root: Path, source: Path, inputs: Inputs) -> list[str]:
    """A full-frame b-roll or split-screen layer, output as [cut<n>]."""
    start, duration = slot(ov)
    path = resolve_file(ov, root)
    idx = inputs.media(path, duration, fps, float(ov.get("from", 0)))
    lab = f"cut{n}"
    chain: list[str] = []

    if ov["type"] == "split":
        side = ov.get("side", "right" if width > height else "top")
        horizontal = side in ("left", "right")
        bw, bh = (even(width / 2), height) if horizontal else (width, even(height / 2))
        chain.append(f"[{idx}:v]fps={fps},{cover(bw, bh)}[sb{n}]")
        sp = speaker_input(inputs, source, start, duration)
        focus = float(ov.get("focus", 0.5 if horizontal else 0.38))
        if horizontal:
            x = min(max(width * focus - bw / 2, 0), width - bw)
            crop = f"crop={bw}:{bh}:{int(x)}:0"
        else:
            y = min(max(height * focus - bh / 2, 0), height - bh)
            crop = f"crop={bw}:{bh}:0:{int(y)}"
        chain.append(f"[{sp}:v]fps={fps},{crop},setsar=1[ss{n}]")
        first, second = (f"[ss{n}]", f"[sb{n}]") if side in ("right", "bottom") \
            else (f"[sb{n}]", f"[ss{n}]")
        stack = "hstack" if horizontal else "vstack"
        seam = max(2, even(min(width, height) * 0.006))
        line = (f"drawbox=x={bw - seam // 2}:y=0:w={seam}:h=ih:color=white@0.9:t=fill"
                if horizontal else
                f"drawbox=x=0:y={bh - seam // 2}:w=iw:h={seam}:color=white@0.9:t=fill")
        chain.append(f"{first}{second}{stack}=inputs=2,{line},format=rgba,"
                     f"setpts=PTS-STARTPTS+{start:.3f}/TB[{lab}]")
        return chain

    fit = ov.get("fit", "cover")
    kb = float(ov.get("kenburns", 1.0))
    if fit == "contain":
        # letterboxed onto a blurred, darkened copy of itself: a landscape
        # clip in a vertical frame, or a screenshot that must not be cropped
        inset = float(ov.get("inset", 0.9))
        chain.append(f"[{idx}:v]fps={fps},split[ca{n}][cb{n}]")
        chain.append(f"[ca{n}]{cover(even(width / 4), even(height / 4))},"
                     f"boxblur=10:2,scale={width}:{height},eq=brightness=-0.12[bg{n}]")
        chain.append(f"[cb{n}]scale={even(width * inset)}:{even(height * inset)}"
                     f":force_original_aspect_ratio=decrease,setsar=1[fg{n}]")
        chain.append(f"[bg{n}][fg{n}]overlay=(W-w)/2:(H-h)/2[cv{n}]")
        cur = f"cv{n}"
        if kb > 1.0:
            chain.append(f"[{cur}]{kenburns(kb, width, height, duration, fps)}[kb{n}]")
            cur = f"kb{n}"
    else:
        geo = cover(width, height)
        if kb > 1.0:
            geo = cover(width, height) + "," + kenburns(
                kb, width, height, duration, fps, tuple(ov.get("focus", (0.5, 0.5))))
        chain.append(f"[{idx}:v]fps={fps},{geo}[cv{n}]")
        cur = f"cv{n}"

    if ov.get("speaker"):
        # keep the face on screen while the b-roll plays: a framed inset
        sp = speaker_input(inputs, source, start, duration)
        sw = even(width * float(ov.get("speaker_scale", 0.3 if width > height else 0.42)))
        border = max(2, even(min(width, height) * 0.006))
        fx, fy = resolve_pos(ov["speaker"], (0.94, 0.92))
        chain.append(f"[{sp}:v]fps={fps},scale={sw}:-2,pad=iw+{border * 2}:ih+{border * 2}"
                     f":{border}:{border}:color=white[pip{n}]")
        chain.append(f"[{cur}][pip{n}]overlay=(W-w)*{fx}:(H-h)*{fy}[wp{n}]")
        cur = f"wp{n}"

    steps = ["format=rgba"]
    fade = float(ov.get("fade", 0.0))
    if fade > 0 and duration > fade * 2:
        steps += [f"fade=t=in:st=0:d={fade}:alpha=1",
                  f"fade=t=out:st={duration - fade:.3f}:d={fade}:alpha=1"]
    steps.append(f"setpts=PTS-STARTPTS+{start:.3f}/TB")
    chain.append(f"[{cur}]{','.join(steps)}[{lab}]")
    return chain


def build_flash(ov: dict, n: int, width: int, height: int, fps: int,
                inputs: Inputs) -> tuple[list[str], float, float]:
    d = float(ov.get("duration", 0.25))
    at = float(ov["at"])
    start = max(0.0, at - d / 2)
    idx = inputs.add("-f", "lavfi", "-t", f"{d:.3f}", "-i",
                     f"color=c={ov.get('color', 'white')}:s={width}x{height}:r={fps}")
    half = d / 2
    chain = [f"[{idx}:v]format=rgba,fade=t=in:st=0:d={half:.3f}:alpha=1,"
             f"fade=t=out:st={half:.3f}:d={half:.3f}:alpha=1,"
             f"colorchannelmixer=aa={float(ov.get('opacity', 0.85)):.2f},"
             f"setpts=PTS-STARTPTS+{start:.3f}/TB[fl{n}]"]
    return chain, start, start + d


def ass_seconds(ts: str) -> float:
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def hide_captions(ass: Path, windows: list[tuple[float, float]], out: Path) -> Path:
    """Copy of the ASS with every event clipped out of `windows`.

    A full-frame text card already says the words; the burned caption under it
    says them a second time, a line lower, and the frame reads as a typo."""
    from common import ass_ts
    lines = []
    for line in ass.read_text().splitlines():
        if not line.startswith("Dialogue:"):
            lines.append(line)
            continue
        head, rest = line.split(":", 1)
        f = rest.split(",", 9)
        s, e = ass_seconds(f[1]), ass_seconds(f[2])
        for ws, we in windows:
            if s < we and ws < e:
                if s < ws:
                    e = min(e, ws)          # keep the part before the card
                else:
                    s = max(s, we)          # keep the part after it
        if e - s < 0.05:
            continue
        f[1], f[2] = ass_ts(s), ass_ts(e)
        lines.append(f"{head}:{','.join(f)}")
    out.write_text("\n".join(lines) + "\n")
    return out


def sfx_events(overlays: list[dict]) -> list[dict]:
    """Explicit sfx entries, plus the `sfx` shorthand on any other layer."""
    events = []
    for ov in overlays:
        if ov.get("type") == "sfx":
            events.append(ov)
            continue
        cue = ov.get("sfx")
        if not cue:
            continue
        cue = {"name": cue} if isinstance(cue, str) else dict(cue)
        at = ov.get("start", ov.get("at", 0))
        # a whoosh is heard rising *into* the cut, so it starts a touch early
        lead = 0.12 if cue.get("name") in ("whoosh", "swoosh") else 0.0
        cue.setdefault("at", max(0.0, float(at) - lead))
        events.append(cue)
    return events


def voice_loudness(source: Path, cache_dir: Path) -> float:
    """Integrated loudness of the cut, cached per file. The preview cut is not
    loudness-normalised and the final is, so effects mixed at a fixed level
    would sit ~6 dB hotter against the voice in the preview than in the final."""
    import re
    st = source.stat()
    cache = cache_dir / f"lufs_{source.stem}_{int(st.st_mtime)}_{st.st_size}.txt"
    if cache.exists():
        return float(cache.read_text())
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(source),
                           "-vn", "-af", "ebur128", "-f", "null", "-"],
                          capture_output=True, text=True)
    found = re.findall(r"I:\s+(-?[\d.]+) LUFS", proc.stderr)
    value = float(found[-1]) if found else -14.0
    cache.write_text(str(value))
    return value


def build_audio(events: list[dict], music: dict | None, duration: float,
                root: Path, inputs: Inputs, gain: float = 1.0) -> list[str]:
    """Mix sound effects and an optional ducked music bed under the voice.
    `gain` scales every level to the voice's actual loudness."""
    import sfx as kit
    lib = kit.ensure()
    chain: list[str] = []
    voice = "0:a"
    mix: list[str] = []
    if music:
        mpath = Path(music["file"])
        mpath = mpath if mpath.is_absolute() else root / mpath
        if not mpath.exists():
            die(f"music file not found: {mpath}")
        mi = inputs.add("-stream_loop", "-1", "-t", f"{duration:.3f}", "-i", str(mpath))
        vol = float(music.get("volume", 0.12)) * gain
        chain.append(f"[{mi}:a]aresample=48000,volume={vol:.3f},"
                     f"afade=t=out:st={max(0, duration - 2):.3f}:d=2[mus]")
        if music.get("duck", True):
            # the bed dips whenever he speaks and swells in the gaps
            chain.append("[0:a]asplit=2[vo][vkey]")
            chain.append("[mus][vkey]sidechaincompress=threshold=0.02:ratio=6"
                         ":attack=30:release=500[mud]")
            voice = "vo"
            mix.append("[mud]")
        else:
            mix.append("[mus]")
    for n, ev in enumerate(events):
        if "file" in ev:
            p = Path(ev["file"])
            p = p if p.is_absolute() else root / p
            name = p.stem
        else:
            name = ev.get("name", "whoosh")
            p = lib / f"{name}.wav"
        if not p.exists():
            die(f"sound effect not found: {p} (kit: "
                f"{', '.join(sorted(x.stem for x in lib.glob('*.wav')))})")
        idx = inputs.add("-i", str(p))
        vol = float(ev.get("volume", SFX_VOLUME.get(name, 0.3))) * gain
        ms = int(float(ev["at"]) * 1000)
        chain.append(f"[{idx}:a]aresample=48000,aformat=channel_layouts=stereo,"
                     f"volume={vol:.3f},adelay={ms}:all=1[fx{n}]")
        mix.append(f"[fx{n}]")
    chain.append(f"[{voice}]{''.join(mix)}amix=inputs={1 + len(mix)}:duration=first"
                 f":normalize=0,alimiter=limit=0.9:level=false[aout]")
    return chain


HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}
SDR_TAGS = ["-colorspace", "bt709", "-color_trc", "bt709",
            "-color_primaries", "bt709", "-color_range", "tv",
            # some encoders ignore the flags above; write them into the stream
            "-bsf:v", "h264_metadata=colour_primaries=1:"
            "transfer_characteristics=1:matrix_coefficients=1"]


def sdr_source(source: Path, quality: str) -> Path:
    """An SDR (bt709) copy of an HDR cut, cached beside it.

    Phone footage is usually HLG. Stock clips and motion graphics are SDR, and
    the compositing drops the HDR tags, so without this the speaker plays back
    as a flat, washed-out picture next to correctly coloured cutaways."""
    stream = next((s for s in ffprobe(source)["streams"]
                   if s.get("codec_type") == "video"), {})
    trc = stream.get("color_transfer")
    if trc not in HDR_TRANSFERS:
        return source
    if not {"zscale", "tonemap"} <= ffmpeg_filters():
        info("this ffmpeg has no zscale/tonemap - HDR colours may look washed out")
        return source
    # npl=203 is HLG reference white (BT.2408); 100 overdrives skin to orange
    tonemap = (f"zscale=tin={trc}:min=bt2020nc:pin=bt2020:t=linear:npl=203,"
               "format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,"
               "zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
    out = source.with_name(f"{source.stem}_sdr.mp4")
    # the filter is stamped into the copy, so a settings change re-renders it
    if (out.exists() and out.stat().st_mtime >= source.stat().st_mtime
            and ffprobe(out).get("format", {}).get("tags", {})
            .get("comment") == tonemap):
        return out
    info(f"tone-mapping the {trc} cut to SDR")
    encode = (["-c:v", "libx264", "-preset", "medium", "-crf", "14"]
              if quality == "final" else
              preview_encoder("8000k"))
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(source),
         "-vf", tonemap, *encode, *SDR_TAGS, "-metadata", f"comment={tonemap}",
         "-c:a", "copy", str(out)])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--input", default=None, help="default: build/cut_final.mp4")
    ap.add_argument("--out", default=None, help="default: <project>/final.mp4")
    ap.add_argument("--captions", default="auto",
                    choices=["auto", "on", "off"])
    ap.add_argument("--overlays", default=None,
                    help="default: build/overlays.json if present")
    ap.add_argument("--variant", default="plain", choices=["plain", "edited"],
                    help="edited: build/overlays_edited.json -> *_edited.mp4")
    ap.add_argument("--quality", default="final", choices=["preview", "final"])
    args = ap.parse_args()

    paths = project_paths(args.project)
    timeline = load_json(paths["build"] / "timeline.json")
    profile = load_profile(timeline["profile"])
    width, height = timeline["width"], timeline["height"]
    duration = timeline["duration"]
    fps = int(round(timeline["fps"]))

    source = Path(args.input) if args.input else \
        paths["build"] / f"cut_{args.quality}.mp4"
    if not source.exists():
        die(f"no cut to finish at {source} - run tools/render.py --quality "
            f"{args.quality} first")

    want_captions = (args.captions == "on" or
                     (args.captions == "auto" and profile["captions"]["burn_in"]))

    edited = args.variant == "edited"
    suffix = "_edited" if edited else ""
    default_ov = "overlays_edited.json" if edited else "overlays.json"
    ov_path = Path(args.overlays) if args.overlays else paths["build"] / default_ov
    if edited and not ov_path.exists():
        die(f"no {ov_path} - write the edited spec first (see the skill)")
    if edited:
        source = sdr_source(source, args.quality)
    spec: dict = {}
    overlays = []
    if ov_path.exists() and ov_path.stat().st_size > 0:
        try:
            spec = load_json(ov_path)
            overlays = spec.get("overlays", [])
        except json.JSONDecodeError as exc:
            die(f"{ov_path} is not valid JSON: {exc}")

    # captions.py emits the emoji badges as image overlays, because libass
    # cannot draw a colour emoji font. They ride along with the captions:
    # no burn-in, no badges.
    cap_ov = paths["build"] / "caption_overlays.json"
    badges = []
    if want_captions and cap_ov.exists() and cap_ov.stat().st_size > 0:
        try:
            badges = load_json(cap_ov).get("overlays", [])
        except json.JSONDecodeError as exc:
            die(f"{cap_ov} is not valid JSON: {exc}")

    # motion layers are Remotion renders; tools/motion.py makes the files
    motions = [o for o in overlays if o.get("type") == "motion"]
    if motions:
        from motion import motion_file
        for ov in motions:
            f = motion_file(paths["build"], ov, profile)
            if not f.exists():
                die(f"motion clip for {ov['comp']} at {ov['start']} is not "
                    f"rendered - run tools/motion.py {args.project}")
            ov.update({"file": str(f), "scale": 1.0, "position": "center",
                       "fade": 0.0})

    # An emoji badge is punctuation for the face. Over b-roll it belongs to
    # nothing, and next to a graphic it collides with it - so it only shows
    # while the frame is otherwise just the speaker.
    busy = [(float(o["start"]), float(o["end"])) for o in overlays
            if o.get("type") in ("broll", "split", "motion", "image")]
    badges = [b for b in badges if not any(
        float(b["start"]) < e and s < float(b["end"]) for s, e in busy)]

    # Captions step aside for opaque motion cards, which carry their own words.
    # "captions": true on a layer keeps them; false hides them under anything.
    hidden = [(float(o["start"]), float(o["end"])) for o in overlays
              if o.get("captions") is False
              or (o.get("captions") is None and o.get("type") == "motion"
                  and o["file"].endswith(".mp4"))]

    explicit_zooms = [o for o in overlays if o.get("type") == "zoom"]
    zooms = explicit_zooms + auto_zooms(spec, timeline, explicit_zooms,
                                        profile.get("edited", {}).get("auto_zoom"))
    cutaways = [o for o in overlays if o.get("type") in ("broll", "split")]
    images = [o for o in overlays if o.get("type") in ("image", "motion")] + badges
    texts = [o for o in overlays if o.get("type") == "text"]
    boxes = [o for o in overlays if o.get("type") == "box"]
    flashes = [o for o in overlays if o.get("type") == "flash"]
    events = sfx_events(overlays)
    music = spec.get("music")

    ass = paths["build"] / "captions.ass"
    if want_captions and not ass.exists():
        die("captions requested but build/captions.ass is missing - run "
            "tools/captions.py")

    tmpdir = paths["build"] / "overlay_tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)

    inputs = Inputs(source)
    chain: list[str] = []
    label = "0:v"
    if zooms:
        chain.append(f"[0:v]{zoom_filter(zooms, width, height, fps)}[zb]")
        label = "zb"

    for n, ov in enumerate(cutaways):
        chain += build_cutaway(ov, n, width, height, fps, paths["root"],
                               source, inputs)
        start, end = float(ov["start"]), float(ov["end"])
        chain.append(f"[{label}][cut{n}]overlay=0:0:{between(start, end)}"
                     f":eof_action=pass[c{n}]")
        label = f"c{n}"

    chain += build_image_graph(images, width, height, paths["root"], inputs, fps)
    for n, ov in enumerate(images):
        fx, fy = resolve_pos(ov.get("position"), (0.5, 0.5))
        nxt = f"b{n}"
        chain.append(f"[{label}][ov{n}]overlay=(W-w)*{fx}:(H-h)*{fy}:"
                     f"{between(ov['start'], ov['end'])}:eof_action=pass[{nxt}]")
        label = nxt

    for n, ov in enumerate(flashes):
        part, s, e = build_flash(ov, n, width, height, fps, inputs)
        chain += part
        chain.append(f"[{label}][fl{n}]overlay=0:0:{between(s, e)}"
                     f":eof_action=pass[f{n}]")
        label = f"f{n}"

    post: list[str] = []
    for ov in boxes:
        post.append(f"drawbox=x=0:y=0:w=iw:h=ih:color={ov.get('color', 'black@0.5')}"
                    f":t=fill:{between(ov['start'], ov['end'])}")
    post += build_text_filters(texts, width, height, tmpdir)
    if want_captions:
        if hidden:
            ass = hide_captions(ass, hidden, tmpdir / f"captions{suffix}.ass")
        post.append(f"subtitles={escape_path(ass)}")
    fade_in = float(profile["video"].get("fade_in", 0))
    fade_out = float(profile["video"].get("fade_out", 0))
    if fade_in > 0:
        post.append(f"fade=t=in:st=0:d={fade_in}")
    if fade_out > 0 and duration > fade_out:
        post.append(f"fade=t=out:st={duration - fade_out:.3f}:d={fade_out}")

    if post:
        chain.append(f"[{label}]{','.join(post)}[vout]")
        label = "vout"

    audio_map, audio_codec = ["-map", "0:a?"], ["-c:a", "copy"]
    if events or music:
        lufs = voice_loudness(source, tmpdir)
        gain = 10 ** ((lufs + 14.0) / 20)
        chain += build_audio(events, music, duration, paths["root"], inputs, gain)
        audio_map, audio_codec = ["-map", "[aout]"], ["-c:a", "aac", "-b:a", "192k"]

    out = Path(args.out) if args.out else paths["root"] / (
        f"final{suffix}.mp4" if args.quality == "final" else f"preview{suffix}.mp4")

    if not chain:
        info("nothing to burn in - copying the cut through")
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(source), "-c", "copy", "-movflags", "+faststart", str(out)])
    else:
        encode = (["-c:v", "libx264", "-preset", "medium", "-crf",
                   str(profile["video"].get("crf", 19)), "-pix_fmt", "yuv420p"]
                  if args.quality == "final"
                  else preview_encoder("3500k") + ["-pix_fmt", "yuv420p"])
        if edited:
            encode += SDR_TAGS
        extra = (f", {len(zooms)} zoom(s), {len(cutaways)} cutaway(s), "
                 f"{len(motions)} motion, {len(events)} sfx"
                 + (", music" if music else "")) if edited else ""
        info(f"burning {len(images)} image(s), {len(texts)} title(s)"
             + (", captions" if want_captions else "") + extra)
        graph = tmpdir / f"graph{suffix}.txt"
        graph.write_text(";\n".join(chain))
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             *inputs.args,
             "-/filter_complex", str(graph),
             "-map", f"[{label}]", *audio_map,
             *encode, *audio_codec, "-t", f"{duration:.3f}",
             "-movflags", "+faststart", str(out)])

    size = out.stat().st_size / 1e6
    print(f"\n{out}")
    print(f"  {fmt_ts(duration)} · {width}x{height} · {size:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
