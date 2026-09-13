// M0 subset: matching constant-frame-rate sources. VFR requires source-PTS mapping.
export function frameRate(value) {
  const rate = typeof value === 'number' ? { numerator: value, denominator: 1 } : value;
  if (!rate || ![rate.numerator, rate.denominator].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid frame rate');
  return rate;
}

export function outwardFrames(startSeconds, endSeconds, fps) {
  const rate = frameRate(fps);
  if (![startSeconds, endSeconds].every(Number.isFinite) || startSeconds < 0 || endSeconds <= startSeconds) throw new Error('Invalid interval');
  const snap = value => Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value;
  return { inFrame: Math.floor(snap(startSeconds * rate.numerator / rate.denominator)), outFrame: Math.ceil(snap(endSeconds * rate.numerator / rate.denominator)) };
}

export function compileTimeline(clips, sources, fps = 30) {
  const rate = frameRate(fps);
  if (!clips.length) throw new Error('Invalid timeline');
  let cursor = 0;
  const intervals = clips.map(clip => {
    const source = sources[clip.sourceId];
    const sourceRate = source && frameRate(source.fps);
    if (!source || BigInt(sourceRate.numerator) * BigInt(rate.denominator) !== BigInt(rate.numerator) * BigInt(sourceRate.denominator) || !Number.isSafeInteger(source.frames) ||
        !Number.isSafeInteger(clip.inFrame) || !Number.isSafeInteger(clip.outFrame) ||
        clip.inFrame < 0 || clip.outFrame > source.frames || clip.outFrame <= clip.inFrame) {
      throw new Error('Invalid source interval');
    }
    const interval = { ...clip, start: cursor, end: cursor + clip.outFrame - clip.inFrame };
    cursor = interval.end;
    if (!Number.isSafeInteger(cursor)) throw new Error('Timeline exceeds safe frame range');
    return interval;
  });
  return { fps, duration: cursor, intervals };
}
