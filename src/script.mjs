// Offsets refer to the original JavaScript string (UTF-16), including its BOM/CRLF.
export function parseScript(original) {
  const annotations = [];
  let opening = null;
  const masked = original.split('');
  for (let i = 0; i < original.length; i++) {
    if (original[i] === '[') {
      if (opening !== null) throw new Error(`Nested bracket at character ${i}`);
      opening = i;
    } else if (original[i] === ']') {
      if (opening === null) throw new Error(`Unmatched closing bracket at character ${i}`);
      annotations.push({ start: opening, end: i + 1, text: original.slice(opening, i + 1) });
      opening = null;
    }
    if (opening !== null || original[i] === ']') masked[i] = /[\r\n]/.test(original[i]) ? original[i] : ' ';
  }
  if (opening !== null) throw new Error(`Unclosed bracket at character ${opening}`);
  const spoken = masked.join('');
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const sentences = [];
  let paragraph = 0;
  for (const line of spoken.matchAll(/[^\r\n]+/g)) {
    if (!line[0].trim()) continue;
    const paragraphId = `p${++paragraph}`;
    for (const segment of segmenter.segment(line[0])) {
      const left = segment.segment.search(/\S/);
      if (left < 0) continue;
      const start = line.index + segment.index + left;
      const end = line.index + segment.index + segment.segment.trimEnd().length;
      const previous = sentences.at(-1);
      if (previous?.paragraphId === paragraphId && /(?:\b(?:[A-Z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|Prof|St)\.)\s*$/.test(previous.text)) {
        previous.end = end;
        previous.text = spoken.slice(previous.start, end).replace(/\s+/g, ' ');
      } else sentences.push({ id: `s${sentences.length + 1}`, paragraphId, start, end, text: spoken.slice(start, end).replace(/\s+/g, ' ') });
    }
  }
  return { schemaVersion: 1, original, annotations, sentences };
}
