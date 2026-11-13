import { dialogueSegments } from './timeline.mjs';
import { requireSync } from './session.mjs';
import { stat } from 'node:fs/promises';

// This WAV is an analysis/playback cache, never an exported replacement for
// original media. Sample counts keep camera-local transcript timestamps stable.
export async function renderDialogue(project, videoId, start, end, output, { tool, signal, sampleRate = 16000, segments } = {}) {
  requireSync(project);
  const parts = segments ?? dialogueSegments(project, videoId, start, end);
  const inputs = [...new Set(parts.map(part => part.mediaId))].map(id => project.media.find(asset => asset.id === id));
  for (const asset of inputs) {
    const identity = await stat(asset.path);
    if (identity.size !== asset.identity.size || identity.mtimeMs !== asset.identity.mtimeMs) throw new Error(`${asset.filename}: recording changed since import`);
  }
  const filters = parts.map((part, index) => {
    const asset = project.media.find(asset => asset.id === part.mediaId);
    const input = inputs.indexOf(asset);
    const samples = Math.round((part.offset + part.end - part.start) * sampleRate) - Math.round(part.offset * sampleRate);
    return `[${input}:${asset.selectedAudio.streamIndex}]atrim=start=${part.start}:end=${part.end},asetpts=PTS-STARTPTS,pan=mono|c0=c${asset.selectedAudio.channel},aresample=${sampleRate},apad,atrim=end_sample=${samples}[part${index}]`;
  });
  filters.push(`${parts.map((_, i) => `[part${i}]`).join('')}concat=n=${parts.length}:v=0:a=1,apad,atrim=end_sample=${Math.round((end - start) * sampleRate)}[dialogue]`);
  await tool('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...inputs.flatMap(asset => ['-i', asset.path]),
    '-filter_complex', filters.join(';'), '-map', '[dialogue]', '-c:a', 'pcm_s16le', '-ar', String(sampleRate), output], { signal });
}
