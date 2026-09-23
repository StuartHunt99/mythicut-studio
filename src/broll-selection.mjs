import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderPrompt } from './prompt-templates.mjs';
import { hashDistance } from './image-tagging/near-duplicate.mjs';
import { artworkMinimumForPlan } from './broll-artwork-config.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const IMAGE_CHOICE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['selectedImageId', 'reason'], properties: {
    selectedImageId: { type: 'string', description: 'A supplied imageId, or an empty string for no suitable image' },
    reason: { type: 'string' }
  }
});

export const ALLOCATION_SCHEMA = Object.freeze({
  // The application validates the sparse updates strictly. Keep the hosted
  // grammar unbounded and non-strict so Gemini does not expand hundreds of
  // possible nested objects while compiling the response schema.
  type: 'object', required: ['updates', 'reuseExceptions'], properties: {
    updates: { type: 'array', items: { type: 'object',
      required: ['beatId', 'selectedImageId', 'reason'], properties: {
        beatId: { type: 'string' }, selectedImageId: { type: 'string' }, reason: { type: 'string' }
      } } },
    reuseExceptions: { type: 'array', items: { type: 'object',
      required: ['firstBeatId', 'secondBeatId', 'reason'], properties: {
        firstBeatId: { type: 'string' }, secondBeatId: { type: 'string' }, reason: { type: 'string' }
      } } }
  }
});

function cleanReason(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /\[[^\]]*\]/.test(value)) throw new Error('Image decision requires a concise, plain reason');
  return value.trim();
}

function candidateIds(beat) {
  return new Set((beat.search?.response?.results ?? []).map(candidate => candidate.imageId));
}

function validateChoice(beat, value) {
  const selectedImageId = value?.selectedImageId || null;
  if (selectedImageId !== null && !candidateIds(beat).has(selectedImageId)) throw new Error(`Image agent invented or chose an ineligible image for beat ${beat.id}`);
  return { selectedImageId, reason: cleanReason(value?.reason) };
}

function embeddedSelectionPacket(value) {
  if (typeof value !== 'string' || value.length > 1_000_000) return null;
  for (let start = value.indexOf('{'); start >= 0; start = value.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < value.length; index++) {
      const character = value[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try {
          const parsed = JSON.parse(value.slice(start, index + 1));
          if (parsed?.beat?.id && Array.isArray(parsed?.selectionPacket?.candidates)) return parsed;
        } catch {}
        break;
      }
    }
  }
  return null;
}

export function recoverBrollSelectionProgress(beatPlan, jsonLines, model = null) {
  if (!Array.isArray(beatPlan?.beats) || typeof jsonLines !== 'string' || jsonLines.length > 25_000_000) return [];
  const rows = [];
  for (const line of jsonLines.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { return []; }
  }
  const run = rows.find(row => row.kind === 'run');
  if (run?.stage !== 'selection' || (model && run.model !== model)) return [];
  const beats = new Map(beatPlan.beats.map(beat => [beat.id, beat]));
  const recovered = [], seen = new Set();
  let pending = null;
  for (const row of rows) {
    if (row.kind === 'request') {
      pending = null;
      if (!row.request?.outputSchema?.properties?.selectedImageId) continue;
      const packet = embeddedSelectionPacket(row.request.userText);
      const beat = beats.get(packet?.beat?.id);
      if (!beat || packet.beat.text !== beat.text || seen.has(beat.id)) continue;
      const loggedIds = packet.selectionPacket.candidates.map(candidate => candidate?.imageId);
      const currentIds = (beat.search?.response?.selectionPacket?.candidates ?? []).map(candidate => candidate.imageId);
      if (loggedIds.some(id => typeof id !== 'string') || JSON.stringify(loggedIds) !== JSON.stringify(currentIds)) continue;
      pending = { beat, systemText: row.request.systemText, userText: row.request.userText };
      continue;
    }
    if (row.kind !== 'response' || !pending) continue;
    try {
      const decision = validateChoice(pending.beat, row.response?.output);
      recovered.push({ beatId: pending.beat.id, decision, systemText: pending.systemText, userText: pending.userText,
        providerModel: row.response?.modelId ?? run.model ?? model, providerRequestId: row.response?.requestId ?? null });
      seen.add(pending.beat.id);
    } catch {}
    pending = null;
  }
  return recovered;
}

function duplicates(beats, decisions) {
  const byImage = new Map();
  for (const beat of beats) {
    const imageId = decisions.get(beat.id)?.selectedImageId;
    if (!imageId) continue;
    const group = byImage.get(imageId) ?? [];
    group.push(beat.id); byImage.set(imageId, group);
  }
  return [...byImage].filter(([, ids]) => ids.length > 1).map(([imageId, beatIds]) => ({ imageId, beatIds }));
}

function nearDuplicates(beats, decisions, hashes) {
  const chosen = beats.filter(beat => decisions.get(beat.id)?.selectedImageId);
  const pairs = [];
  for (let first = 0; first < chosen.length; first++) for (let second = first + 1; second < chosen.length; second++) {
    const a = decisions.get(chosen[first].id).selectedImageId;
    const b = decisions.get(chosen[second].id).selectedImageId;
    if (a === b || !hashes.has(a) || !hashes.has(b)) continue;
    const distance = hashDistance(hashes.get(a), hashes.get(b));
    if (distance <= 6) pairs.push({ firstBeatId: chosen[first].id, secondBeatId: chosen[second].id,
      firstImageId: a, secondImageId: b, hashDistance: distance });
  }
  return pairs;
}

function reuseAllowed(first, second, explicitExceptions, fps) {
  if (first.opening || first.closing || second.opening || second.closing) return true;
  const seconds = Math.abs(second.startFrame - first.startFrame) / fps;
  return seconds >= 240 && explicitExceptions.some(item =>
    ((item.firstBeatId === first.id && item.secondBeatId === second.id) ||
      (item.firstBeatId === second.id && item.secondBeatId === first.id)) && cleanReason(item.reason));
}

export function summarizeBrollCoverage(beats, choices, fps, minimumClipSeconds = 5) {
  let coveredFrames = 0, uncoveredStart = null, longestUncoveredFrames = 0;
  const warnings = [];
  for (const beat of beats) {
    const selected = choices.get(beat.id)?.selectedImageId;
    const length = beat.endFrame - beat.startFrame;
    if (selected) {
      coveredFrames += length;
      if (uncoveredStart !== null) longestUncoveredFrames = Math.max(longestUncoveredFrames, beat.startFrame - uncoveredStart);
      uncoveredStart = null;
      if (length / fps < minimumClipSeconds) warnings.push({ beatId: beat.id, code: 'artwork_group_under_minimum', minimumClipSeconds });
    } else {
      if (uncoveredStart === null) uncoveredStart = beat.startFrame;
      if (beat.artworkNeed === 'required') warnings.push({ beatId: beat.id, code: 'required_artwork_missing' });
    }
  }
  if (uncoveredStart !== null) longestUncoveredFrames = Math.max(longestUncoveredFrames, beats.at(-1).endFrame - uncoveredStart);
  const durationFrames = beats.at(-1).endFrame - beats[0].startFrame;
  const brollPercent = durationFrames ? 100 * coveredFrames / durationFrames : 0;
  if (brollPercent < 50) warnings.push({ code: 'below_50_percent_broll' });
  if (longestUncoveredFrames / fps > 15) warnings.push({ code: 'uncovered_gap_over_15_seconds' });
  const closing = beats.filter(beat => beat.closing);
  const closingFrames = closing.reduce((total, beat) => total + beat.endFrame - beat.startFrame, 0);
  if (closingFrames / fps >= 12) {
    const images = new Set(closing.map(beat => choices.get(beat.id)?.selectedImageId).filter(Boolean));
    if (images.size < 4 || images.size > 6) warnings.push({ code: 'closing_montage_image_count', actual: images.size, targetMinimum: 4, targetMaximum: 6 });
  }
  return { coveredFrames, durationFrames, brollPercent, longestUncoveredFrames, longestUncoveredSeconds: longestUncoveredFrames / fps, warnings };
}

export async function selectBrollImages({ beatPlan, provider, model, promptOverrides = {}, nearDuplicateHash = null,
  recoveredProgress = [], signal }) {
  if (typeof beatPlan?.id !== 'string' || !Array.isArray(beatPlan.beats) || !beatPlan.beats.length ||
      !Number.isSafeInteger(beatPlan.timeline?.fps?.numerator) || !Number.isSafeInteger(beatPlan.timeline?.fps?.denominator) ||
      beatPlan.timeline.fps.denominator <= 0 || typeof provider?.generateStructuredText !== 'function' ||
      typeof model !== 'string' || !model.trim()) throw new Error('Saved beat plan, provider, and model are required');
  const beats = beatPlan.beats;
  const recoverable = new Map((Array.isArray(recoveredProgress) ? recoveredProgress : []).map(item => [item?.beatId, item]));
  const initialDecisions = [], decisions = new Map(), selectionPrompts = [];
  for (const beat of beats) {
    if (signal?.aborted) throw new Error('Image selection canceled');
    if (beat.searchStatus !== 'candidates') {
      const decision = { beatId: beat.id, selectedImageId: null, reason: beat.searchStatus === 'no_candidates' ? 'No eligible catalog candidates.' : 'Artwork search was not requested or unavailable.' };
      initialDecisions.push(decision); decisions.set(beat.id, decision); continue;
    }
    const packet = { beat: { id: beat.id, text: beat.text, previousSentence: beat.previousSentence,
      nextSentence: beat.nextSentence, visualIntent: beat.visualIntent, artworkNeed: beat.artworkNeed,
      talkingHeadPriority: beat.talkingHeadPriority, opening: beat.opening, closing: beat.closing, establishing: beat.establishing,
      startFrame: beat.startFrame, endFrame: beat.endFrame },
    selectionPacket: beat.search.response.selectionPacket,
    usageLedger: [...decisions.values()].filter(item => item.selectedImageId).map(item => ({ beatId: item.beatId, imageId: item.selectedImageId })) };
    const prompt = renderPrompt('imageSelection', { selectionPacketJson: JSON.stringify(packet) }, promptOverrides.imageSelection ?? null);
    const recovered = recoverable.get(beat.id);
    let response, recoveredFromLog = false;
    if (recovered && recovered.systemText === prompt.systemText && recovered.userText === prompt.userText) {
      response = { values: recovered.decision, providerModel: recovered.providerModel, providerRequestId: recovered.providerRequestId };
      recoveredFromLog = true;
    } else {
      response = await provider.generateStructuredText({ model, systemText: prompt.systemText,
        userText: prompt.userText, outputSchema: IMAGE_CHOICE_SCHEMA, signal });
    }
    const decision = { beatId: beat.id, ...validateChoice(beat, response.values) };
    initialDecisions.push(decision); decisions.set(beat.id, decision);
    selectionPrompts.push({ beatId: beat.id, systemText: prompt.systemText, userText: prompt.userText,
      providerModel: response.providerModel ?? model, providerRequestId: response.providerRequestId ?? null, recoveredFromLog });
  }

  const hashes = new Map(), hashErrors = [];
  async function hashSelected() {
    if (typeof nearDuplicateHash !== 'function') return;
    for (const imageId of new Set([...decisions.values()].map(item => item.selectedImageId).filter(Boolean))) {
      if (hashes.has(imageId) || hashErrors.some(item => item.imageId === imageId)) continue;
      try { hashes.set(imageId, await nearDuplicateHash(imageId)); }
      catch (error) { hashErrors.push({ imageId, message: String(error?.message ?? error).slice(0, 500) }); }
    }
  }
  await hashSelected();
  const allocationUpdates = [], allocationPrompts = [];
  const conflicts = duplicates(beats, decisions);
  const nearConflicts = nearDuplicates(beats, decisions, hashes);
  let explicitExceptions = [];
  if (conflicts.length || nearConflicts.length) {
    const context = { wholeScriptSummary: beatPlan.wholeScriptSummary ?? null,
      assignments: beats.map(beat => ({ beatId: beat.id, text: beat.text, startFrame: beat.startFrame,
        opening: beat.opening, closing: beat.closing, chosenImageId: decisions.get(beat.id).selectedImageId })),
      nearDuplicateWarnings: nearConflicts.map(pair => ({ ...pair,
        alternatives: [pair.firstBeatId, pair.secondBeatId].map(id => ({ beatId: id,
          candidates: beats.find(item => item.id === id).search?.response?.selectionPacket?.candidates ?? [] })) })),
      conflicts: conflicts.map(conflict => ({ ...conflict, alternatives: conflict.beatIds.map(id => {
        const beat = beats.find(item => item.id === id);
        return { beatId: id, candidates: beat.search?.response?.selectionPacket?.candidates ?? [] };
      }) })) };
    const prompt = renderPrompt('allocation', { allocationContextJson: JSON.stringify(context) }, promptOverrides.allocation ?? null);
    const response = await provider.generateStructuredText({ model, systemText: prompt.systemText,
      userText: prompt.userText, outputSchema: ALLOCATION_SCHEMA, signal });
    if (!Array.isArray(response.values?.updates) || !Array.isArray(response.values?.reuseExceptions)) throw new Error('Allocation agent returned an invalid response');
    const seen = new Set();
    for (const update of response.values.updates) {
      const beat = beats.find(item => item.id === update.beatId);
      if (!beat || seen.has(beat.id)) throw new Error('Allocation agent invented or repeated a beat');
      seen.add(beat.id);
      const choice = validateChoice(beat, update);
      const item = { beatId: beat.id, ...choice, source: 'allocation_agent' };
      decisions.set(beat.id, item); allocationUpdates.push(item);
    }
    explicitExceptions = response.values.reuseExceptions;
    allocationPrompts.push({ systemText: prompt.systemText, userText: prompt.userText,
      providerModel: response.providerModel ?? model, providerRequestId: response.providerRequestId ?? null });
  }
  // Enforce the duplicate policy even if the allocation agent leaves an
  // unresolved conflict. A null choice is safer than accidental reuse.
  const uses = new Map();
  const fps = beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator;
  for (const beat of beats) {
    const choice = decisions.get(beat.id);
    if (!choice.selectedImageId) continue;
    const earlier = uses.get(choice.selectedImageId) ?? [];
    if (earlier.some(previous => !reuseAllowed(previous, beat, explicitExceptions, fps))) {
      const item = { beatId: beat.id, selectedImageId: null, reason: 'Duplicate image use was unresolved; left without artwork.', source: 'duplicate_safety' };
      decisions.set(beat.id, item); allocationUpdates.push(item);
    } else uses.set(choice.selectedImageId, [...earlier, beat]);
  }
  const finalDecisions = beats.map(beat => decisions.get(beat.id));
  await hashSelected();
  const coverage = summarizeBrollCoverage(beats, decisions, fps, artworkMinimumForPlan(beatPlan));
  coverage.warnings.push(...nearDuplicates(beats, decisions, hashes).map(pair => ({ code: 'possible_near_duplicate', ...pair })));
  coverage.warnings.push(...hashErrors.map(item => ({ code: 'near_duplicate_check_unavailable', ...item })));
  const content = { schemaVersion: 1, beatPlanId: beatPlan.id, handoffId: beatPlan.handoffId,
    catalogId: beatPlan.catalogId, initialDecisions, allocationUpdates, explicitExceptions, finalDecisions, coverage,
    promptSnapshot: { model, imageSelectionTemplate: renderPrompt('imageSelection', { selectionPacketJson: '{}' }, promptOverrides.imageSelection ?? null).template,
      allocationTemplate: renderPrompt('allocation', { allocationContextJson: '{}' }, promptOverrides.allocation ?? null).template,
      selectionRequests: selectionPrompts, allocationRequests: allocationPrompts } };
  return { ...content, id: hash(content) };
}

export function brollSelectionPath(projectPath, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid B-roll selection ID');
  return join(`${projectPath}.broll-selections`, `${id}.json`);
}

export async function saveBrollSelection(projectPath, plan) {
  const { id, ...content } = plan;
  if (hash(content) !== id) throw new Error('B-roll selection fingerprint mismatch');
  const path = brollSelectionPath(projectPath, id);
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error('Existing B-roll selection differs');
    return path;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(plan, null, 2), { flag: 'wx' }); await rename(temporary, path); }
  catch (error) { try { await unlink(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; } throw error; }
  return path;
}

export async function readBrollSelection(projectPath, id) {
  const plan = JSON.parse(await readFile(brollSelectionPath(projectPath, id), 'utf8'));
  const { id: actualId, ...content } = plan;
  if (actualId !== id || hash(content) !== id) throw new Error('B-roll selection fingerprint mismatch');
  return plan;
}
