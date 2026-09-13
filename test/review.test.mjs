import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, saveProject, openProject } from '../src/project.mjs';
import { parseScript } from '../src/script.mjs';
import { sentenceEvidence, selectLatestTakes } from '../src/take-selection.mjs';
import { resolveReview, applyReviewCommand, validateReview } from '../src/review.mjs';
function fixture() {
 const project=createProject(); project.script=parseScript('I talked about this in another video.');
 const words='Now I talked about this in another video. Now I talked about this in another video.'.split(' ').map((text,i)=>({id:`w${i}`,mediaId:'a',text,startMs:i*300,endMs:i*300+200}));
 const result={projectId:project.id,inputId:'input1',words,takeSelection:selectLatestTakes(sentenceEvidence(project.script.sentences,words))};
 const send=(review,command)=>{const view=resolveReview(review,result); return applyReviewCommand(review,result,{...command,analysisId:view.analysisId,revision:view.revision});};
 return {project,result,send};
}
test('word removal, restoration, reset and undo/redo survive project reopening', async()=>{
 const {project,result,send}=fixture(); const view=resolveReview(project.review,result);
 assert.deepEqual(view.selectedWordIds,Array.from({length:8},(_,i)=>`w${i+8}`));
 project.review=send(project.review,{type:'words',action:'remove',wordIds:['w9','w10']});
 assert.equal(resolveReview(project.review,result).selectedWordIds.length,6);
 const folder=await mkdtemp(join(tmpdir(),'mythicut-review-')); const path=join(folder,'project.json');
 await saveProject(path,project); const reopened=(await openProject(path)).project;
 reopened.review=send(reopened.review,{type:'undo'});
 assert.deepEqual(resolveReview(reopened.review,result).selectedWordIds,view.selectedWordIds);
 reopened.review=send(reopened.review,{type:'redo'});
 assert.equal(resolveReview(reopened.review,result).selectedWordIds.length,6);
 reopened.review=send(reopened.review,{type:'words',action:'keep',wordIds:['w0']});
 assert.ok(resolveReview(reopened.review,result).selectedWordIds.includes('w0'));
 reopened.review=send(reopened.review,{type:'words',action:'reset',wordIds:['w0','w9','w10']});
 assert.deepEqual(resolveReview(reopened.review,result).selectedWordIds,view.selectedWordIds);
});
test('stale requests and unknown IDs cannot mutate the selection; branching clears redo',()=>{
 const {project,result,send}=fixture(); const original=structuredClone(project.review);
 const v=resolveReview(project.review,result);
 assert.throws(()=>applyReviewCommand(project.review,result,{type:'words',action:'keep',wordIds:['missing'],analysisId:v.analysisId,revision:0}),/Unknown word/);
 assert.throws(()=>applyReviewCommand(project.review,result,{type:'words',action:'keep',wordIds:['w0'],analysisId:'old',revision:0}),/Stale/);
 assert.deepEqual(project.review,original);
 let r=send(project.review,{type:'words',action:'remove',wordIds:['w9']});
 assert.throws(()=>applyReviewCommand(r,result,{type:'undo',analysisId:v.analysisId,revision:0}),/Stale/);
 r=send(r,{type:'undo'}); r=send(r,{type:'words',action:'keep',wordIds:['w0']});
 assert.equal(resolveReview(r,result).canRedo,false);
 assert.throws(()=>resolveReview(r,{...result,words:result.words.map(w=>({...w,text:w.text+'x'}))}),/different transcript/);
 assert.throws(()=>validateReview({decisions:{},history:{entries:[],cursor:2}}),/history/);
});
test('sentence changes preserve explicit word overrides and zero-duration words use IDs',()=>{
 const {project,result,send}=fixture();
 result.words[9].endMs=result.words[9].startMs;
 let r=send(project.review,{type:'words',action:'remove',wordIds:['w9']});
 r=send(r,{type:'sentence',action:'reject',sentenceId:'s1'});
 assert.equal(resolveReview(r,result).selectedWordIds.length,0);
 r=send(r,{type:'sentence',action:'clear',sentenceId:'s1'});
 assert.equal(resolveReview(r,result).selectedWordIds.length,7);
 r=send(r,{type:'sentence',action:'approve',sentenceId:'s1',candidateId:result.takeSelection[0].candidates[0].id});
 assert.deepEqual(resolveReview(r,result).selectedWordIds,Array.from({length:8},(_,i)=>`w${i}`));
});
test('automatic proposal changes invalidate playback identity without discarding manual overrides',()=>{
 const {project,result,send}=fixture();
 const review=send(project.review,{type:'words',action:'keep',wordIds:['w0']});
 const before=resolveReview(review,result);
 result.takeSelection[0].selected=result.takeSelection[0].candidates[0];
 const after=resolveReview(review,result);
 assert.equal(before.analysisId,after.analysisId);assert.equal(before.revision,after.revision);
 assert.notEqual(before.selectionId,after.selectionId);assert.equal(after.overrides.w0,'keep');
});
test('toggle words flips the current highlighted state',()=>{
 const {project,result,send}=fixture();
 let r=send(project.review,{type:'toggleWords',wordIds:['w8','w9']});
 assert.ok(!resolveReview(r,result).selectedWordIds.includes('w8'));
 assert.ok(!resolveReview(r,result).selectedWordIds.includes('w9'));
 r=send(r,{type:'toggleWords',wordIds:['w8','w9']});
 assert.ok(resolveReview(r,result).selectedWordIds.includes('w8'));
 assert.ok(resolveReview(r,result).selectedWordIds.includes('w9'));
});
test('sentence toggle makes uniform sentences toggle and mixed sentences follow the majority',()=>{
 const {project,result,send}=fixture();
 let r=send(project.review,{type:'sentenceToggle',sentenceId:'s1'});
 assert.equal(resolveReview(r,result).selectedWordIds.length,0);
 r=send(r,{type:'sentenceToggle',sentenceId:'s1'});
 assert.equal(resolveReview(r,result).selectedWordIds.length,8);
 r=send(r,{type:'toggleWords',wordIds:['w8','w9','w10']});
 r=send(r,{type:'sentenceToggle',sentenceId:'s1'});
 assert.equal(resolveReview(r,result).selectedWordIds.length,8);
});
