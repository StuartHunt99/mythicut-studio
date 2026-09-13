import {mkdtemp,mkdir,readdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {createProject,probeMedia} from '../src/project.mjs';
import {parseScript} from '../src/script.mjs';
import {sentenceEvidence,selectLatestTakes} from '../src/take-selection.mjs';
import {resolveReview,applyReviewCommand} from '../src/review.mjs';
import {buildReviewPreview,exportReviewXml} from '../src/review-media.mjs';
import {premiereXml} from '../src/premiere-xml.mjs';
import {runTool} from '../src/analysis.mjs';

await mkdir('artifacts/review',{recursive:true});
const root=await mkdtemp(resolve('artifacts/review/cache-check-'));
const project=createProject();project.script=parseScript('Blue scene. Green scene.');
project.media=await probeMedia([resolve('artifacts/m0/first.mov'),resolve('artifacts/m0/second.mov')]);
const words=project.media.flatMap((a,i)=>[i?'Green':'Blue','scene.'].map((text,j)=>({id:`w${i}-${j}`,mediaId:a.id,text,startMs:500+j*400,endMs:700+j*400,valid:true})));
const result={projectId:project.id,inputId:'cache-test',words,takeSelection:selectLatestTakes(sentenceEvidence(project.script.sentences,words))};
const directPath=join(root,'direct-export.xml');
const exported=await exportReviewXml(project,result,directPath);
assert.equal(await readFile(directPath,'utf8'),premiereXml(exported.timeline,exported.sources));
let renders=0,assemblies=0;
const tool=(command,args,options)=>{if(args.includes('-filter_complex'))renders++;if(args.includes('concat'))assemblies++;return runTool(command,args,options);};
const initial=await buildReviewPreview(project,result,root,{tool});
assert.equal(renders,2);assert.equal(assemblies,1);
await buildReviewPreview(project,result,root,{tool});assert.equal(renders,2);assert.equal(assemblies,1);
const change=command=>{const view=resolveReview(project.review,result);project.review=applyReviewCommand(project.review,result,{...command,analysisId:view.analysisId,revision:view.revision});};
change({type:'words',action:'remove',wordIds:['w0-0']});
const edited=await buildReviewPreview(project,result,root,{tool});
const editedExport=await exportReviewXml(project,result,directPath);
assert.deepEqual(editedExport.timeline,edited.timeline);
assert.equal(await readFile(directPath,'utf8'),premiereXml(edited.timeline,edited.sources));
assert.equal(renders,3,'Only the modified blue clip is rendered');assert.equal(assemblies,2);
assert.ok(edited.timeline.duration<initial.timeline.duration);
assert.equal(edited.timeline.intervals[1].inFrame,initial.timeline.intervals[1].inFrame);
change({type:'undo'});await buildReviewPreview(project,result,root,{tool});
assert.equal(renders,3,'Undo reuses both original segments');assert.equal(assemblies,3);
// An interrupted encode must never become a reusable completed segment.
change({type:'words',action:'remove',wordIds:['w1-0']});
await assert.rejects(buildReviewPreview(project,result,root,{tool:async(command,args,options)=>{
  if(args.includes('-filter_complex')){await writeFile(args.at(-1),'incomplete');throw new Error('Simulated cancellation');}
  return tool(command,args,options);
}}),/Simulated cancellation/);
assert.equal((await readdir(join(root,'segments'))).length,3,'Partial segment removed after cancellation');
await buildReviewPreview(project,result,root,{tool});assert.equal(renders,4,'Interrupted segment is rebuilt');
const report={initialFrames:initial.timeline.duration,editedFrames:edited.timeline.duration,directXmlExport:true,exportMatchesCurrentSelection:true,unchangedSegmentReused:true,undoReusesSegments:true,canceledSegmentDiscarded:true,renderedSegments:renders};
await writeFile(join(root,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,...report},null,2));
