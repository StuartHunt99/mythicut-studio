import test from 'node:test';import assert from 'node:assert/strict';
import { createProject } from '../src/project.mjs';
import { parseScript } from '../src/script.mjs';
import { sentenceEvidence,selectLatestTakes } from '../src/take-selection.mjs';
import { resolveReview,applyReviewCommand } from '../src/review.mjs';
import { compileReview,orderedSelection } from '../src/review-timeline.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';
function fixture(){
 const p=createProject();p.script=parseScript('I talked about this in another video.');
 p.media=[{id:'a',path:'/tmp/source.mov',filename:'source.mov',duration:10,video:{frameRate:'30/1',width:1920,height:1080,index:0},audio:[{index:1,channels:2}],selectedAudio:{streamIndex:1,channel:1}}];
 const words='Now I talked about this in another video.'.split(' ').map((text,i)=>({id:`w${i}`,mediaId:'a',text,startMs:500+i*500,endMs:700+i*500,valid:true}));
 const r={projectId:p.id,inputId:'input',words,takeSelection:selectLatestTakes(sentenceEvidence(p.script.sentences,words))};return{p,r};
}
test('added Now compiles inside a single continuous clip and uses selected original audio channel',()=>{
 const {p,r}=fixture();const c=compileReview(p,r);
 assert.equal(c.timeline.intervals.length,1);assert.equal(c.timeline.intervals[0].wordIds[0],'w0');
 assert.equal(c.wordMap.length,8);assert.equal(c.sources.a.audioTrack,2);
 assert.match(premiereXml(c.timeline,c.sources),/<mediatype>audio<\/mediatype><trackindex>2<\/trackindex><\/sourcetrack>/);
 assert.equal(c.timeline.intervals[0].start,0);
});
test('manual word removal produces two contiguous timeline placements without rejected speech',()=>{
 const {p,r}=fixture();const v=resolveReview(p.review,r);
 p.review=applyReviewCommand(p.review,r,{type:'words',action:'remove',wordIds:['w2'],analysisId:v.analysisId,revision:v.revision});
 const c=compileReview(p,r);assert.equal(c.timeline.intervals.length,2);
 assert.equal(c.timeline.intervals[0].end,c.timeline.intervals[1].start);
 assert.ok(c.timeline.intervals[0].outFrame/30<=r.words[2].startMs/1000);
 assert.ok(c.timeline.intervals[1].inFrame/30>=r.words[2].endMs/1000);
 assert.ok(!c.wordMap.some(w=>w.id==='w2'));
});
test('approximate boundaries remain editable and exportable; missing timestamps still fail',()=>{
 const estimated=fixture();estimated.r.words[0].endMs=estimated.r.words[0].startMs;estimated.r.words.at(-1).needsReview=true;
 const c=compileReview(estimated.p,estimated.r);assert.equal(c.timeline.intervals.length,1);assert.equal(c.timingWarnings.length,1);
 const {p,r}=fixture();r.words[0].startMs=NaN;
 assert.throws(()=>compileReview(p,r),e=>e.issues.length===1 && e.issues[0].firstWordId==='w0');
});
test('continuous selected text stays one source clip across sentences and long pauses',()=>{
 const {p,r}=fixture();p.script=parseScript('I talked. About this in another video.');
 r.words[2].text='talked.';r.words[3].text='About';
 for(const word of r.words.slice(3)){word.startMs+=3000;word.endMs+=3000;}
 r.takeSelection=selectLatestTakes(sentenceEvidence(p.script.sentences,r.words));
 const compiled=compileReview(p,r);
 assert.equal(compiled.timeline.intervals.length,1);
 assert.deepEqual(compiled.timeline.intervals[0].wordIds,r.words.map(w=>w.id));
 const view=resolveReview(p.review,r);
 p.review=applyReviewCommand(p.review,r,{type:'words',action:'remove',wordIds:['w3'],analysisId:view.analysisId,revision:view.revision});
 assert.equal(compileReview(p,r).timeline.intervals.length,2);
});
test('uncertain interior speech stays in footage but cannot supply a misleading text seek',()=>{
 const {p,r}=fixture();r.words[2].needsReview=true;r.words[3].startMs=-100;
 const c=compileReview(p,r);
 assert.ok(c.timeline.intervals[0].wordIds.includes('w2'));
 assert.ok(!c.wordMap.some(w=>w.id==='w2'||w.id==='w3'));
 assert.ok(c.wordMap.every(w=>w.startSeconds>=0&&w.endSeconds<=c.timeline.duration/30));
});
test('restored words reconnect one continuous source run despite separate sentence recommendations',()=>{
 const words=Array.from({length:9},(_,i)=>({id:String(i)}));
 const view={selectedWordIds:['1','2','3','4','5','6','7','8'],ranges:[{wordIds:['1','2']},{wordIds:['7','8']},{wordIds:['3','4']}]};
 assert.deepEqual(orderedSelection(view,words),['1','2','3','4','5','6','7','8']);
});
test('sequence dimensions and name reach XML and fill scaling',()=>{
 const {p,r}=fixture();p.settings.width=1280;p.settings.height=720;p.name='A & B';
 const c=compileReview(p,r),xml=premiereXml(c.timeline,c.sources);
 assert.match(xml,/<name>A &amp; B<\/name>/);assert.match(xml,/<width>1280<\/width><height>720<\/height>/);
 assert.match(xml,/<width>1920<\/width><height>1080<\/height>/);
 assert.match(xml,/<value>66\.666/);
});
