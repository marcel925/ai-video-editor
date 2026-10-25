#!/usr/bin/env python3
"""YouTube thumbnails from a video's own frames: find the good face frames,
cut the speaker out, render the variants and check them at feed size.

  thumbnail.py frames <project> [--every 2] [--count 24]
        scan the cut, score every face frame (sharp, eyes open, facing the
        camera), keep the best spread across the video -> build/thumbs/
        candidates.json and contact.jpg, a numbered sheet to choose from
  thumbnail.py grab <project> <time>... [--from raw|plain|edited]
        full-resolution frames at output-timeline times -> build/thumbs/
        frame_<time>.jpg. raw (default) reads the camera file, so it is
        sharper than any render; plain/edited read final(_edited).mp4 (or the
        preview), for a b-roll shot, screen recording or graphic
  thumbnail.py cutout <project> <image>
        the speaker on a transparent background -> <image>_cut.png (macOS)
  thumbnail.py render <project>
        build/thumbnails.json -> upload/thumbnails/<id>.jpg, then
        build/thumbs/check.jpg: every variant at the sizes viewers see it

Spec ($P/build/thumbnails.json), layers drawn bottom first - the layer types
are documented in motion/thumb/Thumbnail.tsx and the thumbnails skill:

  {"variants": [{"id": "A", "idea": "Big number + face",
                 "layers": [{"type": "image", "file": "build/thumbs/frame_12.4.jpg"},
                            {"type": "text", "lines": ["*$100K*/month"], "x": 0.05, "y": 0.1, "w": 0.5}]}]}

Files in layers are relative to the project folder. Renders with Remotion
(motion/), whichever engine MOTION_ENGINE picks for the motion graphics.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from common import die, ffprobe, info, load_json, load_sources, project_paths, save_json

ROOT = Path(__file__).resolve().parent.parent
MOTION = ROOT / "motion"
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}
# YouTube asks for 3840x2160 (TVs); laid out at 1920x1080, rendered at 2x
SCALE = 2
# Studio on desktop takes 50 MB, but the phone app still caps uploads at 2 MB;
# stay under it when the quality floor allows, so one file works everywhere
MAX_BYTES = 2 * 1024 * 1024


# ---------------------------------------------------------------- helpers

def tonemap(path: Path) -> str:
    """The HDR -> SDR filter finish.py uses, ending in full-range RGB for a
    still - or nothing, for SDR footage."""
    stream = next((s for s in ffprobe(path)["streams"] if s.get("codec_type") == "video"), {})
    trc = stream.get("color_transfer")
    if trc not in HDR_TRANSFERS:
        return ""
    return (f"zscale=tin={trc}:min=bt2020nc:pin=bt2020:t=linear:npl=203,"
            "format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,"
            "zscale=t=bt709:m=bt709:r=pc,")


def vision_bin() -> Path | None:
    """tools/vision.swift compiled into the venv on first use (macOS only)."""
    if sys.platform != "darwin" or not shutil.which("swiftc"):
        return None
    src = Path(__file__).with_name("vision.swift")
    out = Path(sys.prefix) / "bin" / "vt-vision"
    if not out.exists() or out.stat().st_mtime < src.stat().st_mtime:
        info("compiling the Vision helper (once)")
        r = subprocess.run(["swiftc", "-O", str(src), "-o", str(out)], capture_output=True, text=True)
        if r.returncode != 0:
            info(f"could not compile vision.swift - falling back to OpenCV\n{r.stderr[-800:]}")
            return None
    return out


def score_faces(files: list[Path]) -> dict[str, list[dict]]:
    """Faces per image, each with a 0-1 quality. Apple Vision's capture
    quality where available; otherwise an OpenCV face plus sharpness."""
    vb = vision_bin()
    found: dict[str, list[dict]] = {}
    if vb:
        for i in range(0, len(files), 200):
            r = subprocess.run([str(vb), "faces", *map(str, files[i:i + 200])],
                               capture_output=True, text=True)
            for line in r.stdout.splitlines():
                if line.startswith("{"):
                    d = json.loads(line)
                    found[d["file"]] = d.get("faces", [])
        return found
    import cv2
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    sharp = {}
    for f in files:
        img = cv2.imread(str(f))
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        H, W = gray.shape
        faces = []
        for (x, y, w, h) in cascade.detectMultiScale(gray, 1.1, 6, minSize=(W // 20, W // 20)):
            sharp[(str(f), x)] = cv2.Laplacian(gray[y:y + h, x:x + w], cv2.CV_64F).var()
            faces.append({"x": x / W, "y": y / H, "w": w / W, "h": h / H, "_s": sharp[(str(f), x)]})
        found[str(f)] = faces
    top = max([s for s in sharp.values()] or [1])
    for faces in found.values():
        for fc in faces:
            fc["quality"] = round(min(1.0, fc.pop("_s") / top), 3)
    return found


def fmt(t: float) -> str:
    m, s = divmod(t, 60)
    return f"{int(m)}:{s:04.1f}"


def timeline_source(paths: dict, t: float) -> tuple[Path, float]:
    """The camera file and its time for output time t."""
    tl = load_json(paths["build"] / "timeline.json")
    sources = {s["name"]: s for s in load_sources(paths)["sources"]}
    for cut in tl["cuts"]:
        if cut["out_start"] <= t < cut["out_end"] or cut is tl["cuts"][-1]:
            src_t = min(cut["src_end"], cut["src_start"] + max(0.0, t - cut["out_start"]))
            return Path(sources[cut["source"]]["video"]), src_t
    die(f"{t} is past the end of the timeline")


def extract(video: Path, t: float, out: Path, settle: bool = True) -> float:
    """One full-resolution still at t. With `settle`, the best face within
    +-0.3 s: a 2 s scan lands mid-blink or mid-word often enough to matter.
    Returns the offset it settled on."""
    tm = tonemap(video)
    if not settle:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1",
                        "-vf", f"{tm}format=yuvj444p", "-q:v", "1", str(out)], check=True)
        return 0.0
    tmp = out.with_suffix(".try")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    start = max(0.0, t - 0.3)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(video), "-t", "0.6",
                    "-vf", f"fps=10,{tm}format=yuvj444p", "-q:v", "1", str(tmp / "%02d.jpg")], check=True)
    tries = sorted(tmp.glob("*.jpg"))
    faces = score_faces(tries)
    best = max(tries, key=lambda f: max((fc["quality"] for fc in faces.get(str(f), [])), default=0)
               - 0.02 * abs(start + (int(f.stem) - 1) / 10 - t))
    shutil.move(str(best), out)
    shutil.rmtree(tmp)
    return round(start + (int(best.stem) - 1) / 10 - t, 1)


def words_near(paths: dict, t: float, reach: float = 2.0) -> str:
    f = paths["build"] / "words.json"
    if not f.exists():
        return ""
    return " ".join(w["w"] for w in load_json(f) if t - reach <= w["s"] <= t + reach)


# ---------------------------------------------------------------- commands

def cmd_frames(paths: dict, every: float, count: int) -> None:
    from PIL import Image, ImageDraw, ImageFont
    from common import find_font

    tl = load_json(paths["build"] / "timeline.json")
    cut = paths["build"] / f"cut_{tl['quality']}.mp4"
    if not cut.exists():
        die(f"no {cut.name} - render the video first (preview is enough)")
    dur = float(ffprobe(cut)["format"]["duration"])
    if abs(dur - tl["duration"]) > 1.5:
        info(f"{cut.name} is {dur:.1f}s but the timeline is {tl['duration']:.1f}s - re-render first for exact times")
    scan = paths["build"] / "thumbs" / "scan"
    shutil.rmtree(scan, ignore_errors=True)
    scan.mkdir(parents=True)
    info(f"scanning {cut.name} every {every}s")
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(cut), "-vf",
                    f"fps=1/{every},{tonemap(cut)}scale='min(iw,1280)':-2,format=yuvj420p", "-q:v", "3",
                    str(scan / "%05d.jpg")], check=True)
    files = sorted(scan.glob("*.jpg"))
    faces = score_faces(files)

    scored = []
    for f in files:
        t = (int(f.stem) - 1) * every
        fs = faces.get(str(f), [])
        if not fs:
            continue
        main = max(fs, key=lambda d: d["w"] * d["h"])
        # a usable face is big enough to cut out and roughly facing camera
        size = min(1.0, main["h"] / 0.25)
        yaw = abs(main.get("yaw", 0.0))
        score = main["quality"] * (0.6 + 0.4 * size) * (1.0 if yaw < 0.35 else 0.6)
        scored.append({"t": round(t, 2), "score": round(score, 3), "quality": round(main["quality"], 3),
                       "face": {k: round(main[k], 3) for k in ("x", "y", "w", "h")},
                       "mouth_open": round(main.get("mouth_open", 0.0), 3), "scan": str(f)})
    if not scored:
        die("no face found in any frame - grab frames by time instead")

    # best first, but spread out: no two picks closer than `gap` seconds
    gap = max(every * 2, tl["duration"] / (count * 2.5))
    picks: list[dict] = []
    for c in sorted(scored, key=lambda c: -c["score"]):
        if all(abs(c["t"] - p["t"]) >= gap for p in picks):
            picks.append(c)
        if len(picks) == count:
            break
    picks.sort(key=lambda c: c["t"])
    for i, p in enumerate(picks, 1):
        p["n"] = i
        p["said"] = words_near(paths, p["t"])

    # numbered contact sheet of face close-ups: the expression is what you
    # are choosing, and in a wide shot it is a few pixels
    tile = 300
    cols = 6
    rows = (len(picks) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile, rows * (tile + 34)), "#111")
    draw = ImageDraw.Draw(sheet)
    fp = find_font("bold")
    font = ImageFont.truetype(str(fp), 22) if fp else ImageFont.load_default()
    for i, p in enumerate(picks):
        im = Image.open(p["scan"])
        W, H = im.size
        f = p["face"]
        side = min(W, H, f["h"] * H * 2.6)
        cx, cy = (f["x"] + f["w"] / 2) * W, (f["y"] + f["h"] / 2) * H + side * 0.12
        box = (max(0, min(W - side, cx - side / 2)), max(0, min(H - side, cy - side / 2)))
        crop = im.crop((round(box[0]), round(box[1]), round(box[0] + side), round(box[1] + side)))
        x, y = (i % cols) * tile, (i // cols) * (tile + 34)
        sheet.paste(crop.resize((tile, tile), Image.LANCZOS), (x, y))
        draw.text((x + 8, y + tile + 4), f"#{p['n']}  {fmt(p['t'])}  q{p['quality']:.2f}", fill="#FFE500", font=font)
    out = paths["build"] / "thumbs"
    sheet.save(out / "contact.jpg", quality=88)
    save_json(out / "candidates.json", [{k: v for k, v in p.items() if k != "scan"} for p in picks])
    print(f"{len(scored)} face frames of {len(files)} scanned; {len(picks)} picks")
    print(f"  {out / 'contact.jpg'}\n  {out / 'candidates.json'}")
    for p in picks:
        print(f"  #{p['n']:<3} {fmt(p['t']):>7}  q{p['quality']:.2f}  {p['said'][:70]}")


def cmd_grab(paths: dict, times: list[float], source: str) -> None:
    out_dir = paths["build"] / "thumbs"
    out_dir.mkdir(parents=True, exist_ok=True)
    for t in times:
        out = out_dir / f"frame_{t:g}{'' if source == 'raw' else '_' + source}.jpg"
        if source == "raw":
            video, src_t = timeline_source(paths, t)
        else:
            name = "final.mp4" if source == "plain" else "final_edited.mp4"
            video = paths["root"] / name
            if not video.exists():
                video = paths["root"] / name.replace("final", "preview")
            if not video.exists():
                die(f"no {name} or its preview to grab from")
            src_t = t
        moved = extract(video, src_t, out, settle=source == "raw")
        print(f"  {fmt(t)} -> {out.relative_to(paths['root'])}"
              + (f"  (best face {moved:+.1f}s away)" if moved else ""))


def cmd_cutout(paths: dict, image: str) -> None:
    import cv2
    import numpy as np

    src = (paths["root"] / image) if not Path(image).is_absolute() else Path(image)
    if not src.exists():
        die(f"no {src}")
    vb = vision_bin()
    if not vb:
        die("cut-outs need macOS (Apple Vision) - use a full frame layer instead")
    out = src.with_name(src.stem + "_cut.png")
    r = subprocess.run([str(vb), "cutout", str(src), str(out)], capture_output=True, text=True)
    if r.returncode != 0:
        die(r.stderr.strip())
    # The person mask leaves faint specks around the room; keep the speaker -
    # the biggest blob and anything nearly as big - and feather the edge.
    img = cv2.imread(str(out), cv2.IMREAD_UNCHANGED)
    alpha = img[:, :, 3]
    solid = (alpha > 128).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    if n > 1:
        areas = stats[1:, cv2.CC_STAT_AREA]
        keep = [i + 1 for i, a in enumerate(areas) if a >= areas.max() * 0.15]
        body = np.isin(labels, keep).astype(np.uint8)
        body = cv2.dilate(body, np.ones((9, 9), np.uint8))
        alpha = (alpha * body).astype(np.uint8)
        alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
        img[:, :, 3] = alpha
    ys, xs = np.nonzero(alpha > 16)
    img = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    cv2.imwrite(str(out), img)
    print(f"  {out.relative_to(paths['root'])}  ({img.shape[1]}x{img.shape[0]})")


def referenced(value) -> list[str]:
    if isinstance(value, dict):
        return [f for v in value.values() for f in referenced(v)]
    if isinstance(value, list):
        return [f for v in value for f in referenced(v)]
    return [value] if isinstance(value, str) and re.search(r"\.(jpe?g|png|webp|gif|svg)$", value, re.I) else []


def title_of(paths: dict) -> str:
    md = paths["root"] / "upload" / "youtube-metadata.md"
    if md.exists():
        m = re.search(r"## Title[^\n]*\n+(?:\d+\.\s*|-\s*)?(.+)", md.read_text())
        if m:
            return m.group(1).strip().strip("*`")
    return paths["root"].name.replace("_", " ")


def cmd_render(paths: dict) -> None:
    from PIL import Image

    spec_file = paths["build"] / "thumbnails.json"
    if not spec_file.exists():
        die(f"no {spec_file} - write the variants first (see the thumbnails skill)")
    variants = load_json(spec_file)["variants"]
    tl = load_json(paths["build"] / "timeline.json")
    vertical = tl["height"] > tl["width"]
    w, h = (1080, 1920) if vertical else (1920, 1080)

    if not (MOTION / "node_modules" / "@remotion" / "renderer").exists():
        from motion import ensure_node_modules
        ensure_node_modules("remotion")
    public = paths["build"] / "thumbs" / "public"
    tmp = paths["build"] / "thumbs" / "render"
    tmp.mkdir(parents=True, exist_ok=True)
    items = []
    for v in variants:
        for rel in referenced(v["layers"]):
            src, dst = paths["root"] / rel, public / rel
            if not src.exists():
                die(f"variant {v['id']}: no {rel}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        items.append({"out": str(tmp / f"{v['id']}.png"), "width": w, "height": h, "scale": SCALE,
                      "props": {"layers": v["layers"], **({"background": v["background"]} if "background" in v else {})}})
    spec = paths["build"] / "thumbs" / "spec.json"
    save_json(spec, {"publicDir": str(public), "items": items})
    info(f"rendering {len(items)} thumbnail(s)")
    if subprocess.run(["node", str(MOTION / "still.mjs"), str(spec)], cwd=MOTION).returncode != 0:
        die("thumbnail render failed - see the output above")

    up = paths["root"] / "upload" / "thumbnails"
    up.mkdir(parents=True, exist_ok=True)
    wanted = set()
    for v in variants:
        im = Image.open(tmp / f"{v['id']}.png").convert("RGB")
        out = up / f"{v['id']}.jpg"
        wanted.add(out.name)
        # 4:4:4 keeps the edges of red and yellow text crisp
        for q in (95, 92, 88, 85, 82):
            im.save(out, quality=q, subsampling=0, optimize=True)
            if out.stat().st_size <= MAX_BYTES:
                break
        size = out.stat().st_size
        note = "" if size <= MAX_BYTES else "  (over 2 MB: upload from desktop Studio, which takes 50 MB)"
        print(f"  {out.relative_to(paths['root'])}  {im.width}x{im.height}  {size // 1024} KB{note}")
    for old in up.glob("*.jpg"):
        if old.name not in wanted:
            old.unlink()
    check_sheet(paths, variants, vertical, tl["duration"])


def check_sheet(paths: dict, variants: list[dict], vertical: bool, duration: float) -> None:
    """Each variant as a viewer meets it: the phone home feed (dark and light
    theme, with the duration badge YouTube draws bottom-right) and the small
    suggested-video size beside a title."""
    from PIL import Image, ImageDraw, ImageFont
    from common import find_font

    fb, fr = find_font("bold"), find_font("regular") or find_font("bold")
    F = lambda p, s: ImageFont.truetype(str(p), s) if p else ImageFont.load_default()
    title = title_of(paths)
    m, s = divmod(int(round(duration)), 60)
    badge = f"{m}:{s:02d}"
    big = (240, 427) if vertical else (400, 225)      # ~ phone feed width at 1x
    small = (94, 167) if vertical else (168, 94)      # suggested / search
    rowh = big[1] + 90
    sheet = Image.new("RGB", (len(variants) * (big[0] + 40) + 40, 2 * rowh + 60 + small[1] + 40), "#808080")
    d = ImageDraw.Draw(sheet)
    for i, v in enumerate(variants):
        im = Image.open(paths["root"] / "upload" / "thumbnails" / f"{v['id']}.jpg")
        x = 40 + i * (big[0] + 40)
        for row, (bg, fg) in enumerate((("#0F0F0F", "#F1F1F1"), ("#FFFFFF", "#0F0F0F"))):
            y = 20 + row * rowh
            d.rectangle([x - 20, y - 10, x + big[0] + 20, y + rowh - 20], fill=bg)
            t = im.resize(big, Image.LANCZOS)
            mask = Image.new("L", big, 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, big[0] - 1, big[1] - 1], 12, fill=255)
            sheet.paste(t, (x, y), mask)
            f = F(fb, 15)
            bw = d.textlength(badge, font=f) + 10
            d.rounded_rectangle([x + big[0] - bw - 6, y + big[1] - 26, x + big[0] - 6, y + big[1] - 6], 4, fill="#000000CC")
            d.text((x + big[0] - bw - 1, y + big[1] - 25), badge, fill="white", font=f)
            d.text((x, y + big[1] + 10), (title[:48] + "…") if len(title) > 49 else title, fill=fg, font=F(fb, 17))
            d.text((x, y + big[1] + 36), f"{v['id']}: {v.get('idea', '')}"[:60], fill="#888", font=F(fr, 14))
        y = 2 * rowh + 40
        sheet.paste(im.resize(small, Image.LANCZOS), (x, y))
        d.text((x + small[0] + 10, y), f"{v['id']} at\nsuggested\nsize", fill="black", font=F(fr, 14))
    out = paths["build"] / "thumbs" / "check.jpg"
    sheet.save(out, quality=90)
    print(f"  {out.relative_to(paths['root'])}  - look at it: is the text readable and the face clear at this size?")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("frames")
    a.add_argument("project")
    a.add_argument("--every", type=float, default=2.0, help="seconds between scanned frames")
    a.add_argument("--count", type=int, default=24, help="candidates to keep")
    a = sub.add_parser("grab")
    a.add_argument("project")
    a.add_argument("times", nargs="+", type=float)
    a.add_argument("--from", dest="source", choices=["raw", "plain", "edited"], default="raw")
    a = sub.add_parser("cutout")
    a.add_argument("project")
    a.add_argument("image")
    a = sub.add_parser("render")
    a.add_argument("project")
    args = ap.parse_args()

    paths = project_paths(args.project)
    if args.cmd == "frames":
        cmd_frames(paths, args.every, args.count)
    elif args.cmd == "grab":
        cmd_grab(paths, args.times, args.source)
    elif args.cmd == "cutout":
        cmd_cutout(paths, args.image)
    else:
        cmd_render(paths)
    return 0


if __name__ == "__main__":
    sys.exit(main())
