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
test('spoken additions stay inside the whole selected sentence', () => {
 const script = [{ id:'s1', text:'People call this the problem of Susan.' }, { id:'s2', text:'I talked about that important issue in another video.' }];
 const w = words('People call this the problem of Susan. Now I talked about that important issue in another video.');
 const selected = selectLatestTakes(sentenceEvidence(script, w));
 assert.equal(selected[1].selected.startIndex, 7);
 assert.match(selected[1].selected.text, /^Now I talked/);
 assert.equal(selected[0].selected.endIndex + 1, selected[1].selected.startIndex);
});
test('internal and trailing additions are preserved without absorbing a restart marker',()=>{
 const script=[{id:'s1',text:'I talked about this in another video.'}];
 const w=words('new take Now I talked about this important issue in another video yesterday.');
 const c=selectLatestTakes(sentenceEvidence(script,w,{restartPhrase:'new take'}))[0].selected;
 assert.ok(c); assert.ok(!c.text.includes('new take'));assert.match(c.text,/important issue/);assert.match(c.text,/yesterday\.$/);
});
test('edge expansion does not cross a file or pull in an explicitly abandoned fragment',()=>{
 const script=[{id:'s1',text:'I talked about this in another video.'}];
 const w=words("and it's- Now I talked about this in another video.");
 const c=selectLatestTakes(sentenceEvidence(script,w))[0].selected;
 assert.equal(c.text,'Now I talked about this in another video.');
 w[2].mediaId='other';
 assert.equal(selectLatestTakes(sentenceEvidence(script,w))[0].selected.text,'I talked about this in another video.');
});
test('inserted words after the opening do not make a genuine sentence opening look like a restart',()=>{
 const script=[{id:'s1',text:'Because at the end of the story one chair remains empty.'}];
 const w=words('Because you see at the end of the story one chair remains empty.');
 const selected=selectLatestTakes(sentenceEvidence(script,w))[0].selected;
 assert.equal(selected.startIndex,0);assert.match(selected.text,/^Because you see/);
});
