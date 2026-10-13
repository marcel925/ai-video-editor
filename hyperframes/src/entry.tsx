// The page side of a HyperFrames render: draws one motion component, from
// motion/src/comps, at whatever frame the renderer seeks to.
//
// render.mjs writes window.__MOTION__ = {comp, props, width, height, fps,
// duration} into the entry page. HyperFrames seeks a paused GSAP timeline; the
// one registered here tweens a single number, the clip time, and drawing
// happens in that number's setter - so every seek, forwards or backwards,
// redraws the component for exactly that frame.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {FrameProvider} from 'remotion';
import {TitleCard} from '../../motion/src/comps/TitleCard';
import {BigNumber} from '../../motion/src/comps/BigNumber';
import {ListReveal} from '../../motion/src/comps/ListReveal';
import {KineticText} from '../../motion/src/comps/KineticText';
import {LowerThird} from '../../motion/src/comps/LowerThird';
import {Compare} from '../../motion/src/comps/Compare';
import {LogoPop} from '../../motion/src/comps/LogoPop';
import {ScreenshotCard} from '../../motion/src/comps/ScreenshotCard';
import {EndCard} from '../../motion/src/comps/EndCard';
import {Stamp} from '../../motion/src/comps/Stamp';

const COMPS: Record<string, React.FC<any>> = {
  TitleCard, BigNumber, ListReveal, KineticText, LowerThird, Compare, LogoPop, ScreenshotCard, EndCard, Stamp,
};

type Spec = {comp: string; props: Record<string, unknown>; width: number; height: number; fps: number; duration: number};
declare global {
  interface Window {
    __MOTION__: Spec;
    __timelines: Record<string, unknown>;
    gsap: any;
  }
}

const spec = window.__MOTION__;
const Comp = COMPS[spec.comp];
if (!Comp) throw new Error(`unknown motion component ${spec.comp}`);
const durationInFrames = Math.max(1, Math.round(spec.duration * spec.fps));
const root = createRoot(document.getElementById('stage')!);

const draw = (frame: number) =>
  flushSync(() =>
    root.render(
      <FrameProvider value={{frame, fps: spec.fps, width: spec.width, height: spec.height, durationInFrames}}>
        <Comp {...spec.props} />
      </FrameProvider>,
    ),
  );

async function main() {
  draw(0);
  // nothing may be captured before the fonts and every image are ready
  await document.fonts.ready;
  await Promise.all([...document.images].map((im) => im.decode().catch(() => undefined)));

  let current = -1;
  const clock = {
    get t() {
      return current < 0 ? 0 : current / spec.fps;
    },
    set t(seconds: number) {
      const frame = Math.min(durationInFrames - 1, Math.max(0, Math.round(seconds * spec.fps)));
      if (frame !== current) {
        current = frame;
        draw(frame);
      }
    },
  };
  const tl = window.gsap.timeline({paused: true});
  tl.fromTo(clock, {t: 0}, {t: spec.duration, duration: spec.duration, ease: 'none'}, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines.main = tl;
}

main();
