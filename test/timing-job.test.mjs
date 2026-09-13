import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createProject} from '../src/project.mjs';import {parseScript} from '../src/script.mjs';import {sentenceEvidence,selectLatestTakes} from '../src/take-selection.mjs';
import {refineProjectTiming,mergeAlignment,alignmentRequest} from '../src/timing-job.mjs';import {applyReviewCommand,resolveReview} from '../src/review.mjs';
import {refineWordTiming,timingInputId,timingRevision} from '../src/word-timing.mjs';
const words='These are the actual spoken words.'.split(' ').map((text,i)=>({id:`w${i}`,mediaId:'a',text,startMs:500+i*400,endMs:700+i*400,valid:true}));
test('refinement uses verified cached audio, preserves manual edits, and rejects mismatched cache',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mythicut-timing-'));
 const source=join(root,'source.mov'),audioPath=join(root,'source-0.wav'),audioEvidence=join(root,'evidence.wav'),provided=join(root,'acoustic.json');
 await writeFile(source,'source');await writeFile(audioPath,'same audio');await writeFile(audioEvidence,'same audio');
 const m=await stat(source),a=await stat(audioEvidence,{bigint:true});
 const project=createProject();project.script=parseScript('These are the actual spoken words.');
 project.media=[{id:'a',path:source,filename:'source.mov',duration:4,identity:{size:m.size,mtimeMs:m.mtimeMs},selectedAudio:{streamIndex:1,channel:0},video:{frameRate:'30/1',width:1920,height:1080,index:0},audio:[{index:1,channels:1}]}];
 project.analysis={inputId:'input',resultPath:join(root,'result.json')};
 const raw=words.map(w=>({...w}));raw[0].endMs=raw[0].startMs;raw[0].valid=false;
 const result={projectId:project.id,inputId:'input',words:raw,takeSelection:selectLatestTakes(sentenceEvidence(project.script.sentences,raw))};
 const view=resolveReview(project.review,result);
 project.review=applyReviewCommand(project.review,result,{type:'words',action:'remove',wordIds:['w3'],analysisId:view.analysisId,revision:view.revision});
 const selected=resolveReview(project.review,result).selectedWordIds;
 await writeFile(provided,JSON.stringify({schemaVersion:1,duration:4,identity:{path:audioEvidence,size:Number(a.size),mtime:Number(a.mtimeNs)},words:words.map(w=>({...w,id:'a'+w.id,acousticConfidence:.99}))}));
 const options={directory:join(root,'cache'),acousticEvidence:{a:provided},tool:async()=>{throw new Error('Unexpected inference; matching evidence should be reused');}};
 const fixed=await refineProjectTiming(project,result,options);
 assert.equal(fixed.timingSummary.remaining,0);assert.deepEqual(fixed.words,result.words);
 assert.deepEqual(resolveReview(project.review,fixed).selectedWordIds,selected);assert.notEqual(timingRevision(fixed),timingRevision(result));
 const resumed=await refineProjectTiming(project,result,{...options,acousticEvidence:{}});assert.equal(resumed.timingSummary.remaining,0);
 await writeFile(audioPath,'different audio');
 await assert.rejects(refineProjectTiming(project,result,options),/does not match/);
 const controller=new AbortController();controller.abort();await assert.rejects(refineProjectTiming(project,result,{...options,signal:controller.signal}),/canceled/);
});
test('alignment import only accepts requested word IDs, current identity, safe ranges and sufficient confidence',()=>{
 const timing=refineWordTiming(words,[],{mediaId:'a'});
 const request={inputId:timingInputId(words),windows:[{id:'w0',startMs:0,endMs:1500,words:[words[0]]}]};
 const response={schemaVersion:1,inputId:request.inputId,windows:[{id:'w0',startMs:0,endMs:1500,greedyRecognition:'THESE',words:[{id:'w0',text:'These',startMs:500,endMs:700,valid:true,needsReview:false,confidence:.9}]}]};
 assert.equal(mergeAlignment(timing,request,response).words.w0.startMs,500);
 assert.throws(()=>mergeAlignment(timing,request,{...response,inputId:'old'}),/Stale/);
 assert.throws(()=>mergeAlignment(timing,request,{...response,windows:[{...response.windows[0],id:'not-requested'}]}),/Unknown/);
 for(const patch of [{confidence:.01},{startMs:-1},{endMs:2000},{text:'different'}]){
  const bad=structuredClone(response);Object.assign(bad.windows[0].words[0],patch);
  assert.equal(mergeAlignment(timing,request,bad).words.w0,undefined);
 }
});
