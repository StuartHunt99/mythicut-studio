import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { compileTimeline } from '../src/timeline.mjs';
import { brollPremiereFixtureXml } from './broll-premiere-fixture-xml.mjs';

async function diagnosticStill(path, width, height, background, label) {
  const fontSize = Math.max(40, Math.round(width / 22));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="${background}"/>
    <rect x="0" y="0" width="25%" height="100%" fill="#ffffff" opacity=".15"/>
    <rect x="75%" y="0" width="25%" height="100%" fill="#000000" opacity=".2"/>
    <circle cx="${Math.round(width * .72)}" cy="${Math.round(height * .48)}" r="${Math.round(Math.min(width, height) * .13)}" fill="#ffe08a"/>
    <line x1="${width / 2}" x2="${width / 2}" y1="0" y2="${height}" stroke="#ffffff" stroke-width="6" opacity=".8"/>
    <text x="${Math.round(width * .04)}" y="${fontSize * 1.3}" fill="#ffffff" font-family="Arial" font-size="${fontSize}" font-weight="bold">${label}</text>
    <text x="${Math.round(width * .04)}" y="${height - fontSize}" fill="#ffffff" font-family="Arial" font-size="${Math.round(fontSize * .55)}">${width} x ${height} | subject at 72% width</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
}

async function diagnosticTone(path, seconds = 12) {
  const sampleRate = 48000;
  const samples = sampleRate * seconds;
  const output = Buffer.alloc(44 + samples * 2);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34); output.write('data', 36); output.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) output.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * index / sampleRate)), 44 + index * 2);
  await writeFile(path, output);
}

const artifactsRoot = resolve('artifacts');
const distinctPan = process.argv.includes('--distinct-pan');
await mkdir(artifactsRoot, { recursive: true });
const output = await mkdtemp(join(artifactsRoot, 'm0-broll-'));
const host = join(output, 'synthetic-host.png');
const tone = join(output, 'continuous-tone.wav');

const landscape = join(output, 'landscape-zoom-in.png');
const portrait = join(output, 'portrait-zoom-out.png');
const pan = join(output, 'landscape-pan.png');
const replacement = join(output, 'sparse-override.png');
await Promise.all([
  diagnosticStill(host, 1920, 1080, '#314659', 'V1  DIAGNOSTIC HOST'),
  diagnosticTone(tone),
  diagnosticStill(landscape, 2560, 1440, '#285d82', 'V2  ZOOM IN'),
  diagnosticStill(portrait, 1200, 2000, '#754c89', 'V2  ZOOM OUT'),
  diagnosticStill(pan, 2560, 1440, distinctPan ? '#a8227d' : '#287d65', distinctPan ? 'V2  DISTINCT PAN' : 'V2  PAN RIGHT'),
  diagnosticStill(replacement, 2560, 1440, '#a65a38', 'V3  SPARSE OVERRIDE')
]);

const sources = { host: { path: host, fps: 30, frames: 360, width: 1920, height: 1080 } };
const timeline = { ...compileTimeline([{ sourceId: 'host', inFrame: 0, outFrame: 180 }, { sourceId: 'host', inFrame: 180, outFrame: 360 }], sources), width: 1920, height: 1080, name: distinctPan ? 'MythiCut M0 distinct-pan fixture' : 'MythiCut M0 B-roll motion fixture' };
const tracks = [
  [
    { name: 'V2 landscape zoom in', path: landscape, width: 2560, height: 1440, start: 0, end: 120, motion: { start: { scale: 75, x: 0, y: 0 }, end: { scale: 90, x: -0.05, y: 0 } } },
    { name: 'V2 portrait zoom out', path: portrait, width: 1200, height: 2000, start: 120, end: 240, motion: { start: { scale: 190, x: 0, y: 0 }, end: { scale: 160, x: 0, y: 0 } } },
    { name: 'V2 landscape pan', path: pan, width: 2560, height: 1440, start: 240, end: 360, motion: { start: { scale: 90, x: -0.05, y: 0 }, end: { scale: 90, x: 0.05, y: 0 } } }
  ],
  [
    { name: 'V3 sparse replacement only', path: replacement, width: 2560, height: 1440, start: 180, end: 240, motion: { start: { scale: 75, x: 0, y: 0 }, end: { scale: 85, x: -0.03, y: 0 } } }
  ]
];
const xmlPath = join(output, 'm0-broll-premiere.xml');
await writeFile(xmlPath, brollPremiereFixtureXml(timeline, sources, tracks, { audioPath: tone }));
const manifest = {
  purpose: 'M0 Premiere import experiment; generated diagnostic stills and tone, not original user artwork or phase-1 video',
  distinctPan,
  sequence: { width: 1920, height: 1080, fps: 30, frames: 360, seconds: 12 },
  expected: [
    'V1 has two contiguous diagnostic host-still intervals and A1 has a continuous 440 Hz tone. Source-video interchange is not tested here.',
    'V2 has three directly referenced, editable stills: zoom in 0-4 s, zoom out 4-8 s, pan 8-12 s.',
    'V3 contains only one override from 6-8 s, visibly replacing the end of the V2 portrait still.',
    'Every boundary is a hard cut. The V2 clip remains beneath the V3 override.',
    'Effect Controls exposes editable scale and position keyframes on each still.'
  ],
  files: { xml: xmlPath, host, tone, landscape, portrait, pan, replacement },
  premiereImportVerified: false
};
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ outputDirectory: output, ...manifest }, null, 2));
