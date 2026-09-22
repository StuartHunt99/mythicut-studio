import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compileReview } from './review-timeline.mjs';
import { resolveReview } from './review.mjs';
import { compileTimeline } from './timeline.mjs';
import { timedWords } from './word-timing.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const spokenText = words => words.map(word => word.text).join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
const frameFloor = (ms, fps) => Math.floor(ms * fps.numerator / (1000 * fps.denominator) + 1e-9);
const frameCeil = (ms, fps) => Math.ceil(ms * fps.numerator / (1000 * fps.denominator) - 1e-9);

// The source milliseconds are never retimed. Only their placement in the
// frame-based XML sequence is derived from that same clip's in/start values.
function placeSourceWord(source, interval, fps) {
  if (!source || source.mediaId !== interval.sourceId || source.valid === false ||
      !Number.isFinite(source.startMs) || !Number.isFinite(source.endMs) || source.startMs < 0 || source.endMs <= source.startMs ||
      /\[[^\]]*\]/.test(source.text)) throw new Error(`Cannot lock unusable transcript word ${source?.id ?? 'unknown'}; review or remove it first`);
  const sourceStartFrame = Math.max(interval.inFrame, frameFloor(source.startMs, fps));
  const sourceEndFrame = Math.min(interval.outFrame, frameCeil(source.endMs, fps));
  if (sourceEndFrame <= sourceStartFrame) throw new Error(`Transcript word ${source.id} falls outside its exported clip`);
  return { sourceStartMs: source.startMs, sourceEndMs: source.endMs, sourceStartFrame, sourceEndFrame,
    startFrame: interval.start + sourceStartFrame - interval.inFrame,
    endFrame: interval.start + sourceEndFrame - interval.inFrame };
}

function passages(words, key, prefix) {
  const groups = [];
  for (const word of words) {
    const id = word[key] ?? `${prefix}-unmatched`;
    let group = groups.at(-1);
    if (!group || group.id !== id) { group = { id, wordIds: [], startFrame: word.startFrame, endFrame: word.endFrame, text: '' }; groups.push(group); }
    group.wordIds.push(word.id);
    group.endFrame = Math.max(group.endFrame, word.endFrame);
  }
  const byId = new Map(words.map(word => [word.id, word]));
  for (const group of groups) group.text = spokenText(group.wordIds.map(id => byId.get(id)));
  return groups;
}

export function buildEditHandoff(project, result) {
  const compiled = compileReview(project, result);
  const review = resolveReview(project.review, result);
  const sourceWords = new Map(timedWords(result).map(word => [word.id, word]));
  const sentences = new Map(project.script.sentences.map(sentence => [sentence.id, sentence]));
  const fps = compiled.timeline.fps;
  const words = [];
  for (const interval of compiled.timeline.intervals) {
    for (const id of interval.wordIds) {
      const source = sourceWords.get(id);
      const placement = placeSourceWord(source, interval, fps);
      const sentenceId = review.owners[id] ?? null;
      words.push({ id, text: source.text, sourceId: source.mediaId, ...placement,
        sentenceId, paragraphId: sentences.get(sentenceId)?.paragraphId ?? null,
        timingNeedsReview: Boolean(source.needsReview) });
    }
  }
  if (!words.length || new Set(words.map(word => word.id)).size !== words.length) throw new Error('Locked handoff requires unique retained words');
  const sentenceGroups = passages(words, 'sentenceId', 'sentence');
  const paragraphGroups = passages(words, 'paragraphId', 'paragraph');
  for (let i = 0; i < sentenceGroups.length; i++) {
    sentenceGroups[i].previousText = sentenceGroups[i - 1]?.text ?? null;
    sentenceGroups[i].nextText = sentenceGroups[i + 1]?.text ?? null;
  }
  for (let i = 0; i < paragraphGroups.length; i++) {
    paragraphGroups[i].previousText = paragraphGroups[i - 1]?.text ?? null;
    paragraphGroups[i].nextText = paragraphGroups[i + 1]?.text ?? null;
  }
  const timeline = { fps, width: compiled.timeline.width, height: compiled.timeline.height, duration: compiled.timeline.duration,
    intervals: compiled.timeline.intervals.map(({ sourceId, inFrame, outFrame, start, end, wordIds }) => ({ sourceId, inFrame, outFrame, start, end, wordIds })) };
  const sources = Object.fromEntries(project.media.map(media => [media.id, { filename: media.filename, identity: media.identity }]));
  const content = { schemaVersion: 1, kind: 'reviewed-edit', projectId: project.id,
    analysisId: compiled.analysisId, selectionId: compiled.selectionId, timingId: compiled.timingId,
    timeline, sources, words, sentences: sentenceGroups, paragraphs: paragraphGroups,
    text: spokenText(words), wholeScriptSummary: paragraphGroups.map(group => group.text.split(/(?<=[.!?])\s+/)[0]).join(' ').slice(0, 3000),
    summaryMethod: 'extractive-paragraph-openings' };
  return { ...content, id: hash(content) };
}

// Evaluation-only bridge for a separately exported phase-1 edit. It requires
// original source-word timestamps and the edit's XML clip geometry, never
// timestamps guessed from a baked video.
export function buildReferenceHandoff(input) {
  const fps = input?.timeline?.fps;
  if (!fps || !Number.isSafeInteger(fps.numerator) || !Number.isSafeInteger(fps.denominator) || fps.numerator <= 0 || fps.denominator <= 0 ||
      !Number.isSafeInteger(input.width) || input.width <= 0 || !Number.isSafeInteger(input.height) || input.height <= 0 ||
      !Array.isArray(input.words) || !input.words.length || !Array.isArray(input.timeline.intervals) || !input.timeline.intervals.length ||
      !input.sources || typeof input.sources !== 'object' ||
      (input.wholeScriptSummary !== undefined && typeof input.wholeScriptSummary !== 'string')) throw new Error('Invalid reference handoff input');
  const intervals = input.timeline.intervals;
  const compiled = compileTimeline(intervals.map(({ sourceId, inFrame, outFrame, wordIds }) => ({ sourceId, inFrame, outFrame, wordIds })), input.sources, fps);
  if (input.timeline.duration !== compiled.duration || intervals.some((interval, index) =>
    interval.start !== compiled.intervals[index].start || interval.end !== compiled.intervals[index].end ||
    !Array.isArray(interval.wordIds))) throw new Error('Reference intervals differ from compiled XML clip placement');
  const sourceWords = new Map(input.words.map(word => [word.id, word]));
  if (sourceWords.size !== input.words.length || input.words.some(word => typeof word.id !== 'string' || !word.id || typeof word.text !== 'string' || !word.text.trim())) throw new Error('Invalid reference transcript words');
  const words = compiled.intervals.flatMap(interval => interval.wordIds.map(id => {
    const source = sourceWords.get(id);
    const placement = placeSourceWord(source, interval, fps);
    return { id, text: source.text, sourceId: source.mediaId, ...placement,
      sentenceId: null, paragraphId: null, timingNeedsReview: Boolean(source.needsReview) };
  }));
  if (new Set(words.map(word => word.id)).size !== words.length || words.length !== input.words.length) throw new Error('Reference timeline must contain each transcript word exactly once');
  const content = { schemaVersion: 1, kind: 'reference-fixture', forEvaluationOnly: true,
    timingBasis: 'source-transcript-and-compiled-xml-intervals',
    timeline: { fps, width: input.width, height: input.height, duration: compiled.duration,
      intervals: compiled.intervals.map(({ sourceId, inFrame, outFrame, start, end, wordIds }) => ({ sourceId, inFrame, outFrame, start, end, wordIds })) },
    sources: Object.fromEntries(Object.entries(input.sources).map(([id, source]) => [id, { filename: source.filename ?? id, identity: source.identity ?? null }])),
    words, sentences: passages(words, 'sentenceId', 'sentence'), paragraphs: passages(words, 'paragraphId', 'paragraph'),
    text: spokenText(words), wholeScriptSummary: input.wholeScriptSummary ?? null, summaryMethod: input.wholeScriptSummary ? 'provided' : 'not-provided' };
  return { ...content, id: hash(content) };
}

export function handoffPath(projectPath, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid handoff ID');
  return join(`${projectPath}.handoffs`, `${id}.json`);
}

export async function saveEditHandoff(projectPath, handoff) {
  const { id, ...content } = handoff;
  if (hash(content) !== id) throw new Error('Handoff fingerprint mismatch');
  const path = handoffPath(projectPath, id);
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(handoff)) throw new Error('Existing handoff differs from locked content');
    return path;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(handoff, null, 2), { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
  return path;
}

export async function readEditHandoff(projectPath, id) {
  const handoff = JSON.parse(await readFile(handoffPath(projectPath, id), 'utf8'));
  const { id: actualId, ...content } = handoff;
  if (actualId !== id || hash(content) !== id) throw new Error('Locked handoff fingerprint mismatch');
  return handoff;
}
