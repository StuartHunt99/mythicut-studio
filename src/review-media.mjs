import { mkdir, stat, rename, writeFile, readFile, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTool } from './analysis.mjs';
import { compileReview } from './review-timeline.mjs';
import { premiereXml } from './premiere-xml.mjs';
import { compileBrollTimeline } from './broll-timeline.mjs';
import { premiereBrollXml } from './broll-xml.mjs';
import { buildEditHandoff } from './edit-handoff.mjs';
import { timedWords } from './word-timing.mjs';
const execute = promisify(execFile);
const previewVersion = 2;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function unchanged(asset) {
  const current=await stat(asset.path);
  if(current.size!==asset.identity.size || current.mtimeMs!==asset.identity.mtimeMs)throw new Error(`${asset.filename}: source changed since import`);
}
export async function exportReviewXml(project,result,destination) {
  const compiled=compileReview(project,result);
  for(const asset of project.media)await unchanged(asset);
  const pending=`${destination}.${randomUUID()}.tmp`;
  try {await writeFile(pending,premiereXml(compiled.timeline,compiled.sources));await rename(pending,destination);}
  finally {await rm(pending,{force:true});}
  return compiled;
}
export async function exportBrollXml(project, result, destination, { beatPlan, selection, motion, overrides, review, lockedHandoff }) {
  const compiled = compileReview(project, result);
  if (!lockedHandoff || beatPlan?.handoffId !== lockedHandoff.id ||
      buildEditHandoff(project, result).id !== lockedHandoff.id) throw new Error('B-roll plan is not based on the current locked edit');
  for (const asset of project.media) await unchanged(asset);
  const broll = compileBrollTimeline({ compiled, beatPlan, selection, motion, overrides, review });
  for (const path of new Set(broll.tracks.flatMap(track => track.map(clip => clip.path)))) {
    try { if ((await stat(path)).isFile()) continue; }
    catch { throw new Error(`Artwork file is missing: ${path}. Rescan or relocate its catalog root.`); }
    throw new Error(`Artwork file is missing: ${path}. Rescan or relocate its catalog root.`);
  }
  const xml = premiereBrollXml(broll);
  const pending = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(pending, xml); await rename(pending, destination); }
  finally { await rm(pending, { force: true }); }
  return { clipCount: broll.tracks.reduce((count, track) => count + track.length, 0),
    trackCount: broll.tracks.length, durationFrames: broll.timeline.duration };
}
export async function auditionWord(project, result, wordId, directory, {signal,tool=runTool}={}) {
  const word=timedWords(result).find(w=>w.id===wordId);
  const asset=word && project.media.find(a=>a.id===word.mediaId);
  if(!asset || !Number.isFinite(word.startMs) || word.startMs<0)throw new Error('Unknown or untimed source word');
  await unchanged(asset);
  // Source audition intentionally includes surrounding speech, independent of
  // keep/remove decisions. Its time labels are always original source times.
  const start=Math.max(0,word.startMs/1000-4),end=Math.min(asset.duration,word.startMs/1000+9);
  const key=createHash('sha256').update(JSON.stringify([asset.identity,asset.id,asset.selectedAudio,start,end])).digest('hex');
  await mkdir(directory,{recursive:true}); const path=join(directory,`${key}.mp4`);
  try {await stat(path);} catch(error) {
    if(error.code!=='ENOENT')throw error;
    const temp=join(directory,`${key}.${randomUUID()}.mp4`);
    await tool('ffmpeg',['-v','error','-nostdin','-y','-threads','2','-ss',String(start),'-i',asset.path,'-t',String(end-start),'-map',`0:${asset.video.index}`,'-map',`0:${asset.selectedAudio.streamIndex}`,'-vf','scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p','-af',`pan=mono|c0=c${asset.selectedAudio.channel}`,'-c:v','libx264','-threads','2','-preset','ultrafast','-crf','25','-c:a','aac','-ar','48000','-b:a','160k','-movflags','+faststart',temp],{signal});
    await rename(temp,path);
  }
  return {url:pathToFileURL(path).href,startSeconds:start,wordSeconds:word.startMs/1000-start,filename:asset.filename,wordId};
}
export async function buildReviewPreview(project,result,directory,{signal,tool=runTool,progress=()=>{}}={}) {
  const compiled=compileReview(project,result);
  for(const asset of project.media)await unchanged(asset);
  const identities=Object.fromEntries(project.media.map(asset=>[asset.id,asset.identity]));
  const key=fingerprint([previewVersion,compiled,identities]);
  const root=join(directory,key);await mkdir(root,{recursive:true});
  const manifest=join(root,'preview.json');
  try {const saved=JSON.parse(await readFile(manifest,'utf8'));await stat(join(root,'preview.mp4'));return saved;}catch(error){if(error.code && error.code!=='ENOENT')throw error;}
  const {timeline,sources}=compiled;
  const seconds=frame=>frame*timeline.fps.denominator/timeline.fps.numerator;
  // Encode clips serially so long projects do not open hundreds of 4K decoders.
  const paths=[];
  const width=640, height=Math.max(2,Math.round(width*timeline.height/timeline.width/2)*2);
  const segments=join(directory,'segments');await mkdir(segments,{recursive:true});
  for(const [index,clip] of timeline.intervals.entries()) {
    if(signal?.aborted)throw new Error('Preview canceled');
    const source=sources[clip.sourceId],path=join(root,`clip-${index}.mov`);
    const samples=Math.round(seconds(clip.outFrame-clip.inFrame)*48000);
    const segmentKey=fingerprint([previewVersion,source,identities[clip.sourceId],clip.inFrame,clip.outFrame,timeline.fps,width,height]);
    const cached=join(segments,`${segmentKey}.mov`);
    let reused=false;
    try {await stat(cached);reused=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    progress({stage:'preview',completed:index,total:timeline.intervals.length,reused});
    if(!reused) {
      const pending=join(segments,`${segmentKey}.${randomUUID()}.mov`);
      try {
        await tool('ffmpeg',['-v','error','-nostdin','-y','-threads','2','-ss',String(seconds(clip.inFrame)),'-i',source.path,'-filter_complex_threads','2','-filter_complex',`[0:${source.videoIndex}]trim=end_frame=${clip.outFrame-clip.inFrame},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p[v];[0:${source.audioIndex}]pan=mono|c0=c${source.audioChannel},aresample=48000,atrim=end_sample=${samples},asetpts=PTS-STARTPTS[a]`,'-map','[v]','-map','[a]','-c:v','libx264','-threads','2','-preset','ultrafast','-crf','25','-r',`${timeline.fps.numerator}/${timeline.fps.denominator}`,'-c:a','alac',pending],{signal});
        await rename(pending,cached);
      } finally {await rm(pending,{force:true});}
    }
    // Hard links keep concat paths local and safe without duplicating media.
    await rm(path,{force:true});await link(cached,path);
    paths.push(`file 'clip-${index}.mov'`);
  }
  await writeFile(join(root,'concat.txt'),paths.join('\n'));
  const temp=join(root,`preview-${randomUUID()}.mp4`);
  await tool('ffmpeg',['-v','error','-nostdin','-y','-f','concat','-safe','1','-i',join(root,'concat.txt'),'-c:v','copy','-c:a','aac','-b:a','160k','-movflags','+faststart',temp],{signal});
  const { stdout } = await execute('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',temp],{signal});
  const streams=JSON.parse(stdout).streams;
  const video=streams.find(s=>s.codec_type==='video'),audio=streams.find(s=>s.codec_type==='audio');
  if(Number(video?.nb_read_frames)!==timeline.duration || !Number.isFinite(Number(audio?.duration)) || Math.abs(Number(audio.duration)-seconds(timeline.duration))>.03)throw new Error('Rendered playback differs from the compiled timeline');
  await rename(temp,join(root,'preview.mp4'));
  await writeFile(join(root,'premiere.xml'),premiereXml(timeline,sources));
  const saved={...compiled,url:pathToFileURL(join(root,'preview.mp4')).href,xmlPath:join(root,'premiere.xml'),durationSeconds:seconds(timeline.duration)};
  await writeFile(manifest,JSON.stringify(saved,null,2));
  return saved;
}
