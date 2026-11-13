import { createHash } from 'node:crypto';

export const videosOf = project => project.media.filter(asset => asset.video);
export const recordersOf = project => project.media.filter(asset => !asset.video);
export const secondsPerFrame = fps => fps.denominator / fps.numerator;

export function orderRecordings(media) {
  return [true, false].flatMap(video => {
    const group = media.filter(asset => Boolean(asset.video) === video);
    const timestamps = group.every(asset => Number.isFinite(Date.parse(asset.recordedAt)));
    return group.sort((a, b) => (timestamps ? Date.parse(a.recordedAt) - Date.parse(b.recordedAt) : 0) ||
      a.filename.localeCompare(b.filename, 'en', { numeric: true }));
  });
}

// Script edits and editorial choices do not invalidate acoustic evidence.
export function syncInputId(project) {
  const inputs = project.media.map(({ id, identity, duration, video, audio, selectedAudio }) =>
    ({ id, identity, duration, video, audio, selectedAudio }));
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function currentSync(project) {
  const sync = project.synchronization;
  return sync?.inputId === syncInputId(project) ? sync : null;
}

export function requireSync(project, { accepted = true } = {}) {
  if (!recordersOf(project).length) return null;
  const sync = currentSync(project);
  if (!sync || sync.issues.length || (accepted && !sync.accepted)) {
    throw new Error('Synchronize the recordings and resolve the highlighted files in Import before continuing.');
  }
  return sync;
}

export function sessionRate(project) {
  const video = videosOf(project)[0];
  if (!video) throw new Error('Import at least one video recording.');
  const [numerator, denominator] = video.video.frameRate.split('/').map(Number);
  if (![numerator, denominator].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid video frame rate');
  for (const asset of videosOf(project)) {
    const [n, d] = asset.video.frameRate.split('/').map(Number);
    if (n * denominator !== numerator * d || asset.video.variableFrameRate) {
      throw new Error('Synchronization export currently requires matching constant video frame rates.');
    }
  }
  return { numerator, denominator };
}

export function validateSync(sync, project) {
  if (sync === undefined) return;
  if (sync?.schemaVersion !== 1 || typeof sync.inputId !== 'string' || typeof sync.accepted !== 'boolean' ||
      !Array.isArray(sync.placements) || !Array.isArray(sync.issues) || !Array.isArray(sync.matches)) throw new Error('Invalid synchronization map');
  const ids = new Set(project.media.map(asset => asset.id));
  const seen = new Set();
  for (const placement of sync.placements) {
    if (!ids.has(placement.mediaId) || seen.has(placement.mediaId) || !Number.isFinite(placement.startSeconds) ||
        placement.startSeconds < 0 || placement.rate !== 1) throw new Error('Invalid synchronization placement');
    seen.add(placement.mediaId);
  }
  if (seen.size !== ids.size || (sync.accepted && sync.issues.length)) throw new Error('Incomplete synchronization map');
}

// Convert acoustic relationships into positions. Every component retains its
// own origin until an acoustic bridge or a user adjustment locates it.
export function solveSession(project, matches) {
  const placed = new Map();
  let component = 0;
  const edges = [...matches].sort((a, b) => b.confidence - a.confidence);
  for (const asset of project.media) {
    if (placed.has(asset.id)) continue;
    placed.set(asset.id, { mediaId: asset.id, startSeconds: 0, rate: 1, component });
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        const a = placed.get(edge.a), b = placed.get(edge.b);
        if (Boolean(a) === Boolean(b)) continue;
        const known = a ?? b;
        if (known.component !== component) continue;
        const mediaId = a ? edge.b : edge.a;
        placed.set(mediaId, { mediaId, startSeconds: known.startSeconds + (a ? edge.offset : -edge.offset), rate: 1, component });
        changed = true;
      }
    }
    const members = [...placed.values()].filter(p => p.component === component);
    const origin = Math.min(...members.map(p => p.startSeconds));
    for (const p of members) p.startSeconds -= origin;
    component++;
  }
  const sync = { schemaVersion: 1, inputId: syncInputId(project), accepted: false,
    createdAt: new Date().toISOString(), placements: [...placed.values()], matches, issues: [] };
  sync.issues = sessionIssues(project, sync);
  return sync;
}

export function sessionIssues(project, sync) {
  const issues = [];
  const byId = new Map(sync.placements.map(p => [p.mediaId, p]));
  const components = new Set(sync.placements.map(p => p.component));
  const anchored = new Set(sync.placements.filter(p => p.manual).map(p => p.component));
  const first = sync.placements[0]?.component;
  if (components.size > 1) {
    for (const p of sync.placements) if (p.component !== first && !anchored.has(p.component)) {
      issues.push({ mediaId: p.mediaId, kind: 'unplaced', message: 'No reliable connection. Set its session start or remove this file.' });
    }
  }
  for (const match of sync.matches) {
    if (match.driftSeconds > 0.02) issues.push({ mediaId: match.b, kind: 'drift', message: `Clock drift of ${(match.driftSeconds * 1000).toFixed(0)} ms needs correction; an offset alone cannot synchronize this recording.` });
    const residual = Math.abs(byId.get(match.b).startSeconds - byId.get(match.a).startSeconds - match.offset);
    if (residual > 0.04 && !byId.get(match.a).manual && !byId.get(match.b).manual) {
      issues.push({ mediaId: match.b, kind: 'conflict', message: 'The acoustic matches disagree. Review this start position.' });
    }
  }
  for (const group of [videosOf(project), recordersOf(project)]) {
    for (let i = 1; i < group.length; i++) {
      const before = byId.get(group[i - 1].id), after = byId.get(group[i].id);
      const located = p => p.component === first || anchored.has(p.component);
      const comparable = before.component === after.component || (located(before) && located(after));
      if (comparable && after.startSeconds < before.startSeconds - 0.02) {
        issues.push({ mediaId: group[i].id, kind: 'order', message: 'This match contradicts the recording order.' });
      }
      if (group[i].video && comparable && after.startSeconds < before.startSeconds + group[i - 1].duration - 0.04) {
        issues.push({ mediaId: group[i].id, kind: 'overlap', message: 'Sequential camera recordings overlap. Review their start positions.' });
      }
    }
  }
  // A silent camera needs continuous recorder coverage before analysis freezes
  // the inputs. Cameras with guide audio can fill recorder gaps themselves.
  for (const video of videosOf(project).filter(asset => !asset.selectedAudio)) {
    const start = byId.get(video.id).startSeconds, end = start + video.duration;
    let covered = start;
    const ranges = recordersOf(project).map(asset => {
      const position = byId.get(asset.id).startSeconds;
      return { start: position, end: position + asset.duration };
    }).sort((a, b) => a.start - b.start);
    for (const range of ranges) {
      if (range.start > covered + 0.002) break;
      covered = Math.max(covered, range.end);
    }
    if (covered < end - 0.002) issues.push({ mediaId: video.id, kind: 'coverage',
      message: 'External audio does not cover this silent camera recording. Adjust its position or import the missing audio.' });
  }
  return issues;
}

export function adjustSync(project, mediaId, startSeconds) {
  const previous = currentSync(project);
  if (!previous || !Number.isFinite(startSeconds) || startSeconds < 0) throw new Error('Invalid session start');
  const sync = structuredClone(previous);
  const item = sync.placements.find(p => p.mediaId === mediaId);
  if (!item) throw new Error('Unknown recording');
  const shift = startSeconds - item.startSeconds;
  const firstComponent = sync.placements[0].component;
  const members = item.component === firstComponent ? [item] : sync.placements.filter(p => p.component === item.component);
  for (const p of members) {
    p.startSeconds += shift;
    if (p.startSeconds < 0) throw new Error('The adjustment would place another recording before the session starts.');
    p.manual = true;
  }
  sync.accepted = false;
  sync.issues = sessionIssues(project, sync);
  return sync;
}
