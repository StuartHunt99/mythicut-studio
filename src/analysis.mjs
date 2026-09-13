import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { transcriptWords } from './transcript.mjs';
import { matchSentences } from './matching.mjs';
import { sentenceEvidence, selectLatestTakes } from './take-selection.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function jsonSave(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2)); await rename(temp, path);
}
export function runTool(command, args, { signal, progress = () => {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error('Analysis canceled'));
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = ''; let timer;
    const abort = () => { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', chunk => { tail = (tail + chunk.toString()).slice(-12000); const matches = [...chunk.toString().matchAll(/progress\s*=\s*(\d+)%/g)]; if (matches.length) progress(Number(matches.at(-1)[1])); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); signal?.aborted ? reject(new Error('Analysis canceled')) : code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${code}): ${tail.slice(-2000)}`)); });
  });
}
export async function analyzeProject(project, directory, { model, signal, progress = () => {}, tool = runTool } = {}) {
  if (!project.media.length || !project.script.sentences.length) throw new Error('Add recordings and a spoken script before analysis');
  if (project.media.some(a => !a.selectedAudio)) throw new Error('Every recording needs an audio channel');
  const modelStat = await stat(model);
  const inputId = digest({ version: 1, projectId: project.id, media: project.media, script: project.script.original, settings: project.settings, model: { path: resolve(model), size: modelStat.size, mtimeMs: modelStat.mtimeMs } });
  const root = resolve(directory, inputId); await mkdir(root, { recursive: true });
  const checkCanceled = () => { if (signal?.aborted) throw new Error('Analysis canceled'); };
  const startedAt = new Date().toISOString();
  const report = { schemaVersion: 1, jobId: randomUUID(), projectId: project.id, inputId, startedAt, status: 'running', sources: [] };
  const event = (stage, detail = {}) => progress({ jobId: report.jobId, stage, ...detail });
  const allWords = [];
  try {
    for (const [index, asset] of project.media.entries()) {
      checkCanceled();
      const current = await stat(asset.path);
      if (current.size !== asset.identity.size || current.mtimeMs !== asset.identity.mtimeMs) throw new Error(`${asset.filename}: source changed since import; create a new project`);
      const prefix = `${root}/source-${index}`;
      const checkpoint = `${prefix}.checkpoint.json`;
      let cached;
      try { cached = JSON.parse(await readFile(checkpoint, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      let data;
      if (cached?.inputId === inputId && cached?.status === 'complete') {
        try { data = JSON.parse(await readFile(`${prefix}.json`, 'utf8')); } catch { data = null; }
      }
      if (!Array.isArray(data?.transcription)) {
        event('extract', { filename: asset.filename, completed: index, total: project.media.length });
        await tool('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', asset.path, '-map', `0:${asset.selectedAudio.streamIndex}`, '-af', `pan=mono|c0=c${asset.selectedAudio.channel}`, '-ar', '16000', '-c:a', 'pcm_s16le', `${prefix}.wav`], { signal });
        checkCanceled(); event('transcribe', { filename: asset.filename, completed: index, total: project.media.length });
        await tool('whisper-cli', ['-m', model, '-f', `${prefix}.wav`, '-l', 'en', '-ng', '-t', '4', '-ojf', '-otxt', '-osrt', '-sow', '-pp', '-of', prefix], { signal, progress: percent => event('transcribe', { filename: asset.filename, percent, completed: index, total: project.media.length }) });
        data = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
        if (!Array.isArray(data.transcription)) throw new Error('Invalid Whisper output');
        await jsonSave(checkpoint, { inputId, status: 'complete' });
      } else event('cached-transcript', { filename: asset.filename, completed: index, total: project.media.length });
      const words = transcriptWords(data, asset.id);
      allWords.push(...words);
      report.sources.push({ mediaId: asset.id, prefix, wordCount: words.length, invalidWordCount: words.filter(w => !w.valid).length });
    }
    checkCanceled(); event('match');
    const matches = matchSentences(project.script.sentences, allWords);
    const takeEvidence = sentenceEvidence(project.script.sentences, allWords);
    const takeSelection = selectLatestTakes(takeEvidence);
    const warnings = [
      { kind: 'recognition-unverified', message: 'Whisper can omit restarts. Word-level output does not prove every spoken word is present. Acoustic comparison and human review are required before cut generation.' },
      ...report.sources.filter(s => s.invalidWordCount).map(s => ({ kind: 'invalid-word-timing', mediaId: s.mediaId, message: `${s.invalidWordCount} word intervals need timing refinement.` })),
      ...(project.media.length > 1 ? [{ kind: 'file-joins-unverified', message: 'Camera joins have not been verified; candidates spanning files are withheld.' }] : [])
    ];
    const result = { schemaVersion: 1, projectId: project.id, inputId, status: 'evidence-ready', words: allWords, matches, takeEvidence, takeSelection, warnings, summary: { wordCount: allWords.length, sentenceCount: matches.length, withCandidates: matches.filter(m => m.candidates.length).length, multipleCandidates: matches.filter(m => m.candidates.length > 1).length, selectedTakes: takeSelection.filter(s => s.selected).length, needsReview: takeSelection.filter(s => s.flags.length).length, invalidIntervals: allWords.filter(w => !w.valid).length } };
    await jsonSave(`${root}/result.json`, result);
    const timestamp = ms => `${Math.floor(ms / 60000)}:${(ms / 1000 % 60).toFixed(2).padStart(5, '0')}`;
    const review = ['# Transcript and candidate evidence', '', 'All candidates require review. These are text matches, not approved cuts. Whisper may omit restarts, and word timestamps require acoustic refinement.', '', ...warnings.map(w => `- ${w.message}`), '', '## Provisional take selection', '', ...takeSelection.flatMap(choice => [
      `### ${choice.selected ? 'Selected provisionally' : 'Review needed'} — ${choice.sentence.id}: ${choice.sentence.text}`, '', choice.selected ? `${choice.selected.id} · ${timestamp(choice.selected.startMs)}–${timestamp(choice.selected.endMs)} · ${Math.round(choice.selected.score * 100)}% similarity · flags: ${choice.flags.join(', ') || 'none'}` : `Flags: ${choice.flags.join(', ')}`, ''
    ]), '## Sentence candidate evidence', '', ...matches.flatMap(m => [
      `## ${m.sentenceId}: ${m.text}`, '', m.reason, '',
      ...m.candidates.flatMap(c => [`${c.id === m.latestCandidateId ? '**Latest candidate — requires review** — ' : ''}${c.id} · ${project.media.find(a => a.id === c.mediaId)?.filename} · ${timestamp(c.startMs)}–${timestamp(c.endMs)} · ${Math.round(c.score * 100)}% token similarity`, '', c.text, ''])
    ])].join('\n');
    await writeFile(`${root}/review.md`, review);

    report.status = 'complete'; report.resultPath = `${root}/result.json`; report.finishedAt = new Date().toISOString(); report.elapsedSeconds = (Date.now() - Date.parse(startedAt)) / 1000;
    await jsonSave(`${root}/job-${report.jobId}.json`, report);
    await jsonSave(`${root}/job.json`, report); event('complete', result.summary);
    return { ...result.summary, inputId, resultPath: report.resultPath, warnings };
  } catch (error) {
    report.status = signal?.aborted ? 'canceled' : 'failed'; report.error = error.message;
    await jsonSave(`${root}/job-${report.jobId}.json`, report);
    await jsonSave(`${root}/job.json`, report); throw error;
  }
}
