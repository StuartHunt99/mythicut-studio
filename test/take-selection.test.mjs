import test from 'node:test';import assert from 'node:assert/strict';
import { sentenceEvidence,selectLatestTakes } from '../src/take-selection.mjs';
const words=text=>text.split(' ').map((text,i)=>({id:`w${i}`,mediaId:'a',text,startMs:i*300,endMs:i*300+200}));
test('internal restart chooses complete later sentence and preserves minor variation',()=>{
 const script=[{id:'s1',text:'Because today we are finally going to answer the question.'}];
 const w=words('Because today we are Because today we are finally going to answer the question');
 const result=selectLatestTakes(sentenceEvidence(script,w));
 assert.equal(result[0].selected.startIndex,4);assert.equal(result[0].selected.endIndex,13);
});
test('later unfinished sentence cannot displace a complete earlier ending',()=>{
 const script=[{id:'s1',text:'We will answer this question before the show ends.'}];
 const w=words('We will answer this question before the show ends We will answer this question');
 const result=selectLatestTakes(sentenceEvidence(script,w));
 assert.equal(result[0].selected.startIndex,0);assert.equal(result[0].selected.endIndex,8);
});
