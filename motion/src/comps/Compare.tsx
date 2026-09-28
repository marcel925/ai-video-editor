import React from 'react';
import {AbsoluteFill, Easing, interpolate} from 'remotion';
import {Backdrop, C, Common, Panel, base, pop, useInOut, useLayout} from '../theme';

/** Before / after with two growing bars: "$0.50 -> $3.00 revenue per download". */
export type CompareProps = Common & {
  title?: string;
  before: {value: number; label: string; display?: string};
  after: {value: number; label: string; display?: string};
  badge?: string; // e.g. "6x"
  afterAt?: number; // seconds: when the second bar starts growing
};

export const Compare: React.FC<CompareProps> = ({title, before, after, badge, afterAt = 1.0, bg = 'dark', accent = C.accent}) => {
  const {u, fps, vertical} = useLayout();
  const {frame, enter, exit} = useInOut();
  const max = Math.max(before.value, after.value);
  const maxH = (vertical ? 820 : 560) * u;
  const grow = (delay: number) =>
    interpolate(frame, [delay, delay + 0.8 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const g1 = grow(4);
  const g2 = grow(afterAt * fps);
  const badgeP = pop(frame, fps, afterAt * fps + 0.8 * fps, 9);

  const Bar = ({v, g, label, display, hot}: {v: number; g: number; label: string; display?: string; hot: boolean}) => (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', width: 300 * u, height: maxH + 180 * u}}>
      <div style={{fontSize: 76 * u, fontWeight: 900, marginBottom: 14 * u, opacity: g, color: hot ? accent : C.white,
        fontVariantNumeric: 'tabular-nums'}}>
        {display ?? v.toFixed(2)}
      </div>
      <div style={{width: 220 * u, height: Math.max(8 * u, (v / max) * maxH * g), borderRadius: `${18 * u}px ${18 * u}px 0 0`,
        background: hot ? accent : 'rgba(255,255,255,0.28)', boxShadow: hot ? `0 0 ${60 * u}px ${accent}66` : undefined}} />
      <div style={{fontSize: 34 * u, fontWeight: 700, color: C.dim, marginTop: 18 * u, textAlign: 'center', height: 90 * u}}>{label}</div>
    </div>
  );

  const body = (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      {title ? <div style={{fontSize: 48 * u, fontWeight: 800, letterSpacing: 5 * u, textTransform: 'uppercase', marginBottom: 20 * u}}>{title}</div> : null}
      <div style={{display: 'flex', gap: 90 * u, alignItems: 'flex-end', position: 'relative'}}>
        <Bar v={before.value} g={g1} label={before.label} display={before.display} hot={false} />
        <Bar v={after.value} g={g2} label={after.label} display={after.display} hot />
        {badge ? (
          <div style={{position: 'absolute', left: '50%', top: '42%', transform: `translate(-50%, -50%) scale(${badgeP}) rotate(-8deg)`,
            background: C.red, color: C.white, fontWeight: 900, fontSize: 64 * u, padding: `${8 * u}px ${26 * u}px`, borderRadius: 18 * u}}>
            {badge}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <AbsoluteFill style={{...base, opacity: 1 - exit}}>
      <Backdrop kind={bg} accent={accent} />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', transform: `scale(${0.92 + 0.08 * enter})`}}>
        {bg === 'none' ? <Panel>{body}</Panel> : body}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
