import { resolve } from 'node:path';
import { openProject, saveProject } from '../src/project.mjs';
import { analyzeProject } from '../src/analysis.mjs';
const [file, model = '.local/models/ggml-base.en.bin'] = process.argv.slice(2);
if (!file) throw new Error('Usage: node scripts/analyze-project.mjs PROJECT_JSON [MODEL_PATH]');
const { project, warnings } = await openProject(file);
if (warnings.length) throw new Error(warnings.join('\n'));
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
project.phase = 'analysis'; project.analysis = { status: 'running' };
await saveProject(file, project);
try {
 const summary = await analyzeProject(project, `${resolve(file)}.analysis`, { model: resolve(model), signal: controller.signal, progress: event => console.log(JSON.stringify(event)) });
 project.analysis = { status: 'evidence-ready', ...summary };
 await saveProject(file, project);
 console.log(JSON.stringify(summary));
} catch (error) {
 project.analysis = { status: controller.signal.aborted ? 'canceled' : 'failed', error: error.message };
 await saveProject(file, project); throw error;
}
