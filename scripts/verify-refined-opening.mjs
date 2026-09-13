import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
import {sentenceEvidence,selectLatestTakes} from '../src/take-selection.mjs';import {timedWords} from '../src/word-timing.mjs';
import {buildReviewPreview} from '../src/review-media.mjs';
const execute=promisify(execFile);const project=JSON.parse(await readFile('artifacts/m1/Susan-project.json','utf8'));
const result=JSON.parse(await readFile(project.analysis.resultPath,'utf8'));
result.takeSelection=selectLatestTakes(sentenceEvidence(project.script.sentences,result.words,project.settings));
// A separate diagnostic project selects the opening only. The user's saved
// review state and the previously approved curated sample remain untouched.
project.review={decisions:Object.fromEntries(result.takeSelection.filter(c=>c.scriptIndex>=7).map(c=>[c.sentence.id,{action:'reject',candidateId:null}]))};
const start=performance.now();const preview=await buildReviewPreview(project,result,resolve('artifacts/timing/opening-preview'),{progress:console.log});
const approved=JSON.parse(await readFile('artifacts/sample/edit/edit.json','utf8'));
const frames=timeline=>timeline.intervals.map(c=>[c.inFrame,c.outFrame,c.start,c.end]);
assert.deepEqual(frames(preview.timeline),frames(approved.timeline),'Automatic opening must match the previously approved sample');
const question=result.takeSelection.find(c=>c.sentence.id==='s6').selected;
const first=timedWords(result)[question.startIndex];assert.equal(first.text,'Because');assert.ok(first.startMs>=216000&&first.startMs<216500);
const mapping=preview.wordMap.find(w=>w.id===first.id);const audio=resolve('artifacts/timing/refined-question.wav');
await execute('ffmpeg',['-v','error','-y','-ss',String(Math.max(0,mapping.startSeconds-.4)),'-i',fileURLToPath(preview.url),'-t','8','-map','0:a:0','-ac','1','-ar','16000',audio]);
const check=await execute(resolve('.local/align-env/bin/python'),['scripts/check-sample-restarts.py',audio]);
const report={preview:preview.url,durationSeconds:preview.durationSeconds,frames:preview.timeline.duration,renderAndCheckSeconds:(performance.now()-start)/1000,sourceBecauseStartMs:first.startMs,acousticCheck:JSON.parse(check.stdout.trim()),matchesPreviouslyApprovedFrameRanges:true,humanListeningVerified:false};
await writeFile('artifacts/timing/opening-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
