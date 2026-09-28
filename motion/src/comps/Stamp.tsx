import React from 'react';
import {AbsoluteFill} from 'remotion';
import {C, Common, base, pop, useInOut, useLayout} from '../theme';

/** One word slammed onto the frame like a rubber stamp - for the punchline,
 * the admission, the verdict: "WRONG", "6x", "NOPE". */
export type StampProps = Common & {
  text: string;
  color?: string;
  rotate?: number;
  position?: [number, number]; // fractions of the frame
  size?: number;
};

export const Stamp: React.FC<StampProps> = ({text, color = C.red, rotate = -8, position = [0.5, 0.45], size = 150}) => {
  const {u, fps} = useLayout();
  const {frame, exit} = useInOut(0, 6);
  const p = pop(frame, fps, 0, 9);
  return (
    <AbsoluteFill style={{...base, opacity: 1 - exit}}>
      <div style={{position: 'absolute', left: `${position[0] * 100}%`, top: `${position[1] * 100}%`,
        transform: `translate(-50%, -50%) rotate(${rotate}deg) scale(${2.2 - 1.2 * p})`, opacity: Math.min(1, p * 3)}}>
        <div style={{fontSize: size * u, fontWeight: 900, color, border: `${10 * u}px solid ${color}`, borderRadius: 24 * u,
          padding: `${4 * u}px ${34 * u}px`, letterSpacing: 4 * u, background: 'rgba(255,255,255,0.92)', whiteSpace: 'nowrap',
          boxShadow: `0 ${16 * u}px ${50 * u}px rgba(0,0,0,0.4)`}}>
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
