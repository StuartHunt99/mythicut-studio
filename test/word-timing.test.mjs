import test from 'node:test';import assert from 'node:assert/strict';
import {refineWordTiming,timedWords} from '../src/word-timing.mjs';
const words=(text,start=0)=>text.split(' ').map((text,i)=>({id:`w${i}`,mediaId:'a',text,startMs:start+i*300,endMs:start+i*300+200,valid:true}));
const acoustic=text=>words(text).map((w,i)=>({...w,id:`a${i}`,acousticConfidence:.95,needsReview:false}));
test('zero-duration words acquire real acoustic spans without changing IDs or text',()=>{
 const raw=words('Now I talked about this in another video.');raw[0].endMs=raw[0].startMs;raw[0].valid=false;
 const timing=refineWordTiming(raw,acoustic('Now I talked about this in another video.'),{mediaId:'a'});
 const result=timedWords({words:raw,timing:[timing]});
 assert.equal(result[0].endMs,200);assert.equal(result[0].valid,true);assert.deepEqual(result.map(w=>w.id),raw.map(w=>w.id));assert.deepEqual(result.map(w=>w.text),raw.map(w=>w.text));
});
test('interior zero-duration words receive provisional neighbor-median spans without changing raw evidence',()=>{
 const raw=words('A tiny missing pair of words');
 raw[2].startMs=raw[1].endMs+30;raw[2].endMs=raw[2].startMs;raw[2].valid=false;
 raw[3].startMs=raw[2].startMs+30;raw[3].endMs=raw[3].startMs;raw[3].valid=false;
 const before=structuredClone(raw);
 const result=timedWords({words:raw});
 assert.deepEqual(raw,before);
 assert.equal(result[2].startMs,500);assert.equal(result[2].endMs,850);
 assert.equal(result[3].startMs,850);assert.equal(result[3].endMs,1200);
 assert.ok(result.slice(2,4).every(w=>w.valid&&w.needsReview&&w.method==='neighbor-median-estimate'));
});
test('zero-duration words without two safe same-source neighbors stay unusable',()=>{
 const raw=words('First second third');raw[0].valid=false;raw[0].endMs=raw[0].startMs;
 assert.equal(timedWords({words:raw})[0].valid,false);
 raw[0].mediaId='b';assert.equal(timedWords({words:raw})[0].valid,false);
});
test('a Whisper-omitted restart maps the complete recognized sentence to the later acoustic occurrence',()=>{
 const raw=words('Because today we are finally going to answer the question.');
 const timing=refineWordTiming(raw,acoustic('Because today we are Because today we are finally going to answer the question.'),{mediaId:'a'});
 assert.equal(timing.words.w0.startMs,1200);assert.equal(timing.words.w3.endMs,2300);
});
test('low-confidence or different-source evidence cannot repair words; stale timing is rejected',()=>{
 const raw=words('These are the actual recorded words.');const a=acoustic('These are the actual recorded words.').map(w=>({...w,acousticConfidence:.2}));
 assert.equal(Object.keys(refineWordTiming(raw,a,{mediaId:'a'}).words).length,0);
 const uncertain=timedWords({words:raw,timing:[refineWordTiming(raw,a,{mediaId:'a'})]});
 assert.ok(uncertain.every(w=>w.needsReview),'Positive raw timestamps are not acoustic verification');
 assert.equal(Object.keys(refineWordTiming(raw,a.map(w=>({...w,mediaId:'b',acousticConfidence:.99})),{mediaId:'a'}).words).length,0);
 const timing=refineWordTiming(raw,acoustic('These are the actual recorded words.'),{mediaId:'a'});
 assert.throws(()=>timedWords({words:[...raw,{...raw[0],id:'other'}],timing:[timing]}),/Stale/);
});
