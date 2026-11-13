import { frameRate } from './timeline.mjs';
import { fcpPathUrl } from './fcp-pathurl.mjs';

const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Video and audio have independent source references. Legacy timelines still
// use embedded audio; synchronized timelines supply explicit audio tracks.
export function premiereXml(timeline, sources) {
  const fps = frameRate(timeline.fps);
  const ntsc = fps.denominator === 1001 && [24000, 30000, 60000].includes(fps.numerator);
  if (fps.denominator !== 1 && !ntsc) throw new Error('Unsupported FCP7 frame rate');
  const rate = `<rate><timebase>${ntsc ? fps.numerator / 1000 : fps.numerator}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const width = timeline.width ?? 1920, height = timeline.height ?? 1080;
  if (![width,height].every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error('Invalid sequence dimensions');
  const videoCharacteristics = `${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>`;
  const file = (id) => {
    const source = sources[id];
    const characteristics = videoCharacteristics.replace(`<width>${width}</width>`, `<width>${source.width || 1920}</width>`).replace(`<height>${height}</height>`, `<height>${source.height || 1080}</height>`);
    const video = source.hasVideo === false ? '' : `<video><samplecharacteristics>${characteristics}</samplecharacteristics></video>`;
    return `<file id="${esc(id)}"><name>${esc(source.filename ?? `${id}.mov`)}</name><pathurl>${esc(fcpPathUrl(source.path))}</pathurl>${rate}<duration>${source.frames}</duration><media>${video}<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>${source.channels || 1}</channelcount></audio></media></file>`;
  };
  const audioTracks = timeline.audioTracks ?? [timeline.intervals];
  const tracks = [{ type: 'video', index: 1, clips: timeline.intervals },
    ...audioTracks.map((clips, i) => ({ type: 'audio', index: i + 1, clips }))];
  const entries = tracks.flatMap(track => track.clips.map((clip, i) => ({ ...track, clip, clipIndex: i + 1,
    id: `${track.type}-${track.index === 1 ? '' : `${track.index}-`}${i}`,
    group: clip.linkGroup ?? (timeline.audioTracks ? null : `legacy-${i}`) })));
  const track = (type, index = 1) => entries.filter(entry => entry.type === type && entry.index === index).map(entry => {
    const { clip, id } = entry;
    const source = sources[clip.sourceId];
    if (!source || ![clip.start, clip.end, clip.inFrame, clip.outFrame].every(Number.isSafeInteger) ||
        clip.start < 0 || clip.end > timeline.duration || clip.end <= clip.start || clip.inFrame < 0 ||
        clip.outFrame > source.frames || clip.outFrame - clip.inFrame !== clip.end - clip.start) throw new Error('Invalid XML source interval');
    const links = entry.group === null ? '' : entries.filter(other => other.group === entry.group).map(other =>
      `<link><linkclipref>${other.id}</linkclipref><mediatype>${other.type}</mediatype><trackindex>${other.index}</trackindex><clipindex>${other.clipIndex}</clipindex></link>`).join('');
    const scale = 100 * Math.max(width / (source.width || 1920), height / (source.height || 1080));
    const motion = type === 'video' && scale !== 100 ? `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>scale</parameterid><name>Scale</name><value>${scale}</value></parameter></effect></filter>` : '';
    return `<clipitem id="${id}"><name>${esc(source.filename ?? clip.sourceId)}</name><duration>${source.frames}</duration>${rate}<start>${clip.start}</start><end>${clip.end}</end><in>${clip.inFrame}</in><out>${clip.outFrame}</out>${file(clip.sourceId)}<sourcetrack><mediatype>${type}</mediatype><trackindex>${type === 'audio' ? source.audioTrack ?? 1 : 1}</trackindex></sourcetrack>${links}${motion}<enabled>${clip.enabled === false ? 'FALSE' : 'TRUE'}</enabled></clipitem>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="mythicut-m0"><name>${esc(timeline.name ?? 'MythiCut rough cut')}</name><duration>${timeline.duration}</duration>${rate}<media><video><format><samplecharacteristics>${videoCharacteristics}</samplecharacteristics></format><track>${track('video')}</track></video><audio><numOutputChannels>1</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audioTracks.map((_, i) => `<track>${track('audio', i + 1)}</track>`).join('')}</audio></media></sequence></xmeml>\n`;
}
