import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve,join} from 'node:path';
import {runTool} from '../src/analysis.mjs';import {timedWords} from '../src/word-timing.mjs';
const [projectFile='artifacts/m1/Susan-project.json']=process.argv.slice(2);
const project=JSON.parse(await readFile(projectFile,'utf8')),result=JSON.parse(await readFile(project.analysis.resultPath,'utf8'));
const words=timedWords(result),root=resolve('artifacts/timing/conflicts');await mkdir(root,{recursive:true});const cases=[];
for(const [index,issue] of (result.timingSummary?.issues??[]).entries()){
 const first=words.findIndex(w=>w.id===issue.firstWordId),last=words.findIndex(w=>w.id===issue.lastWordId);
 const word=[words[first],words[last],words[first-1],words[last+1]].find(w=>w&&(w.needsReview||!w.valid))??words[first];
 const asset=project.media.find(a=>a.id===word.mediaId);
 const startSeconds=Math.max(0,word.startMs/1000-6),prefix=join(root,`case-${index+1}`);
 console.log(JSON.stringify({stage:'recheck',case:index+1,sourceSeconds:startSeconds}));
 await runTool('ffmpeg',['-v','error','-nostdin','-y','-ss',String(startSeconds),'-i',asset.path,'-t','18','-map',`0:${asset.selectedAudio.streamIndex}`,'-af',`pan=mono|c0=c${asset.selectedAudio.channel}`,'-ar','16000','-c:a','pcm_s16le',`${prefix}.wav`]);
 await runTool('whisper-cli',['-m',resolve('.local/models/ggml-base.en.bin'),'-f',`${prefix}.wav`,'-ng','-t','4','-l','en','-ojf','-otxt','-sow','-of',prefix]);
 const transcription=(await readFile(`${prefix}.txt`,'utf8')).trim();
 cases.push({id:`case-${index+1}`,wordId:word.id,uncertainWord:word.text,sourceStartSeconds:startSeconds,originalTranscript:issue.text,freshWhisper:transcription,audioPath:`${prefix}.wav`});
}
await writeFile(join(root,'cases.json'),JSON.stringify(cases,null,2));
await writeFile(join(root,'review.md'),['# Remaining recognition conflicts','', 'Fresh short-window Whisper recognition is evidence, not an automatic transcript replacement. Original review decisions are unchanged.','',...cases.flatMap(c=>[`## ${c.id} — source ${c.sourceStartSeconds.toFixed(2)} seconds`, '',`Uncertain boundary word: ${c.uncertainWord} (${c.wordId})`,'',`Original selected text: ${c.originalTranscript}`,'',`Fresh Whisper: ${c.freshWhisper}`,'',`[Play source excerpt](<${c.audioPath}>)`,''])].join('\n'));console.log(JSON.stringify(cases,null,2));
