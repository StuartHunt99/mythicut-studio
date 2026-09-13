import { outwardFrames, frameRate } from './timeline.mjs';

// Review uses the best available timestamps. Confidence is an advisory, not
// permission to alter or reject the user's text selection.
export function reviewedWordRange(options) {
  try {
    return {...paddedWordRange({...options,first:{...options.first,needsReview:false},last:{...options.last,needsReview:false}}),estimated:Boolean(options.first.needsReview||options.last.needsReview)};
  } catch {
    const {first,last,sourceDurationMs,fps,maximumPauseMs=500}=options;
    if(!Number.isFinite(first.startMs)||!Number.isFinite(last.endMs)||!Number.isFinite(sourceDurationMs)||sourceDurationMs<=0||!Number.isFinite(maximumPauseMs)||maximumPauseMs<0)throw new Error('Selection has no usable source timestamps');
    const rate=frameRate(fps),frameMs=1000*rate.denominator/rate.numerator;
    const total=Math.floor(sourceDurationMs/frameMs+1e-7);
    if(total<1)throw new Error('Source contains no complete video frames');
    const startMs=Math.max(0,Math.min(first.startMs,sourceDurationMs-frameMs));
    const endMs=Math.min(sourceDurationMs,Math.max(startMs+frameMs,last.endMs));
    const before=options.previous?.endMs,after=options.next?.startMs;
    const leading=Number.isFinite(before)?Math.min(maximumPauseMs/2,Math.max(0,startMs-before)):Math.min(maximumPauseMs/2,startMs);
    const trailing=Number.isFinite(after)?Math.min(maximumPauseMs/2,Math.max(0,after-endMs)):Math.min(maximumPauseMs/2,sourceDurationMs-endMs);
    const frames=outwardFrames((startMs-leading)/1000,(endMs+trailing)/1000,rate);
    return {inFrame:Math.min(total-1,frames.inFrame),outFrame:Math.min(total,Math.max(frames.inFrame+1,frames.outFrame)),estimated:true};
  }
}

// Called with aligned words; fails closed when the cut's acoustic evidence is weak.
export function paddedWordRange({ first, last, previous = null, next = null, sourceDurationMs, maximumPauseMs = 500, fps }) {
  for (const word of [first, last, previous, next].filter(Boolean)) {
    if (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs <= word.startMs || word.endMs > sourceDurationMs) throw new Error('Invalid word timing; alignment required');
  }
  if (first.needsReview || last.needsReview) throw new Error('Cut boundary requires review');
  if (first.startMs > last.startMs || !Number.isFinite(maximumPauseMs) || maximumPauseMs < 0) throw new Error('Invalid selected range');
  const before = Math.min(maximumPauseMs / 2, Math.max(0, first.startMs - (previous?.endMs ?? 0)));
  const after = Math.min(maximumPauseMs / 2, Math.max(0, (next?.startMs ?? sourceDurationMs) - last.endMs));
  const frames = outwardFrames((first.startMs - before) / 1000, (last.endMs + after) / 1000, fps);
  const rate = frameRate(fps);
  const toFrame = ms => ms * rate.numerator / (1000 * rate.denominator);
  const speech = outwardFrames(first.startMs / 1000, last.endMs / 1000, fps);
  // Trim padding inward to available clean frames. Only reject when even the
  // speech-preserving frame interval intersects rejected speech/source edges.
  frames.inFrame = Math.max(frames.inFrame, Math.ceil(toFrame(previous?.endMs ?? 0) - 1e-9));
  frames.outFrame = Math.min(frames.outFrame, Math.floor(toFrame(next?.startMs ?? sourceDurationMs) + 1e-9));
  if(frames.inFrame > speech.inFrame || frames.outFrame < speech.outFrame) throw new Error('Frame rounding would include neighboring speech; boundary needs review');
  const startMs = frames.inFrame * rate.denominator * 1000 / rate.numerator;
  const endMs = frames.outFrame * rate.denominator * 1000 / rate.numerator;
  if (endMs > sourceDurationMs + 0.000001 || (previous && startMs < previous.endMs - 0.000001) || (next && endMs > next.startMs + 0.000001)) throw new Error('Frame rounding would include neighboring speech; boundary needs review');
  return { ...frames, speechStartMs: first.startMs, speechEndMs: last.endMs, leadingPaddingMs: first.startMs - startMs, trailingPaddingMs: endMs - last.endMs };
}
