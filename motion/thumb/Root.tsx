import React from 'react';
import {Composition, CalculateMetadataFunction} from 'remotion';
import {Thumbnail} from './Thumbnail';

// A separate entry from src/, so a thumbnail change never invalidates the
// cached motion-graphics clips (tools/motion.py hashes src/).
const meta: CalculateMetadataFunction<any> = ({props}) => {
  const p = props as {_w?: number; _h?: number};
  return {width: p._w ?? 1920, height: p._h ?? 1080, fps: 30, durationInFrames: 1};
};

export const ThumbRoot: React.FC = () => (
  <Composition id="Thumbnail" component={Thumbnail} defaultProps={{layers: []}} calculateMetadata={meta}
    width={1920} height={1080} fps={30} durationInFrames={1} />
);
