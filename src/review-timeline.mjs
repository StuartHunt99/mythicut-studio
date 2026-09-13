import { resolveReview } from './review.mjs';
import { compileTimeline, frameRate } from './timeline.mjs';
import { reviewedWordRange } from './cut-boundaries.mjs';
import { timedWords, timingRevision } from './word-timing.mjs';

export function orderedSelection(view, words) {
  const selected = new Set(view.selectedWordIds);
  const added = new Set(); const ordered = [];
  for (const range of view.ranges) for (const id of range.wordIds) if (selected.has(id) && !added.has(id)) { ordered.push(id); added.add(id); }
  // Manually restored words attach to the closest following selected source
  // word (or preceding one at EOF). Existing script/recovery order stays intact.
  let pending=[]; let previous=null;
  for (const word of words) {
    if (!selected.has(word.id)) continue;
    if (!added.has(word.id)) { pending.push(word.id); continue; }
    if (pending.length) { ordered.splice(ordered.indexOf(word.id),0,...pending); pending.forEach(id=>added.add(id)); pending=[]; }
    previous=word.id;
  }
  if (pending.length) ordered.splice(previous?ordered.indexOf(previous)+1:ordered.length,0,...pending);
  // A continuous highlighted source passage stays whole even if sentence
  // recommendations originally listed its words in a different order.
  const rank=new Map(ordered.map((id,i)=>[id,i]));const runs=[];let run=null;
  for(const word of words) {
    if(!selected.has(word.id)){run=null;continue;}
    if(!run||run.mediaId!==word.mediaId){run={mediaId:word.mediaId,ids:[],rank:Infinity};runs.push(run);}
    run.ids.push(word.id);run.rank=Math.min(run.rank,rank.get(word.id));
  }
  return runs.sort((a,b)=>a.rank-b.rank).flatMap(run=>run.ids);
}
export function compileReview(project, result) {
  const view=resolveReview(project.review,result);
  const words=timedWords(result);
  const sources={}; const issues=[];const timingWarnings=[];
  for(const asset of project.media) {
    const [numerator,denominator]=asset.video.frameRate.split('/').map(Number);
    const fps=frameRate({numerator,denominator});
    if(Number(asset.video.startTime??0)!==0 || asset.audio.some(a=>Number(a.startTime??0)!==0)) throw new Error('Nonzero source stream offsets require verified time mapping');
    let audioTrack=1;
    for(const stream of asset.audio) {if(stream.index===asset.selectedAudio.streamIndex){audioTrack+=asset.selectedAudio.channel;break;}audioTrack+=stream.channels;}
    sources[asset.id]={path:asset.path,fps,frames:Math.floor(asset.duration*numerator/denominator+1e-7),width:asset.video.width,height:asset.video.height,channels:asset.audio.reduce((n,a)=>n+a.channels,0),audioTrack,videoIndex:asset.video.index,audioIndex:asset.selectedAudio.streamIndex,audioChannel:asset.selectedAudio.channel,durationMs:asset.duration*1000};
  }
  const fps=sources[project.media[0]?.id]?.fps;
  if(!fps)throw new Error('No source media');
  const indexed=new Map(words.map((w,i)=>[w.id,{...w,index:i}]));
  const ordered=orderedSelection(view,words).map(id=>indexed.get(id));
  if(!ordered.length)throw new Error('No words selected');
  const groups=[];
  for(const word of ordered) {
    const group=groups.at(-1);const previous=group?.at(-1);
    if(previous && previous.mediaId===word.mediaId && word.index===previous.index+1)group.push(word);
    else groups.push([word]);
  }
  const clips=[];
  for(const group of groups) {
    const first=group[0],last=group.at(-1),source=sources[first.mediaId];
    const before=words[first.index-1],after=words[last.index+1];
    try {
      const boundary=reviewedWordRange({first,last,previous:before?.mediaId===first.mediaId?before:null,next:after?.mediaId===last.mediaId?after:null,sourceDurationMs:source.durationMs,maximumPauseMs:project.settings.pauseMs,fps:source.fps});
      const clip={sourceId:first.mediaId,inFrame:boundary.inFrame,outFrame:boundary.outFrame,wordIds:group.map(w=>w.id)};
      clips.push(clip);
      if(boundary.estimated)timingWarnings.push({firstWordId:first.id,lastWordId:last.id,message:'Approximate word boundary; retained as selected.'});
    } catch(error) {
      const uncertain=[first,last,before,after].find(w=>w?.mediaId===first.mediaId&&(w.needsReview||w.valid===false||w.endMs<=w.startMs));
      issues.push({firstWordId:first.id,lastWordId:last.id,reviewWordId:uncertain?.id??first.id,text:group.map(w=>w.text).join(' '),message:error.message});
    }
  }
  if(issues.length) {const error=new Error(`${issues.length} selections have unusable source timestamps`);error.issues=issues;throw error;}
  const timeline=compileTimeline(clips,sources,fps);
  const wordMap=timeline.intervals.flatMap(clip=>clip.wordIds.filter(id=>{
    const word=indexed.get(id),frameMs=1000*fps.denominator/fps.numerator;
    return word.valid!==false&&!word.needsReview&&word.startMs>=clip.inFrame*frameMs&&word.endMs<=clip.outFrame*frameMs;
  }).map(id=>{
    const word=indexed.get(id);const start=(clip.start-clip.inFrame)*fps.denominator/fps.numerator;
    return {id,startSeconds:start+word.startMs/1000,endSeconds:start+word.endMs/1000};
  }));
  return {schemaVersion:1,analysisId:view.analysisId,selectionId:view.selectionId,timingId:timingRevision(result),revision:view.revision,projectId:project.id,sources,timingWarnings,timeline:{...timeline,width:project.settings.width??1920,height:project.settings.height??1080,name:project.name},wordMap};
}
