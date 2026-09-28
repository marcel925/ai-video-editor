// Render a batch of motion-graphics clips from one JSON spec.
//
//   node render.mjs spec.json
//
// spec: {"publicDir": "...", "items": [{"out": ".../x.webm", "comp": "TitleCard",
//        "width": 1920, "height": 1080, "fps": 30, "duration": 2.5,
//        "transparent": true, "props": {...}}]}
//
// Written by tools/motion.py - call that, not this. Bundles once, then renders
// each item. Transparent items become VP9 WebM with alpha (small, and ffmpeg
// composites them directly); opaque full-frame cards become H.264.
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {readFileSync, renameSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!spec.items?.length) process.exit(0);

const serveUrl = await bundle({
  entryPoint: path.join(here, 'src', 'index.ts'),
  publicDir: spec.publicDir,
});

const concurrency = Math.max(2, Math.floor(os.cpus().length * 0.75));
for (const [i, item] of spec.items.entries()) {
  const inputProps = {...item.props, _w: item.width, _h: item.height, _fps: item.fps, _dur: item.duration};
  const composition = await selectComposition({serveUrl, id: item.comp, inputProps});
  const t0 = Date.now();
  const tmp = item.out + '.part' + path.extname(item.out);
  await renderMedia({
    composition, serveUrl, inputProps, outputLocation: tmp, concurrency, muted: true,
    ...(item.transparent
      ? {codec: 'vp9', imageFormat: 'png', pixelFormat: 'yuva420p'}
      : {codec: 'h264', imageFormat: 'jpeg', crf: 16}),
    // libvpx's default speed is its slowest; realtime is ~5x faster and
    // indistinguishable on flat graphics like these
    ffmpegOverride: ({type, args}) =>
      type === 'stitcher' && item.transparent
        ? [...args.slice(0, -1), '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', args[args.length - 1]]
        : args,
    logLevel: 'error',
  });
  renameSync(tmp, item.out);
  console.log(`  [${i + 1}/${spec.items.length}] ${item.comp} ${item.duration}s -> ${path.basename(item.out)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
