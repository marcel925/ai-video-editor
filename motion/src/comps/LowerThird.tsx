import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {C, Common, base, useInOut, useLayout} from '../theme';

/** A term being defined, a name, a product: "LLM - Large Language Model". */
export type LowerThirdProps = Common & {
  title: string;
  subtitle?: string;
  side?: 'left' | 'right';
};

export const LowerThird: React.FC<LowerThirdProps> = ({title, subtitle, side = 'left', accent = C.accent}) => {
  const {u, vertical} = useLayout();
  const {frame, enter, exit} = useInOut();
  const wipe = interpolate(frame, [0, 12], [0, 100], {extrapolateRight: 'clamp'});
  const out = 1 - exit;
  return (
    <AbsoluteFill style={{...base, justifyContent: 'flex-end', alignItems: side === 'left' ? 'flex-start' : 'flex-end',
      padding: vertical ? `0 ${60 * u}px ${760 * u}px` : `0 ${110 * u}px ${120 * u}px`}}>
      <div style={{display: 'flex', alignItems: 'stretch', opacity: out, transform: `translateY(${exit * 30 * u}px)`}}>
        <div style={{width: 14 * u, background: accent, borderRadius: 4 * u, transform: `scaleY(${enter})`}} />
        <div style={{clipPath: `inset(0 ${100 - wipe}% 0 0)`, background: 'rgba(12,12,16,0.86)', padding: `${22 * u}px ${36 * u}px`,
          borderRadius: `0 ${16 * u}px ${16 * u}px 0`}}>
          <div style={{fontSize: 58 * u, fontWeight: 900, letterSpacing: -1 * u}}>{title}</div>
          {subtitle ? <div style={{fontSize: 36 * u, fontWeight: 600, color: accent, marginTop: 6 * u}}>{subtitle}</div> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
