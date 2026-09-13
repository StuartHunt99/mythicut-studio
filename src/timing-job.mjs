import {readFile,writeFile,rename,mkdir,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {runTool} from './analysis.mjs';
import {normalizeAcousticWords} from './transcript.mjs';
import {refineWordTiming,timedWords,timingInputId} from './word-timing.mjs';
import {compileReview} from './review-timeline.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function json(path,value){const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2));await rename(temp,path);}
export function timingIssues(project,result){try{const compiled=compileReview(project,result);return{count:0,clips:compiled.timeline.intervals.length};}catch(error){return{count:error.issues?.length??null,issues:error.issues??[],error:error.message};}}
export function alignmentRequest(project,result,mediaId,audioPath){
 const issues=timingIssues(project,result).issues??[];const words=timedWords(result);const requested=new Set();
 for(const issue of issues)for(const id of [issue.firstWordId,issue.lastWordId]){
  const i=words.findIndex(w=>w.id===id);
  for(const j of [i-1,i,i+1])if(words[j]?.mediaId===mediaId&&!words[j].method)requested.add(j);
 }
 const asset=project.media.find(a=>a.id===mediaId),windows=[];
 for(const i of requested){
  const center=words[i];
  const chosen=words.slice(Math.max(0,i-2),i+3).filter(w=>w.mediaId===mediaId&&w.endMs>=center.startMs-6000&&w.startMs<=center.endMs+6000);
  const startMs=Math.max(0,Math.min(...chosen.map(w=>w.startMs))-700),endMs=Math.min(asset.duration*1000,Math.max(...chosen.map(w=>w.endMs))+700);
  if(endMs-startMs>20000||endMs<=startMs)continue;
  windows.push({id:words[i].id,startMs,endMs,words:chosen.map(w=>({id:w.id,text:w.text}))});
 }
 return{schemaVersion:1,inputId:timingInputId(result.words),audioPath,windows};
}
export function mergeAlignment(timing,request,response){
 if(response.schemaVersion!==1||response.inputId!==request.inputId||request.inputId!==timing.inputId||!Array.isArray(response.windows))throw new Error('Stale or invalid alignment response');
 const words={...timing.words},attempts=[];const seen=new Set();
 for(const window of response.windows){
  const allowed=request.windows.find(w=>w.id===window.id);
  if(!allowed||seen.has(window.id)||!Array.isArray(window.words)||window.startMs!==allowed.startMs||window.endMs!==allowed.endMs)throw new Error('Unknown alignment window');
  seen.add(window.id);const word=window.words.find(w=>w.id===window.id),source=allowed.words.find(w=>w.id===window.id);
  const accepted=word&&word.text===source.text&&word.valid===true&&word.needsReview===false&&Number.isFinite(word.confidence)&&word.confidence>=.5&&word.confidence<=1&&Number.isFinite(word.startMs)&&Number.isFinite(word.endMs)&&word.startMs>=allowed.startMs&&word.endMs<=allowed.endMs&&word.endMs>word.startMs&&word.endMs-word.startMs<=2500;
  if(accepted&&!words[word.id])words[word.id]={startMs:word.startMs,endMs:word.endMs,valid:true,needsReview:false,confidence:word.confidence,method:'local-ctc-alignment'};
  attempts.push({wordId:window.id,accepted:Boolean(accepted),confidence:word?.confidence??null,greedyRecognition:window.greedyRecognition});
 }
 const content={...timing,words,alignmentAttempts:attempts,unresolvedWordIds:timing.unresolvedWordIds.filter(id=>!words[id])};delete content.id;
 return{...content,id:hash(JSON.stringify(content))};
}
export async function refineProjectTiming(project,result,{directory,signal,progress=()=>{},tool=runTool,acousticEvidence={}}={}){
 if(result.projectId!==project.id||result.inputId!==project.analysis?.inputId)throw new Error('Stale analysis');
 const cache=resolve(directory??`${dirname(project.analysis.resultPath)}/timing`);await mkdir(cache,{recursive:true});
 const started=Date.now(),before=timingIssues(project,result).count;
 let refined={...result,timing:[]};
 const python=join(root,'.local/align-env/bin/python');
 const acousticScript=join(root,'scripts/acoustic-transcript.py'),alignScript=join(root,'scripts/align-boundaries.py');
 for(const [index,asset] of project.media.entries()){
  if(signal?.aborted)throw new Error('Timing refinement canceled');
  const current=await stat(asset.path);
  if(current.size!==asset.identity.size||current.mtimeMs!==asset.identity.mtimeMs)throw new Error(`${asset.filename}: source changed since import`);
  const audioPath=join(dirname(project.analysis.resultPath),`source-${index}.wav`);
  const audioHash=hash(await readFile(audioPath));
  const key=hash(JSON.stringify([audioHash,hash(await readFile(acousticScript)),'WAV2VEC2_ASR_BASE_960H']));
  const acousticPath=join(cache,`${key}.acoustic.json`);let acoustic;
  try{acoustic=JSON.parse(await readFile(acousticPath,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
  if(!Array.isArray(acoustic?.words)){
   const provided=acousticEvidence[asset.id];
   if(provided){
    acoustic=JSON.parse(await readFile(provided,'utf8'));
    const input=await stat(acoustic.identity.path,{bigint:true});
    if(Number(input.size)!==acoustic.identity.size||Number(input.mtimeNs)!==acoustic.identity.mtime||hash(await readFile(acoustic.identity.path))!==audioHash)throw new Error('Acoustic evidence does not match the selected-channel audio');
    await json(acousticPath,acoustic);
   }else{
    progress({stage:'acoustic-recognition',filename:asset.filename,completed:index,total:project.media.length});
    const temp=`${acousticPath}.pending`;
    await tool(python,[acousticScript,audioPath,temp],{signal});
    acoustic=JSON.parse(await readFile(temp,'utf8'));await json(acousticPath,acoustic);
   }
  }
  if(acoustic.schemaVersion!==1||!Array.isArray(acoustic.words)||Math.abs(acoustic.duration-asset.duration)>.1)throw new Error('Invalid acoustic evidence');
  progress({stage:'timing-match',filename:asset.filename});
  let timing=refineWordTiming(result.words,normalizeAcousticWords(acoustic.words,asset.id),{mediaId:asset.id,sourceIdentity:asset.identity});
  refined.timing.push(timing);
  const request=alignmentRequest(project,refined,asset.id,audioPath);
  if(request.windows.length){
   const alignmentKey=hash(JSON.stringify([request,hash(await readFile(alignScript))]));
   const requestPath=join(cache,`${alignmentKey}.request.json`),responsePath=join(cache,`${alignmentKey}.response.json`);
   await json(requestPath,request);let response;
   try{response=JSON.parse(await readFile(responsePath,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
   if(!response){progress({stage:'align-boundaries',filename:asset.filename,total:request.windows.length});const temp=`${responsePath}.pending`;await tool(python,[alignScript,requestPath,temp],{signal});response=JSON.parse(await readFile(temp,'utf8'));await json(responsePath,response);}
   timing=mergeAlignment(timing,request,response);refined.timing[index]=timing;
  }
 }
 if(signal?.aborted)throw new Error('Timing refinement canceled');
 const remaining=timingIssues(project,refined);
 refined.timingSummary={status:remaining.count===0?'ready':'needs-review',refinedWords:refined.timing.reduce((n,t)=>n+Object.keys(t.words).length,0),before,remaining:remaining.count,elapsedSeconds:(Date.now()-started)/1000,issues:remaining.issues??[]};
 // The caller commits this result only after the entire operation succeeds.
 await json(join(cache,'latest-report.json'),refined.timingSummary);
 progress({stage:'timing-complete',refinedWords:refined.timingSummary.refinedWords,remaining:remaining.count});
 return refined;
}
export async function saveTimingResult(path,result){await json(path,result);}
