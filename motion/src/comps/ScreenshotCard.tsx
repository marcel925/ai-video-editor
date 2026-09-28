import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile} from 'remotion';
import {Backdrop, C, Common, base, pop, useInOut, useLayout} from '../theme';

/** A screenshot presented as an object: tilted in on a spring, framed as a
 * phone or a browser window, slowly drifting so it never sits dead. */
export type ScreenshotCardProps = Common & {
  file: string;
  frame?: 'phone' | 'browser' | 'none';
  caption?: string;
  highlight?: string; // a pill of text pinned to the card, e.g. "+28.88%"
  scale?: number; // fraction of the frame width the card may occupy
  aspect?: number; // width / height of the image; tools/motion.py fills it in
};

export const ScreenshotCard: React.FC<ScreenshotCardProps> = ({
  file, frame: device = 'none', caption, highlight, scale = 0.82, aspect = 16 / 10, bg = 'dark', accent = C.accent,
}) => {
  const {u, fps, vertical, width, height, durationInFrames} = useLayout();
  const {frame, enter, exit} = useInOut();
  const drift = interpolate(frame, [0, durationInFrames], [1, 1.06]);
  const tilt = (1 - enter) * 18;
  const maxW = device === 'phone' ? Math.min(width, height) * 0.5 : width * (vertical ? 0.9 : scale);
  const maxH = height * (caption ? 0.7 : 0.8);
  const pad = device === 'phone' ? 18 * u : 0;
  const chrome = device === 'browser' ? 48 * u : 0;
  // fill the box: an <img> only ever scales down on its own
  const imgW = Math.min(maxW, (maxH - chrome) * aspect);

  return (
    <AbsoluteFill style={{...base, opacity: 1 - exit}}>
      <Backdrop kind={bg} accent={accent} />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: 36 * u, perspective: 1600 * u}}>
        <div
          style={{
            transform: `translateY(${(1 - enter) * 160 * u}px) rotateX(${tilt}deg) scale(${(0.85 + 0.15 * enter) * drift})`,
            opacity: Math.min(1, enter * 1.5),
            background: device === 'none' ? 'transparent' : device === 'phone' ? '#111' : '#E9E9EC',
            borderRadius: device === 'phone' ? 70 * u : 22 * u,
            padding: pad,
            paddingTop: pad + chrome,
            boxShadow: `0 ${40 * u}px ${120 * u}px rgba(0,0,0,0.6)`,
            position: 'relative',
          }}
        >
          {device === 'browser' ? (
            <div style={{position: 'absolute', top: 16 * u, left: 22 * u, display: 'flex', gap: 10 * u}}>
              {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
                <div key={c} style={{width: 16 * u, height: 16 * u, borderRadius: 8 * u, background: c}} />
              ))}
            </div>
          ) : null}
          <Img src={staticFile(file)} style={{display: 'block', width: imgW, height: imgW / aspect,
            borderRadius: device === 'phone' ? 54 * u : device === 'browser' ? `0 0 ${16 * u}px ${16 * u}px` : 18 * u}} />
          {highlight ? (
            <div style={{position: 'absolute', right: -30 * u, top: -30 * u, background: accent, color: C.ink, fontWeight: 900,
              fontSize: 64 * u, padding: `${8 * u}px ${24 * u}px`, borderRadius: 18 * u, transform: `scale(${pop(frame, fps, 14, 9)}) rotate(6deg)`,
              boxShadow: `0 ${10 * u}px ${30 * u}px rgba(0,0,0,0.4)`}}>
              {highlight}
            </div>
          ) : null}
        </div>
        {caption ? (
          <div style={{fontSize: 48 * u, fontWeight: 800, opacity: pop(frame, fps, 8), textAlign: 'center', maxWidth: width * 0.85,
            background: bg === 'none' ? 'rgba(12,12,16,0.82)' : undefined, padding: bg === 'none' ? `${10 * u}px ${24 * u}px` : 0, borderRadius: 14 * u}}>
            {caption}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
