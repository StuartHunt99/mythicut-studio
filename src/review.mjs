import { createHash } from 'node:crypto';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = () => ({ decisions: {}, wordOverrides: {} });
export function reviewIdentity(result) {
  return createHash('sha256').update(JSON.stringify([result.projectId, result.inputId, result.words.map(w => [w.id, w.mediaId, w.text, w.startMs, w.endMs])])).digest('hex');
}
function validateSelections(value) {
  if (!plain(value) || !plain(value.decisions) || !plain(value.wordOverrides ?? {})) throw new Error('Invalid review state');
  for (const d of Object.values(value.decisions)) if (!plain(d) || !['approve', 'reject'].includes(d.action) || (d.action === 'approve' && typeof d.candidateId !== 'string')) throw new Error('Invalid sentence decision');
  for (const action of Object.values(value.wordOverrides ?? {})) if (!['keep', 'remove'].includes(action)) throw new Error('Invalid word selection');
  return { decisions: structuredClone(value.decisions), wordOverrides: { ...(value.wordOverrides ?? {}) } };
}
export function validateReview(review = empty()) {
  const current = validateSelections(review);
  const history = review.history ?? { entries: [], cursor: 0 };
  if (!plain(history) || !Array.isArray(history.entries) || !Number.isSafeInteger(history.cursor) || history.cursor < 0 || history.cursor > history.entries.length || !Number.isSafeInteger(review.revision ?? 0) || (review.revision ?? 0) < 0 || (review.analysisId !== undefined && typeof review.analysisId !== 'string')) throw new Error('Invalid review history');
  return { ...current, revision: review.revision ?? 0, ...(review.analysisId ? { analysisId: review.analysisId } : {}), history: { cursor: history.cursor, entries: history.entries.map(e => ({ before: validateSelections(e.before), after: validateSelections(e.after) })) } };
}
function checked(review, result) {
  const state = validateReview(review);
  const identity = reviewIdentity(result);
  if (state.analysisId && state.analysisId !== identity) throw new Error('Review belongs to different transcript evidence; reopen the matching analysis before editing');
  const wordIds = new Set(result.words.map(w => w.id));
  for (const id of Object.keys(state.wordOverrides)) if (!wordIds.has(id)) throw new Error('Unknown reviewed word');
  for (const [id, d] of Object.entries(state.decisions)) {
    const choice = result.takeSelection.find(c => c.sentence.id === id);
    if (!choice || (d.action === 'approve' && !choice.candidates.some(c => c.id === d.candidateId))) throw new Error('Unknown reviewed candidate');
  }
  return { ...state, analysisId: identity };
}
export function applyReviewCommand(review, result, command) {
  const state = checked(review, result);
  if (!command || command.analysisId !== state.analysisId || command.revision !== state.revision) throw new Error('Stale review command; refresh before editing');
  if (command.type === 'undo' || command.type === 'redo') {
    const undo = command.type === 'undo'; const index = state.history.cursor + (undo ? -1 : 0);
    const entry = state.history.entries[index];
    if (!entry) return state;
    return checked({ ...state, ...structuredClone(undo ? entry.before : entry.after), revision: state.revision + 1, history: { ...state.history, cursor: state.history.cursor + (undo ? -1 : 1) } }, result);
  }
  const before = validateSelections(state); const after = structuredClone(before);
  const effective = new Set(resolveReview(state, result).selectedWordIds);
  if (command.type === 'toggleWords') {
    if (!Array.isArray(command.wordIds) || !command.wordIds.length || new Set(command.wordIds).size !== command.wordIds.length) throw new Error('Invalid word toggle');
    const ids = new Set(result.words.map(w => w.id));
    if (command.wordIds.some(id => !ids.has(id))) throw new Error('Unknown word');
    for (const id of command.wordIds) {
      const action = effective.has(id) ? 'remove' : 'keep';
      Object.defineProperty(after.wordOverrides,id,{value:action,enumerable:true,writable:true,configurable:true});
    }
  } else if (command.type === 'sentenceToggle') {
    const choice = result.takeSelection.find(c => c.sentence.id === command.sentenceId);
    if (!choice) throw new Error('Invalid sentence command');
    const decision = state.decisions[command.sentenceId];
    const range = decision?.action === 'approve' ? choice.candidates.find(c => c.id === decision.candidateId) : choice.selected;
    if (!range) throw new Error('Sentence has no selectable words');
    const ids = result.words.slice(range.startIndex,range.endIndex+1).map(w=>w.id);
    const kept = ids.filter(id=>effective.has(id)).length;
    const target = kept === ids.length ? false : kept === 0 ? true : kept * 2 >= ids.length;
    for (const id of ids) Object.defineProperty(after.wordOverrides,id,{value:target?'keep':'remove',enumerable:true,writable:true,configurable:true});
  } else if (command.type === 'words') {
    if (!['keep','remove','reset'].includes(command.action) || !Array.isArray(command.wordIds) || !command.wordIds.length || new Set(command.wordIds).size !== command.wordIds.length) throw new Error('Invalid word command');
    const ids = new Set(result.words.map(w => w.id));
    if (command.wordIds.some(id => !ids.has(id))) throw new Error('Unknown word');
    for (const id of command.wordIds) command.action === 'reset' ? delete after.wordOverrides[id] : Object.defineProperty(after.wordOverrides,id,{value:command.action,enumerable:true,writable:true,configurable:true});
  } else if (command.type === 'sentence') {
    const choice = result.takeSelection.find(c => c.sentence.id === command.sentenceId);
    if (!choice || !['approve','reject','clear'].includes(command.action)) throw new Error('Invalid sentence command');
    if (command.action === 'approve' && !choice.candidates.some(c => c.id === command.candidateId)) throw new Error('Unknown candidate');
    if (command.action === 'clear') delete after.decisions[command.sentenceId];
    else Object.defineProperty(after.decisions,command.sentenceId,{value:{action:command.action,candidateId:command.action==='approve'?command.candidateId:null},enumerable:true,writable:true,configurable:true});
  } else throw new Error('Unknown review command');
  if (JSON.stringify(before) === JSON.stringify(after)) return state;
  const entries = state.history.entries.slice(0,state.history.cursor);
  entries.push({ before, after });
  return { ...state, ...after, revision: state.revision + 1, history: { entries, cursor: entries.length } };
}

export function resolveReview(review, result) {
  const state = checked(review, result);
  const owners = {}; const selected = new Set(); const ranges = [];
  for (const choice of result.takeSelection) {
    const decision = state.decisions[choice.sentence.id];
    const range = decision?.action === 'reject' ? null : decision?.action === 'approve' ? choice.candidates.find(c => c.id === decision.candidateId) : choice.selected;
    if (!range) continue;
    const words = result.words.slice(range.startIndex, range.endIndex + 1);
    if (words.length !== range.endIndex-range.startIndex+1 || words.some(w=>w.mediaId!==range.mediaId)) throw new Error('Invalid candidate word range');
    ranges.push({ sentenceId: choice.sentence.id, candidateId: range.id, wordIds: words.map(w=>w.id) });
    for (const w of words) { selected.add(w.id); owners[w.id] ??= choice.sentence.id; }
  }
  for (const [id,action] of Object.entries(state.wordOverrides)) action === 'keep' ? selected.add(id) : selected.delete(id);
  const selectedWordIds=result.words.filter(w=>selected.has(w.id)).map(w=>w.id);
  const selectionId=createHash('sha256').update(JSON.stringify([ranges,selectedWordIds])).digest('hex');
  return { analysisId: state.analysisId, selectionId, revision: state.revision, selectedWordIds, owners, ranges, overrides: state.wordOverrides, canUndo: state.history.cursor>0, canRedo: state.history.cursor<state.history.entries.length };
}
