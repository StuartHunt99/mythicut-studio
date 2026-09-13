// Candidate evidence only. Completeness and passage-level omissions need review.
export const matchingTokens = text => text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
export function matchSentences(sentences, words) {
  const tokens = words.flatMap(word => matchingTokens(word.text).map(text => ({ text, word })));
  return sentences.map(sentence => {
    const target = matchingTokens(sentence.text);
    if (!target.length) return { sentenceId: sentence.id, candidates: [], suggestedCandidateId: null, needsReview: true };
    let previous = new Uint32Array(tokens.length + 1);
    let starts = Uint32Array.from({ length: tokens.length + 1 }, (_, i) => i);
    for (let i = 1; i <= target.length; i++) {
      const row = new Uint32Array(tokens.length + 1); row[0] = i;
      const nextStarts = new Uint32Array(tokens.length + 1);
      for (let j = 1; j <= tokens.length; j++) {
        const substitution = previous[j - 1] + (target[i - 1] === tokens[j - 1].text ? 0 : 1);
        const deletion = previous[j] + 1;
        const insertion = row[j - 1] + 1;
        row[j] = Math.min(substitution, deletion, insertion);
        nextStarts[j] = row[j] === substitution ? starts[j - 1] : row[j] === deletion ? starts[j] : nextStarts[j - 1];
      }
      previous = row; starts = nextStarts;
    }
    const possibilities = [];
    for (let end = 1; end <= tokens.length; end++) {
      const start = starts[end]; const score = 1 - previous[end] / target.length;
      if (score < .75 || end - start < Math.ceil(target.length * .65)) continue;
      const span = tokens.slice(start, end);
      // Unverified file boundaries cannot establish a single complete take.
      if (span.some(t => t.word.mediaId !== span[0].word.mediaId)) continue;
      possibilities.push({ start, end, score, mediaId: span[0].word.mediaId, wordIds: [...new Set(span.map(t => t.word.id))], startMs: span[0].word.startMs, endMs: span.at(-1).word.endMs, text: span.map(t => t.text).join(' '), timingValid: span.every(t => t.word.valid) });
    }
    const candidates = [];
    for (const p of possibilities.sort((a, b) => b.score - a.score || (b.end - b.start) - (a.end - a.start))) {
      if (!candidates.some(c => c.start < p.end && p.start < c.end)) candidates.push(p);
    }
    candidates.sort((a, b) => a.start - b.start);
    const identified = candidates.map((c, i) => ({ id: `${sentence.id}-c${i + 1}`, ...c }));
    // Chronology is review context. A text score cannot establish whether a
    // later attempt finished, so do not make an editorial recommendation here.
    return { sentenceId: sentence.id, text: sentence.text, candidates: identified, suggestedCandidateId: null, latestCandidateId: identified.at(-1)?.id ?? null, needsReview: true, reason: identified.length ? 'Candidate evidence only: confirm completeness, omissions, and unrecognized restarts before editing.' : 'No candidate found. Possible omission or transcription disagreement; do not reconstruct speech.' };
  });
}
