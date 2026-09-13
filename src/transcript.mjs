export function transcriptWords(source, mediaId = "source") {
const words = [];
const normalize = value => value.normalize('NFKC').replace(/[’‘]/g, "'").trim();
const isSpecial = token => token.id >= 50256 || /^\s*$/.test(token.text);

for (const [segmentIndex, segment] of (source.transcription ?? []).entries()) {
  let current = null;
  for (const token of segment.tokens ?? []) {
    if (isSpecial(token)) continue;
    const text = normalize(token.text);
    if (!text) continue;
    // Whisper's leading whitespace marks the start of a new decoded word.
    // Punctuation-only continuations stay attached to the preceding word.
    if (!current || /^\s/.test(token.text)) {
      current = {
        id: `${mediaId}-w${words.length + 1}`,
        mediaId,
        text,
        startMs: token.offsets.from,
        endMs: token.offsets.to,
        segmentIndex,
        probability: token.p,
        dtwAnchorMs: token.t_dtw >= 0 ? token.t_dtw * 10 : null
      };
      words.push(current);
    } else {
      current.text += text;
      current.endMs = Math.max(current.endMs, token.offsets.to);
      if (current.dtwAnchorMs === null && token.t_dtw >= 0) current.dtwAnchorMs = token.t_dtw * 10;
    }
  }
}

for (const word of words) word.valid = Number.isFinite(word.startMs) && Number.isFinite(word.endMs) && word.startMs >= 0 && word.endMs > word.startMs;
return words;
}

export function normalizeAcousticWords(words, mediaId = 'source') {
  const result = [];
  for (const word of words) {
    const current = { ...word, mediaId: word.mediaId ?? mediaId };
    const previous = result.at(-1);
    if (previous && previous.text.toUpperCase() === 'TO' && current.text.toUpperCase() === 'DAY' && current.startMs - previous.endMs < 350) {
      previous.text = 'TODAY'; previous.endMs = current.endMs; previous.acousticConfidence = Math.min(previous.acousticConfidence ?? 1, current.acousticConfidence ?? 1); continue;
    }
    result.push(current);
  }
  return result.map((word, index) => ({ ...word, id: word.id ?? `${mediaId}-acoustic-${index + 1}`, valid: word.valid ?? word.endMs > word.startMs }));
}
