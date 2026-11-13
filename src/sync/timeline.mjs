import { currentSync, requireSync, recordersOf, videosOf, sessionRate, secondsPerFrame } from './session.mjs';

export function mediaSources(project) {
  const fps = sessionRate(project), frameSeconds = secondsPerFrame(fps);
  return Object.fromEntries(project.media.map(asset => {
    let audioTrack = 1;
    for (const stream of asset.audio) {
      if (stream.index === asset.selectedAudio?.streamIndex) { audioTrack += asset.selectedAudio.channel; break; }
      audioTrack += stream.channels;
    }
    return [asset.id, { path: asset.path, filename: asset.filename, fps,
      frames: asset.video ? asset.video.frames ?? Math.floor(asset.duration / frameSeconds + 1e-7) : Math.ceil(asset.duration / frameSeconds - 1e-7),
      width: asset.video?.width, height: asset.video?.height, hasVideo: Boolean(asset.video),
      channels: asset.audio.reduce((sum, stream) => sum + stream.channels, 0), audioTrack,
      videoIndex: asset.video?.index, audioIndex: asset.selectedAudio?.streamIndex,
      audioChannel: asset.selectedAudio?.channel, durationMs: asset.duration * 1000 }];
  }));
}

// Partition a camera interval at recorder boundaries. Source times are seconds
// until export; adjacent boundaries are rounded together to avoid one-frame holes.
export function dialogueSegments(project, videoId, start, end) {
  const video = project.media.find(asset => asset.id === videoId && asset.video);
  if (!video || start < 0 || end <= start || end > video.duration + 0.002) throw new Error('Invalid dialogue interval');
  const sync = currentSync(project);
  if (!recordersOf(project).length) return [{ mediaId: videoId, start, end, offset: 0, fallback: false }];
  if (!sync) throw new Error('Synchronize the recordings first');
  const videoStart = sync.placements.find(p => p.mediaId === videoId).startSeconds;
  const sessionStart = videoStart + start, sessionEnd = videoStart + end;
  const recorders = recordersOf(project).map(asset => ({ asset,
    start: sync.placements.find(p => p.mediaId === asset.id).startSeconds }));
  const boundaries = [...new Set([sessionStart, sessionEnd, ...recorders.flatMap(({ asset, start }) =>
    [start, start + asset.duration]).filter(time => time > sessionStart && time < sessionEnd)])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((time, i) => {
    const next = boundaries[i + 1];
    const recorder = recorders.find(r => r.start <= time + 1e-7 && r.start + r.asset.duration >= next - 1e-7);
    if (!recorder && !video.selectedAudio) throw new Error(`${video.filename}: no audio covers this interval`);
    const sourceStart = recorder?.start ?? videoStart;
    return { mediaId: recorder?.asset.id ?? videoId, start: time - sourceStart, end: next - sourceStart,
      offset: time - sessionStart, fallback: !recorder };
  });
}

export function attachDialogue(project, timeline, { accepted = true } = {}) {
  requireSync(project, { accepted });
  if (!recordersOf(project).length) return timeline;
  const frameSeconds = secondsPerFrame(timeline.fps);
  const sources = mediaSources(project);
  const audioIntervals = [];
  const guideIntervals = [];
  for (const clip of timeline.intervals) {
    const parts = dialogueSegments(project, clip.sourceId, clip.inFrame * frameSeconds, clip.outFrame * frameSeconds);
    for (const part of parts) {
      const start = clip.start + Math.round(part.offset / frameSeconds);
      const end = Math.min(clip.end, clip.start + Math.round((part.offset + part.end - part.start) / frameSeconds));
      if (end <= start) continue;
      // A split boundary can round differently in source and sequence time.
      // Keep the rounded interval inside the original file without changing
      // its sequence duration or opening a one-frame gap.
      const inFrame = Math.max(0, Math.min(Math.round(part.start / frameSeconds), sources[part.mediaId].frames - (end - start)));
      audioIntervals.push({ sourceId: part.mediaId, inFrame, outFrame: inFrame + end - start,
        start, end, linkGroup: clip.linkGroup, fallback: part.fallback });
      const camera = project.media.find(asset => asset.id === clip.sourceId);
      if (camera.selectedAudio && !part.fallback) guideIntervals.push({ sourceId: clip.sourceId,
        inFrame: clip.inFrame + start - clip.start, outFrame: clip.inFrame + end - clip.start,
        start, end, enabled: false, linkGroup: clip.linkGroup });
    }
  }
  return { ...timeline, audioTracks: [guideIntervals, audioIntervals], synchronizationId: project.synchronization.inputId };
}

export function compileSyncReview(project) {
  const sync = requireSync(project, { accepted: false });
  if (!sync) throw new Error('Import external audio before synchronizing');
  const fps = sessionRate(project), frameSeconds = secondsPerFrame(fps);
  const sources = mediaSources(project);
  const placements = new Map(sync.placements.map(p => [p.mediaId, p.startSeconds]));
  const intervals = videosOf(project).map((asset, i) => {
    const start = Math.round(placements.get(asset.id) / frameSeconds);
    return { sourceId: asset.id, inFrame: 0, outFrame: sources[asset.id].frames,
      start, end: start + sources[asset.id].frames, linkGroup: `sync-${i}` };
  });
  const recorderIntervals = recordersOf(project).map(asset => {
    const start = Math.round(placements.get(asset.id) / frameSeconds);
    return { sourceId: asset.id, inFrame: 0, outFrame: sources[asset.id].frames,
      start, end: start + sources[asset.id].frames };
  });
  const duration = Math.max(...intervals.map(p => p.end), ...recorderIntervals.map(p => p.end));
  const guide = intervals.filter(p => sources[p.sourceId].channels).map(p => ({ ...p, enabled: false }));
  // Overlapping recorder files occupy separate lanes and cannot overwrite each other.
  const lanes = [];
  for (const clip of recorderIntervals.sort((a, b) => a.start - b.start)) {
    let lane = lanes.find(items => items.at(-1).end <= clip.start);
    if (!lane) { lane = []; lanes.push(lane); }
    lane.push(clip);
  }
  return { sources, timeline: { fps, intervals, audioTracks: [guide, ...lanes], duration,
    width: project.settings.width, height: project.settings.height, name: `${project.name} · Sync review` } };
}
