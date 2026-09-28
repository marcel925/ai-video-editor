import React from 'react';
import {Composition, CalculateMetadataFunction} from 'remotion';
import {TitleCard} from './comps/TitleCard';
import {BigNumber} from './comps/BigNumber';
import {ListReveal} from './comps/ListReveal';
import {KineticText} from './comps/KineticText';
import {LowerThird} from './comps/LowerThird';
import {Compare} from './comps/Compare';
import {LogoPop} from './comps/LogoPop';
import {ScreenshotCard} from './comps/ScreenshotCard';
import {EndCard} from './comps/EndCard';
import {Stamp} from './comps/Stamp';

// The samples document each component's props (paste one into the studio's
// props panel). They are deliberately NOT defaultProps: Remotion merges
// defaultProps into every render, so a sample's number: '02' turned up on a
// card that never asked for one.
// render.mjs passes the frame size and length in with the props, so one
// registered composition renders 16:9 or 9:16 at whatever length the edit needs.
type Frame = {_w?: number; _h?: number; _fps?: number; _dur?: number};
const meta: CalculateMetadataFunction<any> = ({props}) => {
  const p = props as Frame;
  const fps = p._fps ?? 30;
  return {width: p._w ?? 1920, height: p._h ?? 1080, fps, durationInFrames: Math.max(1, Math.round((p._dur ?? 3) * fps))};
};

const COMPS: [string, React.FC<any>, Record<string, unknown>][] = [
  ['TitleCard', TitleCard, {kicker: 'MISTAKE #2', title: 'Onboarding', number: '02'}],
  ['BigNumber', BigNumber, {prefix: '$', value: 100000, suffix: '/mo', label: 'at its peak'}],
  ['ListReveal', ListReveal, {title: 'TOP 5 MISTAKES', items: ['Speed', 'Onboarding', 'Marketing > Code', 'Product quality', 'Analytics & A/B'], active: 1}],
  ['KineticText', KineticText, {lines: ['No *users*', 'No *code*', 'No *revenue*']}],
  ['LowerThird', LowerThird, {title: 'LLM', subtitle: 'Large Language Model'}],
  ['Compare', Compare, {title: 'Revenue per download', before: {value: 0.5, label: 'weak onboarding', display: '$0.50'}, after: {value: 3, label: 'strong onboarding', display: '$3.00'}, badge: '6×'}],
  ['LogoPop', LogoPop, {items: []}],
  ['ScreenshotCard', ScreenshotCard, {file: ''}],
  ['EndCard', EndCard, {title: '5 things I did right'}],
  ['Stamp', Stamp, {text: 'WRONG'}],
];

export const Root: React.FC = () => (
  <>
    {COMPS.map(([id, component]) => (
      <Composition key={id} id={id} component={component} defaultProps={{}}
        calculateMetadata={meta} width={1920} height={1080} fps={30} durationInFrames={90} />
    ))}
  </>
);
