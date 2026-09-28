import React from 'react';
import {AbsoluteFill, Img, staticFile} from 'remotion';
import {C, Common, base, pop, useInOut, useLayout, verticalCenter} from '../theme';

/** Named tools popping in as white tiles: "use Firebase ... RevenueCat ...
 * PostHog". Give each a `time` so it lands on the word. `over` adds a small
 * caption like "instead of building auth". */
export type LogoPopProps = Common & {
  items: {file: string; label?: string; over?: string; time?: number}[];
  position?: 'right' | 'left' | 'top' | 'bottom' | 'center';
};

export const LogoPop: React.FC<LogoPopProps> = ({items, position = 'right', accent = C.accent}) => {
  const {u, fps, vertical} = useLayout();
  const {frame, exit} = useInOut();
    // three wordmarks never fit side by side in a 9:16 frame
  const column = vertical || position === 'left' || position === 'right';
  const tile = (vertical ? 300 : 230) * u;

  return (
    <AbsoluteFill
      style={{
        ...base, opacity: 1 - exit,
        flexDirection: column ? 'column' : 'row',
        justifyContent: 'center',
        alignItems: vertical ? 'center' : position === 'left' ? 'flex-start' : position === 'right' ? 'flex-end' : 'center',
        gap: 28 * u,
        padding: vertical ? `${260 * u}px ${50 * u}px` : `0 ${100 * u}px`,
        ...(vertical && position !== 'center' ? {justifyContent: position === 'bottom' ? 'flex-end' : 'flex-start'} : {}),
        ...(vertical && position === 'center' ? {paddingTop: 0, ...verticalCenter(u)} : {}),
      }}
    >
      {items.map((it, i) => {
        const at = it.time !== undefined ? it.time * fps : 3 + i * 8;
        const p = pop(frame, fps, at, 10);
        return (
          <div key={i} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 * u,
            transform: `scale(${p}) rotate(${(1 - p) * -12}deg)`, opacity: Math.min(1, p * 2)}}>
            {it.over ? <div style={{fontSize: 26 * u, fontWeight: 700, color: C.dim, background: 'rgba(12,12,16,0.8)',
              padding: `${4 * u}px ${14 * u}px`, borderRadius: 10 * u}}>{it.over}</div> : null}
            {/* the tile hugs the logo: most are wide wordmarks, and a square
                tile shrinks them to a smudge */}
            <div style={{height: tile * 0.62, padding: `0 ${tile * 0.16}px`, borderRadius: 34 * u, background: C.white, display: 'flex',
              alignItems: 'center', justifyContent: 'center', boxShadow: `0 ${18 * u}px ${50 * u}px rgba(0,0,0,0.45)`}}>
              <Img src={staticFile(it.file)} style={{height: tile * 0.4, maxWidth: tile * 2.6, objectFit: 'contain'}} />
            </div>
            {it.label ? <div style={{fontSize: 36 * u, fontWeight: 900, background: accent, color: C.ink,
              padding: `${6 * u}px ${18 * u}px`, borderRadius: 12 * u}}>{it.label}</div> : null}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
