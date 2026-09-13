import { pathToFileURL } from 'node:url';
import { frameRate } from './timeline.mjs';

const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// A deliberately small FCP7 XML experiment, pending real Premiere import validation.
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
    return `<file id="${esc(id)}"><name>${esc(id)}.mov</name><pathurl>${esc(pathToFileURL(source.path).href)}</pathurl>${rate}<duration>${source.frames}</duration><media><video><samplecharacteristics>${characteristics}</samplecharacteristics></video><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>${source.channels || 1}</channelcount></audio></media></file>`;
  };
  const links = i => ['video', 'audio'].map(type => `<link><linkclipref>${type}-${i}</linkclipref><mediatype>${type}</mediatype><trackindex>1</trackindex><clipindex>${i + 1}</clipindex></link>`).join('');
  const track = type => timeline.intervals.map((clip, i) => {
    const source = sources[clip.sourceId];
    const scale = 100 * Math.max(width / (source.width || 1920), height / (source.height || 1080));
    const motion = type === 'video' && scale !== 100 ? `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>scale</parameterid><name>Scale</name><value>${scale}</value></parameter></effect></filter>` : '';
    return `<clipitem id="${type}-${i}"><name>${esc(clip.sourceId)}</name><duration>${source.frames}</duration>${rate}<start>${clip.start}</start><end>${clip.end}</end><in>${clip.inFrame}</in><out>${clip.outFrame}</out>${file(clip.sourceId)}<sourcetrack><mediatype>${type}</mediatype><trackindex>${type === 'audio' ? source.audioTrack ?? 1 : 1}</trackindex></sourcetrack>${links(i)}${motion}<enabled>TRUE</enabled></clipitem>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="mythicut-m0"><name>${esc(timeline.name ?? 'MythiCut rough cut')}</name><duration>${timeline.duration}</duration>${rate}<media><video><format><samplecharacteristics>${videoCharacteristics}</samplecharacteristics></format><track>${track('video')}</track></video><audio><numOutputChannels>1</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format><track>${track('audio')}</track></audio></media></sequence></xmeml>\n`;
}
