import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {Backdrop, C, Common, base, pop, textShadow, useInOut, useLayout, verticalCenter} from '../theme';

/** "Next video: ..." plus a subscribe button that gets clicked. */
export type EndCardProps = Common & {
  kicker?: string;
  title: string;
  cta?: string; // button text; omit for no button
  position?: 'center' | 'top';
};

export const EndCard: React.FC<EndCardProps> = ({kicker = 'NEXT VIDEO', title, cta = 'SUBSCRIBE', position = 'center', bg = 'none', accent = C.accent}) => {
  const {u, fps, vertical} = useLayout();
  const {frame, enter, exit} = useInOut();
  const btn = pop(frame, fps, 10, 11);
  // a cursor arrives, the button depresses and turns grey: subscribed
  const clickAt = 1.3 * fps;
  const cursor = interpolate(frame, [clickAt - 14, clickAt], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const pressed = frame >= clickAt;
  const press = pressed ? 1 - 0.08 * Math.max(0, 1 - (frame - clickAt) / 5) : 1;

  return (
    <AbsoluteFill style={{...base, opacity: 1 - exit}}>
      <Backdrop kind={bg} accent={accent} />
      <AbsoluteFill style={{justifyContent: position === 'top' ? 'flex-start' : 'center', alignItems: 'center',
        paddingTop: position === 'top' ? (vertical ? 230 : 90) * u : 0, ...(vertical && position === 'center' ? verticalCenter(u) : {}), gap: 26 * u}}>
        <div style={{fontSize: (vertical ? 54 : 40) * u, fontWeight: 800, letterSpacing: 8 * u, color: accent, opacity: enter, textShadow: textShadow(u)}}>{kicker}</div>
        <div style={{fontSize: (vertical ? 92 : 104) * u, fontWeight: 900, textAlign: 'center', maxWidth: (vertical ? 960 : 1500) * u,
          lineHeight: 1.05, letterSpacing: -2 * u, transform: `scale(${0.8 + 0.2 * enter})`, opacity: enter, textShadow: textShadow(u)}}>
          {title}
        </div>
        {cta ? (
          <div style={{position: 'relative', marginTop: 20 * u, transform: `scale(${btn * press})`}}>
            <div style={{background: pressed ? '#3A3A3C' : '#FF0033', color: C.white, fontWeight: 900, fontSize: 46 * u,
              padding: `${20 * u}px ${48 * u}px`, borderRadius: 60 * u, letterSpacing: 2 * u,
              boxShadow: `0 ${12 * u}px ${40 * u}px rgba(0,0,0,0.4)`}}>
              {pressed ? 'SUBSCRIBED ✓' : cta}
            </div>
            <svg width={70 * u} height={70 * u} viewBox="0 0 24 24"
              style={{position: 'absolute', right: -20 * u + cursor * -200 * u, bottom: -40 * u + cursor * -160 * u,
                opacity: frame > clickAt + 14 ? 0 : Math.min(1, (frame - (clickAt - 16)) / 4)}}>
              <path d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.5 L12 14 L19 14 Z" fill="white" stroke="black" strokeWidth="1.3" />
            </svg>
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
