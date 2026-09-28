import React from 'react';
import {loadFont} from '@remotion/google-fonts/Inter';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing} from 'remotion';

export const {fontFamily} = loadFont('normal', {
  weights: ['500', '700', '800', '900'],
  subsets: ['latin'],
});

// Yellow matches the karaoke caption highlight (&H0000E5FF in captions.py),
// so graphics and captions read as one system.
export const C = {
  accent: '#FFE500',
  ink: '#0B0B0F',
  panel: 'rgba(12, 12, 16, 0.82)',
  white: '#FFFFFF',
  dim: 'rgba(255,255,255,0.45)',
  red: '#FF453A',
  green: '#32D74B',
};

export type Common = {
  accent?: string;
  // 'none' renders transparent, for overlaying on the speaker.
  bg?: 'none' | 'dark' | 'accent' | 'light';
};

/** Everything is sized off the short edge, so one component serves 16:9 and 9:16. */
export const useLayout = () => {
  const {width, height, fps, durationInFrames} = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  return {width, height, fps, durationInFrames, u, vertical: height > width};
};

/** 0 -> 1 spring on entry, and 0 -> 1 over the last `outFrames` for the exit. */
export const useInOut = (delay = 0, outFrames = 9) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const enter = spring({frame: frame - delay, fps, config: {damping: 14, stiffness: 160, mass: 0.7}});
  const exit = interpolate(frame, [durationInFrames - outFrames, durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });
  return {frame, enter, exit};
};

export const pop = (frame: number, fps: number, delay = 0, damping = 12) =>
  spring({frame: frame - delay, fps, config: {damping, stiffness: 180, mass: 0.6}});

export const Backdrop: React.FC<{kind?: Common['bg']; accent?: string}> = ({kind = 'none', accent = C.accent}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  if (kind === 'none') return null;
  if (kind === 'accent') {
    return <AbsoluteFill style={{background: accent}} />;
  }
  if (kind === 'light') {
    return <AbsoluteFill style={{background: '#F4F4F0'}} />;
  }
  // Dark, with two slow drifting glows so a held card never looks frozen.
  const t = frame / 30;
  const x1 = 30 + Math.sin(t * 0.6) * 12;
  const y1 = 30 + Math.cos(t * 0.5) * 10;
  const x2 = 72 + Math.cos(t * 0.4) * 10;
  const y2 = 75 + Math.sin(t * 0.7) * 8;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at ${x1}% ${y1}%, ${accent}22 0%, transparent 45%),
          radial-gradient(circle at ${x2}% ${y2}%, #5B8CFF22 0%, transparent 50%), ${C.ink}`,
      }}
    >
      <svg width={width} height={height} style={{position: 'absolute', opacity: 0.07}}>
        <defs>
          <pattern id="grid" width={Math.round(width / 24)} height={Math.round(width / 24)} patternUnits="userSpaceOnUse">
            <path d={`M ${Math.round(width / 24)} 0 L 0 0 0 ${Math.round(width / 24)}`} fill="none" stroke="white" strokeWidth={1} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>
    </AbsoluteFill>
  );
};

/** A dark rounded panel for text over live footage: a balcony behind white
 * text is unreadable without one. */
export const Panel: React.FC<{style?: React.CSSProperties; children: React.ReactNode}> = ({style, children}) => {
  const {u} = useLayout();
  return (
    <div
      style={{
        background: C.panel,
        borderRadius: 28 * u,
        padding: `${30 * u}px ${44 * u}px`,
        boxShadow: `0 ${20 * u}px ${60 * u}px rgba(0,0,0,0.45)`,
        border: `${2 * u}px solid rgba(255,255,255,0.08)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** In 9:16 the face sits around 25-35% and burned captions around 62-70%, so
 * "centre" for a graphic means the band between them, a little above middle. */
export const verticalCenter = (u: number): React.CSSProperties => ({paddingBottom: 300 * u});

export const textShadow = (u: number) => `0 ${4 * u}px ${24 * u}px rgba(0,0,0,0.55)`;

export const base: React.CSSProperties = {fontFamily, color: C.white};
