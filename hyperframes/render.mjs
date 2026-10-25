// Render a batch of motion-graphics clips with HyperFrames, from the same JSON
// spec as motion/render.mjs - so tools/motion.py can hand either engine the
// same job.
//
//   node render.mjs spec.json
//
// spec: {"publicDir": "...", "items": [{"out": ".../x.webm", "comp": "TitleCard",
//        "width": 1920, "height": 1080, "fps": 30, "duration": 2.5,
//        "transparent": true, "props": {...}}]}
//
// The components are motion/src/comps, the same files Remotion renders,
// bundled with shim/remotion.tsx standing in for Remotion. publicDir becomes
// the HyperFrames project: it already holds the project files the props name
// (logos, screenshots), and this adds the bundle, GSAP, the fonts and one
// entry page per item.
import {build} from 'esbuild';
import {createRenderJob, executeRenderJob, resolveConfig} from '@hyperframes/producer';
import {copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!spec.items?.length) process.exit(0);

const project = spec.publicDir;
const lib = path.join(project, '_hf');
mkdirSync(lib, {recursive: true});

const mod = (name) => path.join(here, 'node_modules', name);
await build({
  entryPoints: [path.join(here, 'src', 'entry.tsx')],
  outfile: path.join(lib, 'bundle.js'),
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome120',
  logLevel: 'error',
  define: {'process.env.NODE_ENV': '"production"'},
  // one React for every file, wherever it sits, and the shim for Remotion
  alias: {
    remotion: path.join(here, 'shim', 'remotion.tsx'),
    '@remotion/google-fonts/Inter': path.join(here, 'shim', 'inter.ts'),
    '@remotion/google-fonts/Montserrat': path.join(here, 'shim', 'montserrat.ts'),
    '@remotion/google-fonts/TikTokSans': path.join(here, 'shim', 'tiktok-sans.ts'),
    react: mod('react'),
    'react-dom': mod('react-dom'),
  },
});

copyFileSync(mod('gsap/dist/gsap.min.js'), path.join(lib, 'gsap.min.js'));
// every face a component asks its loadFont for, served from disk
const FONTS = [
  ['Inter', 'inter', [500, 700, 800, 900]],
  ['Montserrat', 'montserrat', [600, 700, 800, 900]],
  ['TikTok Sans', 'tiktok-sans', [500, 600]],
];
const faces = [];
for (const [family, pkg, weights] of FONTS) {
  const fontDir = mod(`@fontsource/${pkg}/files`);
  for (const weight of weights) {
    const file = `${pkg}-latin-${weight}-normal.woff2`;
    copyFileSync(path.join(fontDir, file), path.join(lib, file));
    faces.push(`@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(${file}) format('woff2')}`);
  }
}
writeFileSync(path.join(lib, 'fonts.css'), faces.join('\n') + '\n');

// entry pages left by an earlier batch
for (const f of readdirSync(project)) if (/^_hf_\d+\.html$/.test(f)) unlinkSync(path.join(project, f));

// An opaque card fading out fades to black, as it does under Remotion - not
// to the white an empty page would leave behind.
const page = (item) => {
  const {width: w, height: h, duration: d} = item;
  const data = JSON.stringify({comp: item.comp, props: item.props, width: w, height: h, fps: item.fps, duration: d})
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${w}, height=${h}">
<link rel="stylesheet" href="_hf/fonts.css">
<style>
/* the components are written for Remotion's page, which sizes every box this way */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; background: ${item.transparent ? 'transparent' : '#000'}; }
#root { position: relative; width: ${w}px; height: ${h}px; overflow: hidden; }
#stage { position: absolute; inset: 0; }
</style>
<script src="_hf/gsap.min.js"></script>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${d}" data-width="${w}" data-height="${h}">
  <div id="stage" class="clip" data-start="0" data-duration="${d}" data-track-index="1"></div>
</div>
<script>window.__MOTION__ = ${data};</script>
<script src="_hf/bundle.js"></script>
</body>
</html>
`;
};

// The engine narrates every browser session on the console ("[initSession:
// ...]", "[Browser:WARN] ..."), dozens of lines a clip. Keep errors and this
// script's own progress lines, drop the rest.
for (const level of ['log', 'info', 'warn', 'debug']) {
  const write = console[level].bind(console);
  console[level] = (...a) => (typeof a[0] === 'string' && a[0].startsWith('[') ? undefined : write(...a));
}
const silent = {debug() {}, info() {}, warn() {}, error: (...a) => console.error('  hyperframes:', ...a)};
// libvpx at cpu-used 8 is several times faster than the engine's default 4 and
// indistinguishable on flat graphics - the same trade render.mjs in motion/
// makes for Remotion. Workers are left to the engine, which sizes them by
// frame count: short clips spend more starting browsers than drawing.
const engine = resolveConfig({vp9CpuUsed: 8});
for (const [i, item] of spec.items.entries()) {
  const entry = `_hf_${i}.html`;
  writeFileSync(path.join(project, entry), page(item));
  const t0 = Date.now();
  const tmp = item.out + '.part' + path.extname(item.out);
  const job = createRenderJob({
    fps: item.fps,
    quality: 'high',
    entryFile: entry,
    logger: silent,
    producerConfig: engine,
    // transparent layers are VP9 WebM with alpha, which ffmpeg overlays
    // directly; full-frame cards are H.264, as with Remotion
    ...(item.transparent ? {format: 'webm'} : {format: 'mp4', crf: 16}),
  });
  await executeRenderJob(job, project, tmp);
  renameSync(tmp, item.out);
  console.log(`  [${i + 1}/${spec.items.length}] ${item.comp} ${item.duration}s -> ${path.basename(item.out)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
