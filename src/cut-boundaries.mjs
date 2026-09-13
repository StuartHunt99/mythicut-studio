import { outwardFrames, frameRate } from './timeline.mjs';

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
  const startMs = frames.inFrame * rate.denominator * 1000 / rate.numerator;
  const endMs = frames.outFrame * rate.denominator * 1000 / rate.numerator;
  if (endMs > sourceDurationMs + 0.000001 || (previous && startMs < previous.endMs - 0.000001) || (next && endMs > next.startMs + 0.000001)) throw new Error('Frame rounding would include neighboring speech; boundary needs review');
  return { ...frames, speechStartMs: first.startMs, speechEndMs: last.endMs, leadingPaddingMs: first.startMs - startMs, trailingPaddingMs: endMs - last.endMs };
}
