import React from 'react';
import {AbsoluteFill, Easing, interpolate} from 'remotion';
import {Backdrop, C, Common, Panel, base, pop, textShadow, useInOut, useLayout, verticalCenter} from '../theme';

/** A number being quoted, counting up to its value: "$100,000 / month". */
export type BigNumberProps = Common & {
  value: number;
  from?: number;
  prefix?: string;
  suffix?: string;
  label?: string;
  decimals?: number;
  countSeconds?: number;
  position?: 'center' | 'top' | 'left' | 'right';
};

const fmt = (n: number, d: number) =>
  n.toLocaleString('en-US', {minimumFractionDigits: d, maximumFractionDigits: d});

export const BigNumber: React.FC<BigNumberProps> = ({
  value, from = 0, prefix = '', suffix = '', label, decimals = 0, countSeconds = 1.1,
  position = 'center', bg = 'none', accent = C.accent,
}) => {
  const {u, fps, vertical} = useLayout();
  const {frame, enter, exit} = useInOut();
  const t = interpolate(frame, [3, 3 + countSeconds * fps], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic),
  });
  const n = from + (value - from) * t;
  const done = pop(frame, fps, 3 + countSeconds * fps, 8);
  const digits = `${prefix}${fmt(n, decimals)}`;
  // a full-frame card has the whole frame to itself; an overlay panel does not
  const size = Math.min(bg === 'none' ? 210 : 300, (bg === 'none' ? 1500 : 2100) / Math.max(5, digits.length + suffix.length * 0.5)) * u * (vertical ? 0.95 : 1);

  const body = (
    <div style={{textAlign: 'center', transform: `scale(${0.7 + 0.3 * enter + 0.04 * Math.sin(done * Math.PI)})`}}>
      <div style={{fontSize: size, fontWeight: 900, letterSpacing: -3 * u, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
        color: bg === 'accent' ? C.ink : C.white, textShadow: bg === 'none' ? textShadow(u) : undefined}}>
        {digits}
        <span style={{color: bg === 'accent' ? C.ink : accent, fontSize: size * 0.5}}>{suffix}</span>
      </div>
      {label ? (
        <div style={{fontSize: 44 * u, fontWeight: 700, marginTop: 14 * u, letterSpacing: 4 * u, textTransform: 'uppercase',
          color: bg === 'accent' ? 'rgba(0,0,0,0.7)' : C.dim, opacity: pop(frame, fps, 10)}}>
          {label}
        </div>
      ) : null}
    </div>
  );

  const place: React.CSSProperties =
    position === 'top' ? {justifyContent: 'flex-start', paddingTop: (vertical ? 260 : 90) * u}
      : position === 'left' ? {alignItems: 'flex-start', paddingLeft: 110 * u}
        : position === 'right' ? {alignItems: 'flex-end', paddingRight: 110 * u} : {};

  return (
    <AbsoluteFill style={{...base, opacity: enter * (1 - exit)}}>
      <Backdrop kind={bg} accent={accent} />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', ...(vertical && position === 'center' ? verticalCenter(u) : {}), ...place}}>
        {bg === 'none' ? <Panel>{body}</Panel> : body}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
