import React from 'react';
import {AbsoluteFill} from 'remotion';
import {Backdrop, C, Common, Panel, base, pop, textShadow, useInOut, useLayout, verticalCenter} from '../theme';

/** Lines that slam in one at a time, ideally on the word that says them:
 * pass `times` from `tools/words.py --find`. Words wrapped in *stars* are
 * drawn in the accent colour. */
export type KineticTextProps = Common & {
  lines: string[];
  times?: number[]; // seconds from clip start, one per line
  position?: 'center' | 'top' | 'left' | 'right' | 'bottom';
  size?: number; // font size at 1080 short edge
  align?: 'left' | 'center';
  panel?: boolean; // dark panel behind (default: true when bg is none)
};

const Words: React.FC<{text: string; accent: string; ink: string}> = ({text, accent, ink}) => (
  <>
    {text.split(/(\*[^*]+\*)/g).filter(Boolean).map((part, i) =>
      part.startsWith('*') ? (
        <span key={i} style={{color: accent}}>{part.slice(1, -1)}</span>
      ) : (
        <span key={i} style={{color: ink}}>{part}</span>
      ),
    )}
  </>
);

export const KineticText: React.FC<KineticTextProps> = ({
  lines, times, position = 'center', size = 96, align = 'center', panel, bg = 'none', accent = C.accent,
}) => {
  const {u, fps, vertical} = useLayout();
  const {frame, exit} = useInOut(0, 7);
  const ink = bg === 'accent' || bg === 'light' ? C.ink : C.white;
  const acc = bg === 'accent' ? C.ink : accent;
  const usePanel = panel ?? bg === 'none';
  const first = times?.[0] !== undefined ? times[0] * fps : 0;
  const box = pop(frame, fps, Math.max(0, first - 3), 16);

  const content = (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: align === 'left' ? 'flex-start' : 'center', gap: 6 * u}}>
      {lines.map((line, i) => {
        const at = times?.[i] !== undefined ? times[i] * fps : 2 + i * 7;
        const p = pop(frame, fps, at, 10);
        return (
          <div
            key={i}
            style={{
              fontSize: size * u, fontWeight: 900, lineHeight: 1.08, letterSpacing: -1.5 * u,
              textAlign: align, textTransform: 'uppercase',
              opacity: Math.min(1, p * 2),
              transform: `scale(${1.6 - 0.6 * p}) translateY(${(1 - p) * 10 * u}px)`,
              filter: `blur(${(1 - Math.min(1, p)) * 8 * u}px)`,
              textShadow: !usePanel && bg === 'none' ? textShadow(u) : undefined,
            }}
          >
            <Words text={line} accent={acc} ink={ink} />
          </div>
        );
      })}
    </div>
  );

  const place: React.CSSProperties =
    position === 'top' ? {justifyContent: 'flex-start', paddingTop: (vertical ? 250 : 80) * u}
      : position === 'bottom' ? {justifyContent: 'flex-end', paddingBottom: 110 * u}
        : position === 'left' ? {alignItems: 'flex-start', paddingLeft: 110 * u}
          : position === 'right' ? {alignItems: 'flex-end', paddingRight: 110 * u} : {};

  return (
    <AbsoluteFill style={{...base, opacity: 1 - exit}}>
      <Backdrop kind={bg} accent={accent} />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', ...(vertical && position === 'center' ? verticalCenter(u) : {}), ...place}}>
        {usePanel ? <Panel style={{opacity: box, transform: `scale(${0.85 + 0.15 * box})`}}>{content}</Panel> : content}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
