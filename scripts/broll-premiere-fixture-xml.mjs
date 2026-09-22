import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// M0-only interchange experiment. Do not use for production export until its
// still-image and Basic Motion semantics are confirmed by a Premiere import.
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const number = value => Number.isFinite(value) ? Number(value.toFixed(6)) : NaN;
const shortId = value => createHash('sha256').update(value).digest('hex').slice(0, 12);

function motionParameter(id, label, start, end, duration, point = false) {
  const value = item => point
    ? `<value><horiz>${number(item.x)}</horiz><vert>${number(item.y)}</vert></value>`
    : `<value>${number(item)}</value>`;
  return `<parameter><parameterid>${id}</parameterid><name>${label}</name><interpolation><name>FCPCurve</name></interpolation>` +
    `<keyframe><when>0</when>${value(start)}</keyframe><keyframe><when>${duration}</when>${value(end)}</keyframe></parameter>`;
}

function artworkClip(clip, index, trackIndex, { rate, sequenceDuration }) {
  const duration = clip.end - clip.start;
  if (!Number.isSafeInteger(clip.start) || !Number.isSafeInteger(clip.end) || clip.start < 0 || duration <= 0 || clip.end > sequenceDuration) throw new Error('Invalid artwork interval');
  if (!clip.path || !Number.isSafeInteger(clip.width) || !Number.isSafeInteger(clip.height) || clip.width <= 0 || clip.height <= 0) throw new Error('Invalid artwork source');
  // FCP7 XML center coordinates are fractions of source dimensions, not percentages.
  // E.g. x=-0.05 moves a 2560px still by roughly 128px in Premiere.
  for (const endpoint of [clip.motion?.start, clip.motion?.end]) {
    if (!endpoint || !Number.isFinite(endpoint.scale) || endpoint.scale <= 0 || endpoint.scale > 1000 || !Number.isFinite(endpoint.x) || !Number.isFinite(endpoint.y) || Math.abs(endpoint.x) > 1 || Math.abs(endpoint.y) > 1) throw new Error('Invalid Basic Motion endpoint');
  }
  // Premiere can reuse a prior import's media when different XML files share IDs.
  const id = `fixture-art-${trackIndex}-${index}-${shortId(clip.path)}`;
  const sample = `${rate}<width>${clip.width}</width><height>${clip.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>`;
  const file = `<file id="${id}-file"><name>${esc(basename(clip.path))}</name><pathurl>${esc(pathToFileURL(clip.path).href)}</pathurl>${rate}<duration>${sequenceDuration}</duration><media><video><samplecharacteristics>${sample}</samplecharacteristics></video></media></file>`;
  const scale = motionParameter('scale', 'Scale', clip.motion.start.scale, clip.motion.end.scale, duration);
  const center = motionParameter('center', 'Center', { x: clip.motion.start.x, y: clip.motion.start.y }, { x: clip.motion.end.x, y: clip.motion.end.y }, duration, true);
  const motion = `<filter><effect id="basicmotion"><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${scale}${center}</effect></filter>`;
  return `<clipitem id="${id}"><name>${esc(clip.name ?? basename(clip.path))}</name><duration>${sequenceDuration}</duration>${rate}<start>${clip.start}</start><end>${clip.end}</end><in>0</in><out>${duration}</out><stillframe>TRUE</stillframe>${file}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>${motion}<enabled>TRUE</enabled></clipitem>`;
}

export function brollPremiereFixtureXml(timeline, sources, tracks, { audioPath } = {}) {
  if (!Array.isArray(tracks) || !tracks.length) throw new Error('At least one artwork track is required');
  const fps = timeline.fps;
  const numerator = typeof fps === 'number' ? fps : fps.numerator;
  const denominator = typeof fps === 'number' ? 1 : fps.denominator;
  const ntsc = denominator === 1001 && [24000, 30000, 60000].includes(numerator);
  if (!ntsc && denominator !== 1) throw new Error('Unsupported fixture rate');
  const rate = `<rate><timebase>${ntsc ? numerator / 1000 : numerator}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const rendered = tracks.map((clips, trackIndex) => {
    if (!Array.isArray(clips)) throw new Error('Artwork track must be a clip array');
    const sorted = [...clips].sort((a, b) => a.start - b.start);
    if (sorted.some((clip, index) => index && clip.start < sorted[index - 1].end)) throw new Error('Artwork overlaps within one track');
    return `<track>${sorted.map((clip, index) => artworkClip(clip, index, trackIndex + 2, { rate, sequenceDuration: timeline.duration })).join('')}</track>`;
  }).join('');
  const width = timeline.width ?? 1920;
  const height = timeline.height ?? 1080;
  const sequenceSample = `${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>`;
  const hostTrack = `<track>${timeline.intervals.map((clip, index) => {
    const source = sources[clip.sourceId];
    if (!source?.path || !source.width || !source.height) throw new Error('Invalid diagnostic host still');
    const sourceSample = `${rate}<width>${source.width}</width><height>${source.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>`;
    const hostId = `fixture-host-${index}-${shortId(source.path)}`;
    const file = `<file id="${hostId}-file"><name>${esc(basename(source.path))}</name><pathurl>${esc(pathToFileURL(source.path).href)}</pathurl>${rate}<duration>${timeline.duration}</duration><media><video><samplecharacteristics>${sourceSample}</samplecharacteristics></video></media></file>`;
    return `<clipitem id="${hostId}"><name>Diagnostic host ${index + 1}</name><duration>${timeline.duration}</duration>${rate}<start>${clip.start}</start><end>${clip.end}</end><in>0</in><out>${clip.end - clip.start}</out><stillframe>TRUE</stillframe>${file}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack><enabled>TRUE</enabled></clipitem>`;
  }).join('')}</track>`;
  const audio = audioPath
    ? `<track><clipitem id="fixture-audio-${shortId(audioPath)}"><name>Continuous diagnostic tone</name><duration>${timeline.duration}</duration>${rate}<start>0</start><end>${timeline.duration}</end><in>0</in><out>${timeline.duration}</out><file id="fixture-audio-file-${shortId(audioPath)}"><name>${esc(basename(audioPath))}</name><pathurl>${esc(pathToFileURL(audioPath).href)}</pathurl>${rate}<duration>${timeline.duration}</duration><media><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>1</channelcount></audio></media></file><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack><enabled>TRUE</enabled></clipitem></track>`
    : '<track></track>';
  const sequenceId = shortId(JSON.stringify({ name: timeline.name, sources, tracks, audioPath }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="mythicut-m0-broll-${sequenceId}"><name>${esc(timeline.name ?? 'MythiCut M0 B-roll fixture')}</name><duration>${timeline.duration}</duration>${rate}<media><video><format><samplecharacteristics>${sequenceSample}</samplecharacteristics></format>${hostTrack}${rendered}</video><audio><numOutputChannels>1</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audio}</audio></media></sequence></xmeml>\n`;
}
