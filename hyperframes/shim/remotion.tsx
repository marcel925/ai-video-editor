// The slice of Remotion's API the components in motion/src/comps use,
// reimplemented so the same components render under HyperFrames. Written from
// the documented behaviour, not copied: Remotion's source is under its own
// licence, and this folder is Apache/MIT territory.
//
// Covered: AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig,
// interpolate, spring, Easing. Anything else a component imports fails the
// bundle, which is the point - add it here first.
import React, {createContext, useContext} from 'react';

export type VideoConfig = {width: number; height: number; fps: number; durationInFrames: number};
type FrameState = VideoConfig & {frame: number};

const Ctx = createContext<FrameState | null>(null);
export const FrameProvider = Ctx.Provider;

const state = (): FrameState => {
  const s = useContext(Ctx);
  if (!s) throw new Error('rendered outside FrameProvider');
  return s;
};
export const useCurrentFrame = () => state().frame;
export const useVideoConfig = (): VideoConfig => {
  const {width, height, fps, durationInFrames} = state();
  return {width, height, fps, durationInFrames};
};

export const AbsoluteFill = ({style, children, ...rest}: React.HTMLAttributes<HTMLDivElement>) => (
  <div {...rest} style={{position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%',
    display: 'flex', flexDirection: 'column', ...style}}>
    {children}
  </div>
);

// The entry page waits for every <img> to decode before the first frame is
// captured, so a plain <img> is enough here.
export const Img = (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img alt="" {...props} />;

// Project files sit next to the entry page, at the same relative paths.
export const staticFile = (path: string) => path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

type Extrapolate = 'extend' | 'clamp' | 'identity';
type InterpolateOptions = {extrapolateLeft?: Extrapolate; extrapolateRight?: Extrapolate; easing?: (t: number) => number};

export function interpolate(x: number, input: readonly number[], output: readonly number[], opts: InterpolateOptions = {}): number {
  if (input.length !== output.length || input.length < 2) throw new Error('interpolate: ranges must match and have 2+ points');
  const {extrapolateLeft = 'extend', extrapolateRight = 'extend', easing = (t: number) => t} = opts;
  // the segment x falls in; outside the range, the first or last one
  let i = 1;
  while (i < input.length - 1 && x > input[i]) i++;
  const [a, b] = [input[i - 1], input[i]];
  const [lo, hi] = [output[i - 1], output[i]];
  if (x < input[0]) {
    if (extrapolateLeft === 'clamp') return output[0];
    if (extrapolateLeft === 'identity') return x;
  }
  if (x > input[input.length - 1]) {
    if (extrapolateRight === 'clamp') return output[output.length - 1];
    if (extrapolateRight === 'identity') return x;
  }
  const t = b === a ? 1 : (x - a) / (b - a);
  return lo + (hi - lo) * easing(t);
}

type SpringConfig = {mass?: number; damping?: number; stiffness?: number; overshootClamping?: boolean};

/** A damped spring from 0 to 1, starting at rest, sampled at `frame`. Uses the
 * closed-form solution of m·x'' + c·x' + k·(x - 1) = 0, so any frame can be
 * asked for in any order and always gives the same value. */
export function spring({frame, fps, config = {}, from = 0, to = 1}: {frame: number; fps: number; config?: SpringConfig; from?: number; to?: number}): number {
  const {mass = 1, damping = 10, stiffness = 100, overshootClamping = false} = config;
  if (frame <= 0) return from;
  const t = frame / fps;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let x: number; // displacement from the target, starting at -1
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    x = -Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
  } else if (zeta === 1) {
    x = -Math.exp(-w0 * t) * (1 + w0 * t);
  } else {
    const s = w0 * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * w0 + s;
    const r2 = -zeta * w0 - s;
    x = -(r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
  }
  let p = 1 + x;
  if (overshootClamping && p > 1) p = 1;
  return from + (to - from) * p;
}

export const Easing = {
  linear: (t: number) => t,
  quad: (t: number) => t * t,
  cubic: (t: number) => t * t * t,
  in: (f: (t: number) => number) => f,
  out: (f: (t: number) => number) => (t: number) => 1 - f(1 - t),
  inOut: (f: (t: number) => number) => (t: number) => (t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2),
};
