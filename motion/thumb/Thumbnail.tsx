import React, {useLayoutEffect, useRef, useState} from 'react';
import {AbsoluteFill, Img, continueRender, delayRender, staticFile, useVideoConfig} from 'remotion';
import {loadFont as loadAnton} from '@remotion/google-fonts/Anton';
import {loadFont as loadMontserrat} from '@remotion/google-fonts/Montserrat';
import {C, fontFamily as inter} from '../src/theme';

/** A YouTube thumbnail, drawn as a stack of layers - bottom first - from
 * $P/build/thumbnails.json (tools/thumbnail.py renders it). Positions and
 * sizes are fractions of the frame, so one spec shape serves 16:9 and 9:16;
 * pixel sizes (text, outlines) are at a 1080 short edge and scale with it. */

const FONTS = {
  inter,
  anton: loadAnton('normal', {weights: ['400'], subsets: ['latin']}).fontFamily,
  montserrat: loadMontserrat('normal', {weights: ['800', '900'], subsets: ['latin']}).fontFamily,
};

type Box = {x?: number; y?: number; w?: number; h?: number; rotate?: number; opacity?: number};

export type Layer =
  // a frame, screenshot or logo; `fit: cover` crops to the box around `focus`
  | (Box & {type: 'image'; file: string; fit?: 'cover' | 'contain'; focus?: [number, number]; zoom?: number;
      radius?: number; border?: string; borderWidth?: number; shadow?: boolean;
      brightness?: number; saturate?: number; contrast?: number; blur?: number})
  // a cut-out speaker (thumbnail.py cutout): placed by its centre `x`, the
  // y of its bottom edge and its height, with a solid outline and a glow
  | {type: 'cutout'; file: string; x?: number; bottom?: number; h?: number; flip?: boolean;
      outline?: string | null; outlineWidth?: number; glow?: string | null; brightness?: number; saturate?: number}
  // a colour or CSS gradient: the backdrop, a panel, a divider, a darkening scrim
  | (Box & {type: 'rect'; color?: string; gradient?: string; radius?: number; border?: string; borderWidth?: number; shadow?: boolean})
  // words; *stars* mark the accent words
  | (Box & {type: 'text'; lines: string[]; size?: number; font?: keyof typeof FONTS; weight?: number;
      color?: string; accent?: string; align?: 'left' | 'center' | 'right'; stroke?: string | null;
      strokeWidth?: number; shadow?: boolean; box?: string | null; boxText?: string; uppercase?: boolean;
      lineHeight?: number; fit?: boolean})
  // a short label in a pill or a tilted sticker: "BEFORE", "$100K/mo", "6x"
  | (Box & {type: 'badge'; text: string; size?: number; color?: string; bg?: string; font?: keyof typeof FONTS;
      shape?: 'pill' | 'rect' | 'circle'})
  // a hand-drawn style arrow from one point to another, optionally curved
  | {type: 'arrow'; from: [number, number]; to: [number, number]; color?: string; width?: number; curve?: number; opacity?: number}
  // a ring around something worth pointing at
  | {type: 'circle'; x: number; y: number; r: number; color?: string; width?: number; opacity?: number};

export type ThumbnailProps = {layers: Layer[]; background?: string};

const useFrame = () => {
  const {width, height} = useVideoConfig();
  return {W: width, H: height, u: Math.min(width, height) / 1080};
};

const boxStyle = (b: Box, W: number, H: number): React.CSSProperties => ({
  position: 'absolute',
  left: (b.x ?? 0) * W,
  top: (b.y ?? 0) * H,
  width: (b.w ?? 1) * W,
  height: b.h === undefined ? undefined : b.h * H,
  transform: b.rotate ? `rotate(${b.rotate}deg)` : undefined,
  opacity: b.opacity,
});

const filters = (l: {brightness?: number; saturate?: number; contrast?: number; blur?: number}, u: number) =>
  [l.brightness !== undefined && `brightness(${l.brightness})`, l.saturate !== undefined && `saturate(${l.saturate})`,
    l.contrast !== undefined && `contrast(${l.contrast})`, l.blur ? `blur(${l.blur * u}px)` : false]
    .filter(Boolean).join(' ') || undefined;

/** A solid outline around a transparent PNG: its alpha dilated by `px`,
 * flooded with the colour, the image on top. One SVG filter - a stack of
 * CSS drop-shadows does the same but stalls headless Chrome for minutes. */
const OutlineDef: React.FC<{id: string; color: string; px: number}> = ({id, color, px}) => (
  <svg width={0} height={0} style={{position: 'absolute'}}>
    <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
      <feMorphology in="SourceAlpha" operator="dilate" radius={px} result="grown" />
      <feFlood floodColor={color} />
      <feComposite in2="grown" operator="in" result="edge" />
      <feMerge><feMergeNode in="edge" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </svg>
);

const Accent: React.FC<{text: string; accent: string; box?: string | null; boxText?: string}> = ({text, accent, box, boxText}) => (
  <>
    {text.split(/(\*[^*]+\*)/g).filter(Boolean).map((part, i) =>
      part.startsWith('*') ? (
        <span key={i} style={box ? {color: boxText ?? C.ink, background: accent, padding: '0 0.12em', borderRadius: '0.08em',
          boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone'} : {color: accent}}>{part.slice(1, -1)}</span>
      ) : (
        <span key={i}>{part}</span>
      ),
    )}
  </>
);

const TextLayer: React.FC<{l: Extract<Layer, {type: 'text'}>}> = ({l}) => {
  const {W, H, u} = useFrame();
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [handle] = useState(() => (l.fit === false ? null : delayRender('fit text')));
  // shrink a line that runs wider than its box rather than let it wrap or clip
  useLayoutEffect(() => {
    if (handle === null) return;
    const el = ref.current;
    document.fonts.ready.then(() => {
      if (el) {
        const widest = Math.max(...Array.from(el.children).map((c) => (c as HTMLElement).scrollWidth));
        if (widest > el.clientWidth) setScale(el.clientWidth / widest);
      }
      continueRender(handle);
    });
  }, [handle]);
  const size = (l.size ?? 150) * u * scale;
  const stroke = l.stroke === undefined ? C.ink : l.stroke;
  const align = l.align ?? 'left';
  return (
    <div ref={ref} style={{...boxStyle(l, W, H), display: 'flex', flexDirection: 'column',
      alignItems: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'}}>
      {l.lines.map((line, i) => (
        <div key={i} style={{
          fontFamily: FONTS[l.font ?? 'inter'], fontWeight: l.weight ?? (l.font === 'anton' ? 400 : 900),
          fontSize: size, lineHeight: l.lineHeight ?? 1.02, letterSpacing: l.font === 'anton' ? 0 : -0.02 * size,
          color: l.color ?? C.white, textTransform: l.uppercase === false ? undefined : 'uppercase',
          whiteSpace: 'nowrap', textAlign: align,
          WebkitTextStroke: stroke ? `${(l.strokeWidth ?? 12) * u * scale}px ${stroke}` : undefined,
          paintOrder: 'stroke fill',
          textShadow: l.shadow === false ? undefined : `0 ${8 * u}px ${30 * u}px rgba(0,0,0,0.55)`,
        }}>
          <Accent text={line} accent={l.accent ?? C.accent} box={l.box} boxText={l.boxText} />
        </div>
      ))}
    </div>
  );
};

const Arrow: React.FC<{l: Extract<Layer, {type: 'arrow'}>}> = ({l}) => {
  const {W, H, u} = useFrame();
  const [x1, y1] = [l.from[0] * W, l.from[1] * H];
  const [x2, y2] = [l.to[0] * W, l.to[1] * H];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // control point off the midpoint, perpendicular, by curve * length
  const c = l.curve ?? 0.2;
  const cx = (x1 + x2) / 2 - (dy / len) * c * len, cy = (y1 + y2) / 2 + (dx / len) * c * len;
  const w = (l.width ?? 22) * u;
  const head = w * 2.6;
  const ang = Math.atan2(y2 - cy, x2 - cx);
  const pt = (a: number) => `${x2 - head * Math.cos(ang + a)},${y2 - head * Math.sin(ang + a)}`;
  const color = l.color ?? C.accent;
  const end = {x: x2 - Math.cos(ang) * head * 0.6, y: y2 - Math.sin(ang) * head * 0.6};
  return (
    <svg width={W} height={H} style={{position: 'absolute', inset: 0, opacity: l.opacity,
      filter: `drop-shadow(0 ${6 * u}px ${14 * u}px rgba(0,0,0,0.5))`}}>
      <path d={`M ${x1} ${y1} Q ${cx} ${cy} ${end.x} ${end.y}`} fill="none" stroke={C.ink} strokeWidth={w + 10 * u} strokeLinecap="round" />
      <polygon points={`${x2},${y2} ${pt(0.45)} ${pt(-0.45)}`} fill={color} stroke={C.ink} strokeWidth={5 * u} strokeLinejoin="round" />
      <path d={`M ${x1} ${y1} Q ${cx} ${cy} ${end.x} ${end.y}`} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
    </svg>
  );
};

const LayerView: React.FC<{l: Layer}> = ({l}) => {
  const {W, H, u} = useFrame();
  switch (l.type) {
    case 'rect':
      return <div style={{...boxStyle({h: 1, ...l}, W, H), background: l.gradient ?? l.color ?? C.ink,
        borderRadius: (l.radius ?? 0) * u, border: l.border ? `${(l.borderWidth ?? 8) * u}px solid ${l.border}` : undefined,
        boxShadow: l.shadow ? `0 ${20 * u}px ${60 * u}px rgba(0,0,0,0.5)` : undefined}} />;
    case 'image': {
      const [fx, fy] = l.focus ?? [0.5, 0.4];
      return (
        <div style={{...boxStyle({h: 1, ...l}, W, H), overflow: 'hidden', borderRadius: (l.radius ?? 0) * u,
          border: l.border ? `${(l.borderWidth ?? 8) * u}px solid ${l.border}` : undefined,
          boxShadow: l.shadow ? `0 ${24 * u}px ${70 * u}px rgba(0,0,0,0.55)` : undefined}}>
          <Img src={staticFile(l.file)} style={{width: '100%', height: '100%', objectFit: l.fit ?? 'cover',
            objectPosition: `${fx * 100}% ${fy * 100}%`, transform: l.zoom ? `scale(${l.zoom})` : undefined,
            transformOrigin: `${fx * 100}% ${fy * 100}%`, filter: filters(l, u)}} />
        </div>
      );
    }
    case 'cutout': {
      const h = (l.h ?? 0.95) * H;
      const outline = l.outline === undefined ? C.white : l.outline;
      const glow = l.glow === undefined ? 'rgba(0,0,0,0.6)' : l.glow;
      const id = `outline-${l.file.replace(/\W/g, '')}`;
      const filter = [outline ? `url(#${id})` : '', glow ? `drop-shadow(0 0 ${40 * u}px ${glow})` : '', filters(l, u) ?? '']
        .join(' ').trim();
      return (
        <div style={{position: 'absolute', left: (l.x ?? 0.5) * W, top: (l.bottom ?? 1) * H - h, height: h,
          transform: `translateX(-50%)${l.flip ? ' scaleX(-1)' : ''}`}}>
          {outline ? <OutlineDef id={id} color={outline} px={(l.outlineWidth ?? 10) * u} /> : null}
          <Img src={staticFile(l.file)} style={{height: h, display: 'block', filter: filter || undefined}} />
        </div>
      );
    }
    case 'text':
      return <TextLayer l={l} />;
    case 'badge': {
      const size = (l.size ?? 80) * u;
      const shape = l.shape ?? 'pill';
      return (
        <div style={{position: 'absolute', left: (l.x ?? 0) * W, top: (l.y ?? 0) * H, opacity: l.opacity,
          transform: `rotate(${l.rotate ?? 0}deg)`, background: l.bg ?? C.red, color: l.color ?? C.white,
          fontFamily: FONTS[l.font ?? 'inter'], fontWeight: l.font === 'anton' ? 400 : 900, fontSize: size,
          lineHeight: 1, padding: shape === 'circle' ? size * 0.55 : `${size * 0.18}px ${size * 0.38}px`,
          borderRadius: shape === 'rect' ? size * 0.14 : 9999, textTransform: 'uppercase', whiteSpace: 'nowrap',
          boxShadow: `0 ${10 * u}px ${30 * u}px rgba(0,0,0,0.45)`, border: `${5 * u}px solid ${C.ink}`}}>
          {l.text}
        </div>
      );
    }
    case 'arrow':
      return <Arrow l={l} />;
    case 'circle':
      return <div style={{position: 'absolute', left: (l.x - l.r) * W, top: l.y * H - l.r * W, width: 2 * l.r * W,
        height: 2 * l.r * W, borderRadius: '50%', border: `${(l.width ?? 16) * u}px solid ${l.color ?? C.red}`, opacity: l.opacity,
        boxShadow: `0 0 0 ${5 * u}px ${C.ink}, inset 0 0 0 ${5 * u}px ${C.ink}`}} />;
  }
};

export const Thumbnail: React.FC<ThumbnailProps> = ({layers, background = C.ink}) => (
  <AbsoluteFill style={{background, overflow: 'hidden'}}>
    {layers.map((l, i) => <LayerView key={i} l={l} />)}
  </AbsoluteFill>
);
