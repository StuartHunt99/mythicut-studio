import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { premiereXml } from './premiere-xml.mjs';
import { fcpPathUrl } from './fcp-pathurl.mjs';

const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const finite = value => Number.isFinite(value) ? Number(value.toFixed(6)) : NaN;
const shortId = value => createHash('sha256').update(value).digest('hex').slice(0, 12);

export function cropToPremiereMotion(crop, image, output) {
  if (!crop || ![crop.x, crop.y, crop.width, crop.height, crop.centerX, crop.centerY,
    image?.width, image?.height, output?.width, output?.height].every(Number.isFinite) ||
    crop.width <= 0 || crop.height <= 0 || image.width <= 0 || image.height <= 0 ||
    output.width <= 0 || output.height <= 0 || crop.x < -1e-9 || crop.y < -1e-9 ||
    crop.x + crop.width > 1 + 1e-9 || crop.y + crop.height > 1 + 1e-9) throw new Error('Invalid B-roll crop');
  const scale = output.width / (image.width * crop.width);
  const verticalScale = output.height / (image.height * crop.height);
  if (Math.abs(scale - verticalScale) > 1e-6) throw new Error('B-roll crop does not match output aspect ratio');
  return { scale: finite(scale * 100), x: finite((0.5 - crop.centerX) * scale),
    y: finite((0.5 - crop.centerY) * scale) };
}

function parameter(id, name, start, end, duration, point = false) {
  const value = item => point ? `<value><horiz>${item.x}</horiz><vert>${item.y}</vert></value>` : `<value>${item}</value>`;
  return `<parameter><parameterid>${id}</parameterid><name>${name}</name><interpolation><name>FCPCurve</name></interpolation>` +
    `<keyframe><when>0</when>${value(start)}</keyframe><keyframe><when>${duration}</when>${value(end)}</keyframe></parameter>`;
}

function stillXml(clip, trackIndex, index, timeline, rate) {
  const duration = clip.end - clip.start;
  if (!Number.isSafeInteger(clip.start) || !Number.isSafeInteger(clip.end) || clip.start < 0 ||
      duration <= 0 || clip.end > timeline.duration) throw new Error('Invalid B-roll clip interval');
  const start = cropToPremiereMotion(clip.geometry?.startCrop, clip, timeline);
  const end = cropToPremiereMotion(clip.geometry?.endCrop, clip, timeline);
  if ([start, end].some(item => item.scale <= 0 || item.scale > 1000 || Math.abs(item.x) > 1 || Math.abs(item.y) > 1)) {
    throw new Error('Invalid B-roll Basic Motion endpoint');
  }
  const id = `broll-${trackIndex}-${index}-${shortId(`${clip.imageId}:${clip.path}`)}`;
  const sample = `${rate}<width>${clip.width}</width><height>${clip.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>`;
  const file = `<file id="${id}-file"><name>${esc(basename(clip.path))}</name><pathurl>${esc(fcpPathUrl(clip.path))}</pathurl>${rate}<duration>${timeline.duration}</duration><media><video><samplecharacteristics>${sample}</samplecharacteristics></video></media></file>`;
  const motion = `<filter><effect id="basicmotion"><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>` +
    parameter('scale', 'Scale', start.scale, end.scale, duration) + parameter('center', 'Center', start, end, duration, true) + '</effect></filter>';
  return `<clipitem id="${id}"><name>${esc(clip.filename)}</name><duration>${timeline.duration}</duration>${rate}<start>${clip.start}</start><end>${clip.end}</end><in>0</in><out>${duration}</out><stillframe>TRUE</stillframe>${file}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>${motion}<enabled>TRUE</enabled></clipitem>`;
}

export function premiereBrollXml(broll) {
  const { timeline, sources, tracks } = broll;
  const base = premiereXml(timeline, sources);
  const fps = timeline.fps;
  const ntsc = fps.denominator === 1001;
  const rate = `<rate><timebase>${ntsc ? fps.numerator / 1000 : fps.numerator}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const extra = tracks.map((clips, trackIndex) => {
    const sorted = [...clips].sort((a, b) => a.start - b.start);
    if (sorted.some((clip, index) => index && clip.start < sorted[index - 1].end)) throw new Error('B-roll clips overlap on one track');
    return `<track>${sorted.map((clip, index) => stillXml(clip, trackIndex + 2, index, timeline, rate)).join('')}</track>`;
  }).join('');
  const marker = '</track></video><audio><numOutputChannels>';
  if (base.split(marker).length !== 2) throw new Error('Unexpected phase-1 Premiere XML structure');
  return base.replace(marker, `</track>${extra}</video><audio><numOutputChannels>`);
}
