import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {openProject} from '../src/project.mjs';import {sentenceEvidence,selectLatestTakes} from '../src/take-selection.mjs';
import {refineProjectTiming,saveTimingResult} from '../src/timing-job.mjs';
const [file,acousticFile]=process.argv.slice(2);if(!file)throw new Error('Usage: node scripts/refine-project-timing.mjs PROJECT_JSON [VERIFIED_ACOUSTIC_CACHE_JSON]');
const {project,warnings}=await openProject(resolve(file));if(warnings.length)throw new Error(warnings.join('\n'));
const result=JSON.parse(await readFile(project.analysis.resultPath,'utf8'));result.takeSelection=selectLatestTakes(sentenceEvidence(project.script.sentences,result.words,project.settings));
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
const refined=await refineProjectTiming(project,result,{signal:controller.signal,progress:console.log,acousticEvidence:acousticFile?{[project.media[0].id]:resolve(acousticFile)}:{}});
await saveTimingResult(project.analysis.resultPath,refined);console.log(JSON.stringify(refined.timingSummary,null,2));
