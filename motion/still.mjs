// Render thumbnails (stills) from one JSON spec.
//
//   node still.mjs spec.json
//
// spec: {"publicDir": "...", "items": [{"out": ".../A.png", "width": 1920,
//        "height": 1080, "scale": 2, "props": {"layers": [...]}}]}
//
// Laid out at 1920x1080 and rendered at `scale`, so a 4K thumbnail keeps the
// same layout numbers and its text and graphics come out sharp.
//
// Written by tools/thumbnail.py - call that, not this.
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!spec.items?.length) process.exit(0);

const serveUrl = await bundle({
  entryPoint: path.join(here, 'thumb', 'index.ts'),
  publicDir: spec.publicDir,
});

for (const item of spec.items) {
  const inputProps = {...item.props, _w: item.width, _h: item.height};
  const composition = await selectComposition({serveUrl, id: 'Thumbnail', inputProps});
  await renderStill({composition, serveUrl, inputProps, output: item.out, imageFormat: 'png', scale: item.scale ?? 1, logLevel: 'error', timeoutInMilliseconds: 60000});
  console.log(`  ${path.basename(item.out)}`);
}
