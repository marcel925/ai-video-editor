import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {Backdrop, C, Common, base, pop, textShadow, useInOut, useLayout} from '../theme';

/** Section break: "MISTAKE #2" over "ONBOARDING". Full frame by default - it
 * is a cutaway, the speaker comes back after it. */
export type TitleCardProps = Common & {
  kicker?: string;
  title: string;
  subtitle?: string;
  number?: string; // giant faint numeral behind the title, e.g. "02"
};

export const TitleCard: React.FC<TitleCardProps> = ({kicker, title, subtitle, number, bg = 'dark', accent = C.accent}) => {
  const {u, fps, vertical, width} = useLayout();
  const {frame, enter, exit} = useInOut();
  const onAccent = bg === 'accent';
  const ink = onAccent || bg === 'light' ? C.ink : C.white;
  const words = title.split(' ');
    // Black-weight Inter runs ~0.62em per glyph; size the longest word to fit
  const longest = Math.max(...words.map((w) => w.length));
  const size = Math.min(vertical ? 200 : 170, (vertical ? 1450 : 2500) / Math.max(4, longest)) * u;
  const bar = interpolate(frame, [6, 20], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{...base, opacity: 1 - exit}}>
      <Backdrop kind={bg} accent={accent} />
      {number ? (
        <div
          style={{
            position: 'absolute',
            right: vertical ? undefined : 90 * u,
            top: vertical ? 330 * u : undefined,
            width: vertical ? '100%' : undefined,
            textAlign: 'center',
            bottom: vertical ? undefined : -40 * u,
            fontSize: (vertical ? 520 : 620) * u,
            fontWeight: 900,
            color: 'transparent',
            WebkitTextStroke: `${3 * u}px ${onAccent ? 'rgba(0,0,0,0.18)' : accent + '55'}`,
            transform: `translateY(${(1 - enter) * 80 * u}px)`,
            opacity: enter,
            lineHeight: 1,
          }}
        >
          {number}
        </div>
      ) : null}
      <AbsoluteFill style={{justifyContent: 'center', alignItems: vertical ? 'center' : 'flex-start',
        // vertical: sit above centre, clear of the burned-in captions at 30%
        padding: vertical ? `0 ${80 * u}px ${420 * u}px` : `0 ${160 * u}px`, transform: `translateY(${-exit * 40 * u}px)`}}>
        {kicker ? (
          <div
            style={{
              fontSize: 46 * u,
              fontWeight: 800,
              letterSpacing: 8 * u,
              color: onAccent ? C.ink : accent,
              opacity: enter,
              transform: `translateX(${(1 - enter) * -60 * u}px)`,
              marginBottom: 18 * u,
              textShadow: bg === 'none' ? textShadow(u) : undefined,
            }}
          >
            {kicker}
          </div>
        ) : null}
        <div style={{display: 'flex', flexWrap: 'wrap', gap: `0 ${28 * u}px`, justifyContent: vertical ? 'center' : 'flex-start',
          maxWidth: width - 240 * u}}>
          {words.map((w, i) => {
            const p = pop(frame, fps, 3 + i * 3, 13);
            return (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  fontSize: size,
                  fontWeight: 900,
                  lineHeight: 1.02,
                  color: ink,
                  letterSpacing: -2 * u,
                  transform: `translateY(${(1 - p) * 90 * u}px) scale(${0.9 + 0.1 * p})`,
                  opacity: Math.min(1, p * 1.4),
                  textShadow: bg === 'none' ? textShadow(u) : undefined,
                }}
              >
                {w}
              </span>
            );
          })}
        </div>
        <div style={{height: 12 * u, width: 260 * u * bar, background: onAccent ? C.ink : accent, borderRadius: 6 * u, marginTop: 26 * u}} />
        {subtitle ? (
          <div style={{fontSize: 44 * u, fontWeight: 500, color: onAccent ? 'rgba(0,0,0,0.7)' : C.dim, marginTop: 26 * u,
            opacity: pop(frame, fps, 12), textAlign: vertical ? 'center' : 'left'}}>
            {subtitle}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
