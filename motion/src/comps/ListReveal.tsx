import React from 'react';
import {AbsoluteFill} from 'remotion';
import {Backdrop, C, Common, Panel, base, pop, useInOut, useLayout} from '../theme';

/** The running list for an enumerated video - "top five mistakes" - with the
 * current item lit, the finished ones ticked and the rest still pending.
 * Sits in the empty side of the frame; `side` picks which. */
export type ListRevealProps = Common & {
  title?: string;
  items: string[];
  active?: number; // 0-based; -1 = just the overview
  side?: 'left' | 'right' | 'top' | 'center';
  times?: number[]; // seconds at which each item appears (overview reveal)
};

export const ListReveal: React.FC<ListRevealProps> = ({title, items, active = -1, side = 'left', times, bg = 'none', accent = C.accent}) => {
  const {u, fps, vertical, width} = useLayout();
  const {frame, enter, exit} = useInOut();
  const fromX = side === 'right' ? 1 : side === 'left' ? -1 : 0;
  const panelW = vertical ? width - 120 * u : 760 * u;

  return (
    <AbsoluteFill style={{...base, opacity: 1 - exit}}>
      <Backdrop kind={bg} accent={accent} />
      <AbsoluteFill
        style={{
          justifyContent: side === 'top' ? 'flex-start' : 'center',
          alignItems: side === 'left' ? 'flex-start' : side === 'right' ? 'flex-end' : 'center',
          padding: vertical ? `${230 * u}px ${60 * u}px` : `0 ${90 * u}px`,
        }}
      >
        <Panel style={{width: panelW, transform: `translateX(${(1 - enter) * fromX * 120 * u}px) translateY(${fromX === 0 ? (1 - enter) * 60 * u : 0}px)`, opacity: enter}}>
          {title ? (
            <div style={{fontSize: 34 * u, fontWeight: 800, letterSpacing: 6 * u, color: accent, marginBottom: 14 * u}}>{title}</div>
          ) : null}
          {items.map((item, i) => {
            const appearAt = times?.[i] !== undefined ? times[i] * fps : 4 + i * 3;
            const p = pop(frame, fps, appearAt, 14);
            const isActive = i === active;
            const isDone = active >= 0 && i < active;
            const lit = pop(frame, fps, appearAt + 8, 10);
            return (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 22 * u,
                  margin: `${10 * u}px ${-18 * u}px`, padding: `${12 * u}px ${18 * u}px`, borderRadius: 16 * u,
                  background: isActive ? `rgba(255,229,0,${0.95 * lit})` : 'transparent',
                  opacity: p * (isActive || active < 0 ? 1 : isDone ? 0.75 : 0.4),
                  transform: `translateX(${(1 - p) * -40 * u}px) scale(${isActive ? 1 + 0.03 * lit : 1})`,
                  transformOrigin: 'left center',
                }}
              >
                <div style={{width: 58 * u, height: 58 * u, borderRadius: 29 * u, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30 * u, fontWeight: 900,
                  background: isActive ? C.ink : isDone ? C.green : 'rgba(255,255,255,0.12)',
                  color: isActive ? accent : C.white}}>
                  {isDone ? '✓' : i + 1}
                </div>
                <div style={{fontSize: 44 * u, fontWeight: 800, color: isActive ? C.ink : C.white, letterSpacing: -0.5 * u,
                  textDecoration: 'none'}}>
                  {item}
                </div>
              </div>
            );
          })}
        </Panel>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
