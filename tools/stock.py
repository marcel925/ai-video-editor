#!/usr/bin/env python3
"""Find and download stock footage and photos from Pexels and Pixabay.

Two steps, on purpose - search, look, then fetch:

  stock.py search <project> "rocket launch" [--kind video|photo]
      Queries both services, downloads a thumbnail per hit and tiles them into
      one numbered contact sheet at build/stock/sheets/<query>.jpg. Look at
      the sheet before choosing: a title that matches the query says nothing
      about whether the clip matches the *sentence*.

  stock.py get <project> pexels-v-28953923 [--name rocket] [--from 2]
      Downloads the best rendition for the project's frame into
      assets/stock/<name>.<ext> and records the credit in
      assets/stock/credits.json and CREDITS.md.

Keys come from PEXELS_API_KEY / PIXABAY_API_KEY: the environment, or a .env in
the working folder (see .env.example). One of the two is enough.

Service rules this follows: Pixabay requires results be cached for 24h and
forbids hotlinking, so responses are cached under build/stock/cache/ and every
file is downloaded locally. Both ask for credit - CREDITS.md is ready to paste
into a video description.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

from common import (die, find_font, load_env, info, infer_profile, load_json, project_paths,
                    save_json)

ROOT = Path(__file__).resolve().parent.parent
CACHE_TTL = 24 * 3600
UA = {"User-Agent": "video_editor/1.0 (local editing pipeline)"}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:48] or "stock"


def cached_get(url: str, params: dict, headers: dict, cache_dir: Path) -> dict:
    key = hashlib.sha1(json.dumps([url, {k: v for k, v in params.items()
                                         if k != "key"}], sort_keys=True)
                       .encode()).hexdigest()[:16]
    path = cache_dir / f"{key}.json"
    if path.exists() and time.time() - path.stat().st_mtime < CACHE_TTL:
        return load_json(path)
    r = requests.get(url, params=params, headers={**UA, **headers}, timeout=30)
    if r.status_code == 429:
        die(f"rate limited by {url.split('/')[2]} - wait and retry "
            f"(reset in {r.headers.get('X-Ratelimit-Reset', '?')}s)")
    r.raise_for_status()
    data = r.json()
    save_json(path, data)
    return data


# ---------------------------------------------------------------- searching

def search_pexels(query: str, kind: str, orientation: str, n: int,
                  min_dur: float, cache: Path) -> list[dict]:
    keyv = os.environ.get("PEXELS_API_KEY")
    if not keyv:
        info("no PEXELS_API_KEY - skipping Pexels")
        return []
    hdr = {"Authorization": keyv}
    params = {"query": query, "per_page": min(80, n * 2),
              "orientation": orientation}
    if kind == "video":
        data = cached_get("https://api.pexels.com/videos/search", params, hdr, cache)
        out = []
        for v in data.get("videos", []):
            if v.get("duration", 0) < min_dur:
                continue
            pics = v.get("video_pictures") or []
            thumb = pics[len(pics) // 2]["picture"] if pics else v["image"]
            out.append({
                "id": f"pexels-v-{v['id']}", "source": "pexels", "kind": "video",
                "width": v["width"], "height": v["height"],
                "duration": v["duration"], "thumb": thumb,
                "title": v["url"].rstrip("/").split("/")[-1],
                "author": v["user"]["name"], "page": v["url"],
                "files": [{"w": f["width"], "h": f["height"], "url": f["link"],
                           "fps": f.get("fps")}
                          for f in v["video_files"]
                          if f.get("file_type") == "video/mp4" and f.get("width")],
            })
        return out[:n]
    data = cached_get("https://api.pexels.com/v1/search", params, hdr, cache)
    return [{
        "id": f"pexels-p-{p['id']}", "source": "pexels", "kind": "photo",
        "width": p["width"], "height": p["height"], "duration": 0,
        "thumb": p["src"]["medium"], "title": p.get("alt") or "",
        "author": p["photographer"], "page": p["url"],
        "files": [{"w": p["width"], "h": p["height"], "url": p["src"]["original"]}],
    } for p in data.get("photos", [])][:n]


def search_pixabay(query: str, kind: str, orientation: str, n: int,
                   min_dur: float, cache: Path) -> list[dict]:
    keyv = os.environ.get("PIXABAY_API_KEY")
    if not keyv:
        info("no PIXABAY_API_KEY - skipping Pixabay")
        return []
    params = {"key": keyv, "q": query[:100], "per_page": max(3, min(200, n * 2)),
              "safesearch": "true"}
    if kind == "video":
        data = cached_get("https://pixabay.com/api/videos/", params, {}, cache)
        out = []
        for h in data.get("hits", []):
            vids = {k: v for k, v in h["videos"].items() if v.get("width")}
            if not vids or h.get("duration", 0) < min_dur:
                continue
            best = max(vids.values(), key=lambda v: v["width"] * v["height"])
            portrait = best["height"] > best["width"]
            # Pixabay's video search has no orientation filter; apply it here
            if (orientation == "portrait") != portrait:
                continue
            out.append({
                "id": f"pixabay-v-{h['id']}", "source": "pixabay", "kind": "video",
                "width": best["width"], "height": best["height"],
                "duration": h["duration"],
                "thumb": (vids.get("medium") or best).get("thumbnail") or "",
                "title": h.get("tags", ""), "author": h["user"],
                "page": h["pageURL"],
                "files": [{"w": v["width"], "h": v["height"], "url": v["url"]}
                          for v in vids.values()],
            })
        return out[:n]
    params.update({"image_type": "photo",
                   "orientation": "vertical" if orientation == "portrait"
                   else "horizontal"})
    data = cached_get("https://pixabay.com/api/", params, {}, cache)
    return [{
        "id": f"pixabay-p-{h['id']}", "source": "pixabay", "kind": "photo",
        "width": h["imageWidth"], "height": h["imageHeight"], "duration": 0,
        "thumb": h["webformatURL"], "title": h.get("tags", ""),
        "author": h["user"], "page": h["pageURL"],
        "files": [{"w": 1280 if h["imageWidth"] >= h["imageHeight"] else
                   int(1280 * h["imageWidth"] / h["imageHeight"]),
                   "h": 1280 if h["imageHeight"] > h["imageWidth"] else
                   int(1280 * h["imageHeight"] / h["imageWidth"]),
                   "url": h["largeImageURL"]}],
    } for h in data.get("hits", [])][:n]


def contact_sheet(hits: list[dict], out: Path, query: str) -> None:
    from io import BytesIO
    from PIL import Image, ImageDraw, ImageFont
    cols, tw, th = 4, 400, 225
    rows = (len(hits) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * (th + 34) + 40), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(str(find_font("bold")), 18)
        small = ImageFont.truetype(str(find_font("regular")), 14)
    except OSError:
        font = small = ImageFont.load_default()
    draw.text((10, 10), f'"{query}"', fill=(255, 214, 10), font=font)
    for i, h in enumerate(hits):
        x, y = (i % cols) * tw, 40 + (i // cols) * (th + 34)
        try:
            r = requests.get(h["thumb"], headers=UA, timeout=20)
            img = Image.open(BytesIO(r.content)).convert("RGB")
            img.thumbnail((tw - 8, th - 8))
            sheet.paste(img, (x + (tw - img.width) // 2, y + (th - img.height) // 2))
        except Exception:
            draw.text((x + 10, y + 100), "(no thumbnail)", fill=(200, 80, 80), font=small)
        dur = f"{h['duration']}s " if h["duration"] else ""
        draw.rectangle([x + 4, y + 4, x + 40, y + 30], fill=(0, 0, 0))
        draw.text((x + 10, y + 6), str(i + 1), fill=(255, 214, 10), font=font)
        draw.text((x + 6, y + th + 2), f"{dur}{h['width']}x{h['height']} {h['source']}",
                  fill=(220, 220, 220), font=small)
        draw.text((x + 6, y + th + 17), h["title"][:52], fill=(150, 150, 150), font=small)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=85)


def cmd_search(args, paths, profile: str) -> None:
    orientation = args.orientation or ("portrait" if profile == "short" else "landscape")
    stock_dir = paths["build"] / "stock"
    cache = stock_dir / "cache"
    hits: list[dict] = []
    sources = ["pexels", "pixabay"] if args.source == "both" else [args.source]
    per = max(2, args.n // len(sources))
    for src in sources:
        fn = search_pexels if src == "pexels" else search_pixabay
        try:
            hits += fn(args.query, args.kind, orientation, per, args.min_duration, cache)
        except requests.RequestException as exc:
            info(f"{src} search failed: {exc}")
    if not hits:
        die(f'nothing found for "{args.query}" ({args.kind}, {orientation})')

    index = load_json(stock_dir / "index.json") if (stock_dir / "index.json").exists() else {}
    for h in hits:
        index[h["id"]] = h
    save_json(stock_dir / "index.json", index)

    sheet = stock_dir / "sheets" / f"{slug(args.query)}_{args.kind}.jpg"
    contact_sheet(hits, sheet, args.query)
    print(f"\n{sheet}\n")
    for i, h in enumerate(hits, 1):
        dur = f"{h['duration']:>3}s" if h["duration"] else "    "
        print(f"  {i:>2}  {h['id']:<22} {dur} {h['width']}x{h['height']:<5} "
              f"{h['title'][:60]}")


# ---------------------------------------------------------------- fetching

def pick_file(files: list[dict], tw: int, th: int) -> dict:
    """The smallest rendition that still covers the frame, else the largest.
    4K is never worth it here: the frame is at most 1920 on its long edge."""
    def covers(f):  # enough pixels to fill the frame after a cover-crop
        return min(f["w"] / tw, f["h"] / th) >= 0.98
    ok = [f for f in files if covers(f)]
    if ok:
        return min(ok, key=lambda f: f["w"] * f["h"])
    return max(files, key=lambda f: f["w"] * f["h"])


def cmd_get(args, paths, profile: str) -> None:
    stock_dir = paths["build"] / "stock"
    index = load_json(stock_dir / "index.json") if (stock_dir / "index.json").exists() else {}
    hit = index.get(args.id)
    if not hit:
        die(f"{args.id} is not in build/stock/index.json - run `stock.py search` "
            f"first and copy an id from its output")
    tw, th = (1080, 1920) if profile == "short" else (1920, 1080)
    f = pick_file(hit["files"], tw, th)
    ext = ".mp4" if hit["kind"] == "video" else ".jpg"
    url = f["url"]
    if hit["source"] == "pexels" and hit["kind"] == "photo":
        # the original can be 6000px+; ask the CDN for something frame-sized
        edge = "h=2400" if f["h"] > f["w"] and profile != "short" else "w=2400"
        url += ("&" if "?" in url else "?") + f"auto=compress&cs=tinysrgb&{edge}"
    out_dir = paths["assets"] / "stock"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = slug(args.name) if args.name else f"{slug(hit['title'])[:32]}_{hit['id'].split('-')[-1]}"
    out = out_dir / f"{name}{ext}"
    if out.exists() and not args.force:
        info(f"already downloaded: {out}")
    else:
        info(f"downloading {f['w']}x{f['h']} from {hit['source']} ...")
        with requests.get(url, headers=UA, stream=True, timeout=120) as r:
            r.raise_for_status()
            tmp = out.with_suffix(out.suffix + ".part")
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(1 << 20):
                    fh.write(chunk)
            tmp.rename(out)

    credits_path = out_dir / "credits.json"
    credits = load_json(credits_path) if credits_path.exists() else {}
    credits[out.name] = {"id": hit["id"], "source": hit["source"],
                         "author": hit["author"], "page": hit["page"],
                         "kind": hit["kind"], "duration": hit["duration"],
                         "size": [f["w"], f["h"]]}
    save_json(credits_path, credits)
    lines = ["# Stock credits", "",
             "Paste into the video description. Pexels and Pixabay content is "
             "free to use; credit is requested, not required.", ""]
    for fname, c in sorted(credits.items()):
        site = "Pexels" if c["source"] == "pexels" else "Pixabay"
        what = "Video" if c["kind"] == "video" else "Photo"
        lines.append(f"- {what} by {c['author']} on {site}: {c['page']}  (`{fname}`)")
    (out_dir / "CREDITS.md").write_text("\n".join(lines) + "\n")
    rel = out.relative_to(paths["root"])
    dur = f", {hit['duration']}s" if hit["duration"] else ""
    print(f"{rel}  ({f['w']}x{f['h']}{dur})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search", help="search both services, build a contact sheet")
    s.add_argument("project")
    s.add_argument("query")
    s.add_argument("--kind", choices=["video", "photo"], default="video")
    s.add_argument("--orientation", choices=["landscape", "portrait"],
                   help="default: follows the project's frame")
    s.add_argument("--source", choices=["both", "pexels", "pixabay"], default="both")
    s.add_argument("--n", type=int, default=12, help="total hits to show")
    s.add_argument("--min-duration", type=float, default=4.0)
    g = sub.add_parser("get", help="download one hit by id")
    g.add_argument("project")
    g.add_argument("id")
    g.add_argument("--name", help="file name under assets/stock/ (no extension)")
    g.add_argument("--force", action="store_true")
    for p in (s, g):
        p.add_argument("--profile", choices=["long", "short"])
    args = ap.parse_args()

    load_env()
    if not (os.environ.get("PEXELS_API_KEY") or os.environ.get("PIXABAY_API_KEY")):
        die("stock footage needs a free API key: PEXELS_API_KEY and/or "
            "PIXABAY_API_KEY\n  in a .env in this folder (see .env.example). "
            "https://www.pexels.com/api/  https://pixabay.com/api/docs/")
    paths = project_paths(args.project)
    profile = infer_profile(args.project, args.profile)
    (cmd_search if args.cmd == "search" else cmd_get)(args, paths, profile)
    return 0


if __name__ == "__main__":
    sys.exit(main())
