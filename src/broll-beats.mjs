import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderPrompt } from './prompt-templates.mjs';

export const BEAT_PROPOSAL_SCHEMA = Object.freeze({
  // Keep the provider grammar deliberately small. Gemini supports the
  // constraints below in isolation, but bounded arrays of strict nested
  // objects can exceed its structured-output grammar complexity limit and
  // are rejected with only INVALID_ARGUMENT. validateBeatProposals remains
  // the authoritative strict validator for count, keys, order, and coverage.
  type: 'object', required: ['beats'], properties: {
    beats: { type: 'array', items: { type: 'object',
      required: ['startWordId', 'endWordId', 'visualIntent', 'artworkNeed', 'talkingHeadPriority', 'searchQuery', 'reason'], properties: {
        startWordId: { type: 'string' }, endWordId: { type: 'string' }, visualIntent: { type: 'string' },
        artworkNeed: { type: 'string', enum: ['required', 'optional', 'none'] },
        talkingHeadPriority: { type: 'string', enum: ['high', 'normal'] },
        searchQuery: { type: 'string' }, reason: { type: 'string' }
      } } }
  }
});

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = words => words.map(word => word.text).join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
const clean = (value, name, maximum = 2000, { allowEmpty = false } = {}) => {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /\[[^\]]*\]/.test(value)) throw new Error(`Invalid beat ${name}`);
  return value.trim();
};
const keys = (value, name) => {
  if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 100)) throw new Error(`Invalid beat ${name}`);
  return [...new Set(value.map(item => item.trim()))];
};
const framesPerSecond = handoff => handoff.timeline.fps.numerator / handoff.timeline.fps.denominator;
const transcriptSentenceRanges = words => {
  const ranges = [];
  for (let start = 0; start < words.length;) {
    let end = start;
    while (end + 1 < words.length && end - start + 1 < 40 && !/[.!?][-"”')]*$/.test(words[end].text)) end++;
    ranges.push({ start, end, text: text(words.slice(start, end + 1)) });
    start = end + 1;
  }
  return ranges;
};
const transcriptVideoContext = handoff => text(handoff.words).slice(0, 800);

export function validateBeatProposals(handoff, response) {
  if (!handoff || !Array.isArray(handoff.words) || !handoff.words.length || !Number.isSafeInteger(handoff.timeline?.duration) ||
      handoff.timeline.duration <= 0 || !handoff.timeline.fps || handoff.words.some(word => !word.id || !Number.isSafeInteger(word.startFrame) ||
      !Number.isSafeInteger(word.endFrame) || word.startFrame < 0 || word.endFrame > handoff.timeline.duration || word.endFrame <= word.startFrame ||
      /\[[^\]]*\]/.test(word.text))) throw new Error('Invalid locked transcript for beat planning');
  const maximumBeats = Math.min(40, handoff.words.length);
  if (!response || !Array.isArray(response.beats) || !response.beats.length || response.beats.length > maximumBeats) throw new Error(`Beat proposal needs 1–${maximumBeats} beats for this chunk`);
  const byId = new Map(handoff.words.map((word, index) => [word.id, index]));
  if (byId.size !== handoff.words.length) throw new Error('Locked transcript has duplicate word IDs');
  let nextIndex = 0;
  const beats = response.beats.map((raw, beatIndex) => {
    const startIndex = byId.get(raw?.startWordId), endIndex = byId.get(raw?.endWordId);
    if (startIndex === undefined || endIndex === undefined) throw new Error(`Beat ${beatIndex + 1} invented a word ID`);
    if (startIndex !== nextIndex || endIndex < startIndex) throw new Error(`Beat ${beatIndex + 1} has a gap, overlap, or non-monotonic word range`);
    if (!['required', 'optional', 'none'].includes(raw.artworkNeed) || !['high', 'normal'].includes(raw.talkingHeadPriority)) throw new Error(`Beat ${beatIndex + 1} has an invalid decision`);
    const visualIntent = clean(raw.visualIntent, 'visual intent', 2000, { allowEmpty: raw.artworkNeed === 'none' });
    const searchQuery = clean(raw.searchQuery, 'search query', 1000, { allowEmpty: raw.artworkNeed === 'none' });
    const reason = clean(raw.reason, 'reason', 2000);
    nextIndex = endIndex + 1;
    return { startIndex, endIndex, startWordId: raw.startWordId, endWordId: raw.endWordId,
      visualIntent, artworkNeed: raw.artworkNeed, talkingHeadPriority: raw.talkingHeadPriority, searchQuery, reason,
      bookKeys: keys(raw.bookKeys ?? [], 'books'), centralCharacterKeys: keys(raw.centralCharacterKeys ?? [], 'characters'),
      settingKeys: keys(raw.settingKeys ?? [], 'settings'), moodKeys: keys(raw.moodKeys ?? [], 'moods'), imageTypeKeys: keys(raw.imageTypeKeys ?? [], 'image types') };
  });
  if (nextIndex !== handoff.words.length) throw new Error('Beat proposal omitted the final retained words');
  return beats;
}

function decorate(handoff, beats) {
  const transcriptSentences = transcriptSentenceRanges(handoff.words);
  return beats.map((beat, index) => {
    const words = handoff.words.slice(beat.startIndex, beat.endIndex + 1);
    const firstSentence = transcriptSentences.findIndex(group => beat.startIndex >= group.start && beat.startIndex <= group.end);
    const lastSentence = transcriptSentences.findIndex(group => beat.endIndex >= group.start && beat.endIndex <= group.end);
    const localContext = text(handoff.words.slice(Math.max(0, beat.startIndex - 40), Math.min(handoff.words.length, beat.endIndex + 41)));
    const startFrame = index === 0 ? 0 : words[0].startFrame;
    const endFrame = index + 1 < beats.length ? handoff.words[beats[index + 1].startIndex].startFrame : handoff.timeline.duration;
    if (endFrame <= startFrame) throw new Error('Beat boundaries collide on the sequence timeline');
    return { ...beat, id: `${words[0].id}..${words.at(-1).id}`, text: text(words), startFrame, endFrame,
      wordStartFrame: words[0].startFrame, wordEndFrame: words.at(-1).endFrame,
      previousSentence: transcriptSentences[firstSentence - 1]?.text ?? null,
      nextSentence: transcriptSentences[lastSentence + 1]?.text ?? null,
      paragraphContext: localContext };
  });
}

function merge(left, right) {
  const needs = ['none', 'optional', 'required'];
  const chosen = needs.indexOf(left.artworkNeed) >= needs.indexOf(right.artworkNeed) ? left : right;
  return { ...left, endIndex: right.endIndex, endWordId: right.endWordId,
    artworkNeed: chosen.artworkNeed, searchQuery: chosen.searchQuery, visualIntent: chosen.visualIntent,
    talkingHeadPriority: left.talkingHeadPriority === 'high' || right.talkingHeadPriority === 'high' ? 'high' : 'normal',
    reason: `${left.reason} ${right.reason}`.slice(0, 2000),
    bookKeys: [...new Set([...left.bookKeys, ...right.bookKeys])],
    centralCharacterKeys: [...new Set([...left.centralCharacterKeys, ...right.centralCharacterKeys])],
    settingKeys: [...new Set([...left.settingKeys, ...right.settingKeys])],
    moodKeys: [...new Set([...left.moodKeys, ...right.moodKeys])],
    imageTypeKeys: [...new Set([...left.imageTypeKeys, ...right.imageTypeKeys])] };
}

export function normalizeBeatProposals(handoff, rawBeats) {
  const fps = framesPerSecond(handoff);
  let beats = rawBeats.map(beat => ({ ...beat }));
  // A short phrase joins a neighbor when the resulting beat remains in the
  // ordinary 11-second window. This changes grouping, never word timestamps.
  for (let index = 0; index < beats.length && beats.length > 1;) {
    const placed = decorate(handoff, beats);
    if (placed[index].endFrame - placed[index].startFrame >= 3 * fps) { index++; continue; }
    const previousFits = index > 0 && placed[index].endFrame - placed[index - 1].startFrame <= 11 * fps;
    const nextFits = index + 1 < beats.length && placed[index + 1].endFrame - placed[index].startFrame <= 11 * fps;
    if (previousFits) { beats.splice(index - 1, 2, merge(beats[index - 1], beats[index])); index = Math.max(0, index - 1); }
    else if (nextFits) beats.splice(index, 2, merge(beats[index], beats[index + 1]));
    else index++;
  }
  // Split overlong proposals near phrase/sentence punctuation, falling back
  // to a word boundary only when there is no usable clause boundary.
  for (let index = 0; index < beats.length; index++) {
    const placed = decorate(handoff, beats);
    if (placed[index].endFrame - placed[index].startFrame <= 11 * fps || beats[index].endIndex === beats[index].startIndex) continue;
    const beat = beats[index]; const choices = [];
    for (let split = beat.startIndex + 1; split <= beat.endIndex; split++) {
      const boundary = handoff.words[split].startFrame;
      const leftSeconds = (boundary - placed[index].startFrame) / fps;
      const rightSeconds = (placed[index].endFrame - boundary) / fps;
      if (leftSeconds < 3 || rightSeconds < 3) continue;
      const previous = handoff.words[split - 1];
      const clause = /[,.!?;:]$/.test(previous.text) || previous.sentenceId !== handoff.words[split].sentenceId;
      choices.push({ split, score: Math.abs(leftSeconds - 7) - (clause ? 3 : 0) });
    }
    choices.sort((a, b) => a.score - b.score || a.split - b.split);
    if (!choices.length) continue;
    const split = choices[0].split;
    beats.splice(index, 1, { ...beat, endIndex: split - 1, endWordId: handoff.words[split - 1].id },
      { ...beat, startIndex: split, startWordId: handoff.words[split].id });
    index--;
  }
  const result = decorate(handoff, beats);
  const spoken = handoff.words.map(word => word.text.toLowerCase().replace(/[^a-z']/g, ''));
  const marker = ['time', 'to', 'follow', 'me', 'into', 'the', 'wardrobe'];
  let establishingIndex = -1;
  for (let index = 0; index <= spoken.length - marker.length; index++) {
    if (marker.every((part, offset) => spoken[index + offset] === part)) { establishingIndex = index + marker.length; break; }
  }
  // These are passage windows, not just the first and last beat: the opening
  // needs several visual opportunities and the ending a montage.
  const durationSeconds = handoff.timeline.duration / fps;
  const openingSeconds = Math.min(15, durationSeconds * 0.2);
  const closingSeconds = Math.min(30, durationSeconds * 0.25);
  for (const beat of result) {
    beat.opening = beat.startFrame < openingSeconds * fps;
    beat.closing = beat.endFrame > handoff.timeline.duration - closingSeconds * fps;
    beat.establishing = establishingIndex >= beat.startIndex && establishingIndex <= beat.endIndex;
    if (beat.opening || beat.closing || beat.establishing) beat.artworkNeed = 'required';
    if (/\b(i think|i believe|my opinion|here's the thing|now let me say|let me be clear|i want to|i feel)\b/i.test(beat.text)) {
      beat.talkingHeadPriority = 'high';
      if (beat.artworkNeed === 'optional') beat.artworkNeed = 'none';
    }
    beat.warnings = [];
    const seconds = (beat.endFrame - beat.startFrame) / fps;
    if (seconds > 11) beat.warnings.push('longer_than_typical_beat');
    if (seconds < 5 && beat.artworkNeed !== 'none') beat.warnings.push('shorter_than_artwork_group_minimum');
    if (transcriptSentenceRanges(handoff.words.slice(beat.startIndex, beat.endIndex + 1)).length > 2) beat.warnings.push('more_than_two_sentences');
  }
  return result;
}

function wordWindows(words, maximum = 240) {
  const windows = [];
  for (let start = 0; start < words.length;) {
    let end = Math.min(words.length, start + maximum);
    if (end < words.length) {
      let sentenceBreak = -1;
      for (let index = start + Math.floor(maximum / 2); index <= end; index++) {
        if (/[.!?][-"”')]*$/.test(words[index - 1]?.text ?? '')) sentenceBreak = index;
      }
      end = sentenceBreak > start ? sentenceBreak : end;
    }
    windows.push({ start, end }); start = end;
  }
  return windows;
}

export function compactBeatContext(handoff, { start = 0, end = handoff.words.length } = {}) {
  const localWords = handoff.words.slice(start, end);
  const sentences = transcriptSentenceRanges(localWords).map((range, sentenceIndex) => ({ id: `s${sentenceIndex}`,
    words: localWords.slice(range.start, range.end + 1).map((word, offset) => [`w${range.start + offset}`, word.text]) }));
  return { videoContext: transcriptVideoContext(handoff),
    precedingContext: text(handoff.words.slice(Math.max(0, start - 20), start)),
    followingContext: text(handoff.words.slice(end, Math.min(handoff.words.length, end + 20))),
    sentences: sentences.map(({ id, words }) => ({ id, words })) };
}

function restoreWordIds(response, words) {
  const byKey = new Map(words.map((word, index) => [`w${index}`, word.id]));
  return { ...response, beats: response?.beats?.map(beat => ({ ...beat,
    startWordId: byKey.get(beat.startWordId) ?? beat.startWordId,
    endWordId: byKey.get(beat.endWordId) ?? beat.endWordId })) };
}

export async function planBrollBeats({ handoff, catalog, provider, model, promptOverride = null, signal }) {
  if (typeof handoff?.id !== 'string' || !Array.isArray(handoff.words) || !handoff.words.length ||
      typeof provider?.generateStructuredText !== 'function' || typeof catalog?.execute !== 'function' ||
      typeof model !== 'string' || !model.trim()) throw new Error('Locked handoff, catalog, provider, and model are required');
  // Check the entire accepted pool before making a paid hosted-model call.
  // A partial catalog would otherwise bias the visual plan without warning.
  const ready = await catalog.execute('search.broll.readiness');
  if (!ready.ok) return { ok: false, code: ready.code, message: ready.message,
    action: ready.action, readiness: ready.readiness, catalogId: ready.catalogId, handoffId: handoff.id };
  const catalogState = await catalog.execute('catalog.snapshot', { limit: 1 });
  const proposals = [], promptRequests = [];
  for (const window of wordWindows(handoff.words)) {
    if (signal?.aborted) throw new Error('Beat planning canceled');
    const chunk = { ...handoff, words: handoff.words.slice(window.start, window.end) };
    const prompt = renderPrompt('beatPlanning', { handoffJson: JSON.stringify(compactBeatContext(handoff, window)) }, promptOverride);
    const response = await provider.generateStructuredText({ model, systemText: prompt.systemText, userText: prompt.userText,
      outputSchema: BEAT_PROPOSAL_SCHEMA, signal });
    proposals.push(...validateBeatProposals(chunk, restoreWordIds(response.values, chunk.words)).map(beat => ({ ...beat,
      startIndex: beat.startIndex + window.start, endIndex: beat.endIndex + window.start })));
    promptRequests.push({ startWordId: chunk.words[0].id, endWordId: chunk.words.at(-1).id,
      systemText: prompt.systemText, userText: prompt.userText,
      providerModel: response.providerModel ?? model, providerRequestId: response.providerRequestId ?? null });
  }
  const beats = normalizeBeatProposals(handoff, proposals);
  const planned = [];
  for (const beat of beats) {
    if (signal?.aborted) throw new Error('Beat planning canceled');
    if (beat.artworkNeed === 'none' || beat.warnings.includes('shorter_than_artwork_group_minimum')) {
      planned.push({ ...beat, search: null, searchStatus: 'not_requested' }); continue;
    }
    const query = { semanticText: beat.searchQuery || beat.visualIntent || beat.text, spokenText: beat.text, paragraphContext: beat.paragraphContext,
      videoTheme: transcriptVideoContext(handoff), bookKeys: [], centralCharacterKeys: [], settingKeys: [], moodKeys: [], imageTypeKeys: [],
      outputWidth: handoff.timeline.width, outputHeight: handoff.timeline.height, limit: 8 };
    let response;
    try { response = await catalog.execute('search.broll', query); }
    catch (error) {
      planned.push({ ...beat, search: { query, response: { ok: false, code: 'search_failed', message: String(error?.message ?? error), results: [] } }, searchStatus: 'search_failed' });
      continue;
    }
    if (!response.ok) { planned.push({ ...beat, search: { query, response }, searchStatus: response.code ?? 'failed' }); continue; }
    // Local paths are resolved from the catalog only when needed, never used
    // as persistent image identity or sent to the selection model.
    const results = response.results.map(({ path, ...candidate }) => candidate);
    planned.push({ ...beat, search: { query, response: { ...response, results } }, searchStatus: results.length ? 'candidates' : 'no_candidates' });
  }
  const content = { schemaVersion: 1, handoffId: handoff.id, catalogId: catalogState.catalog.id,
    catalogRevision: catalogState.catalog.revision ?? null,
    timeline: { fps: handoff.timeline.fps, duration: handoff.timeline.duration, width: handoff.timeline.width, height: handoff.timeline.height },
    wholeScriptSummary: transcriptVideoContext(handoff),
    status: planned.some(beat => beat.searchStatus === 'search_not_ready') ? 'search_not_ready' :
      planned.some(beat => beat.searchStatus === 'search_failed') ? 'search_failed' : 'proposed',
    promptSnapshot: { model, template: renderPrompt('beatPlanning', { handoffJson: '{}' }, promptOverride).template,
      responseSchema: BEAT_PROPOSAL_SCHEMA, providerSchema: true,
      requests: promptRequests },
    beats: planned };
  return { ...content, id: fingerprint(content) };
}

export function brollPlanPath(projectPath, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid B-roll plan ID');
  return join(`${projectPath}.broll-plans`, `${id}.json`);
}

export async function saveBrollBeatPlan(projectPath, plan) {
  const { id, ...content } = plan;
  if (fingerprint(content) !== id) throw new Error('B-roll plan fingerprint mismatch');
  const path = brollPlanPath(projectPath, id);
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error('Existing B-roll plan differs');
    return path;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(plan, null, 2), { flag: 'wx' }); await rename(temporary, path); }
  catch (error) { try { await unlink(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; } throw error; }
  return path;
}

export async function readBrollBeatPlan(projectPath, id) {
  const plan = JSON.parse(await readFile(brollPlanPath(projectPath, id), 'utf8'));
  const { id: actualId, ...content } = plan;
  if (actualId !== id || fingerprint(content) !== id) throw new Error('B-roll beat plan fingerprint mismatch');
  return plan;
}
