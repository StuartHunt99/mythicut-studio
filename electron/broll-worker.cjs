const { appendFile, mkdir } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { parentPort } = process;

let controller = null;
let catalog = null;
let activeStage = 'startup';
let logPath = null;
let logQueue = Promise.resolve();

function logEvent(event) {
  if (!logPath) return;
  logQueue = logQueue.then(async () => {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, 'utf8');
  }).catch(() => {});
}

parentPort.on('message', async ({ data: message }) => {
  if (message.type === 'cancel') { controller?.abort(); return; }
  if (message.type !== 'start') return;
  controller = new AbortController();
  try {
    const { openImageCatalog } = await import('../src/image-tagging/catalog.mjs');
    const { createImageTagProvider } = await import('../src/image-tagging/providers/ai-sdk.mjs');
    const { planBrollBeats, saveBrollBeatPlan, readBrollBeatPlan } = await import('../src/broll-beats.mjs');
    const { selectBrollImages, saveBrollSelection } = await import('../src/broll-selection.mjs');
    const { planBrollMotion, saveBrollMotion, validateMotionCatalogImages } = await import('../src/broll-motion.mjs');
    const { catalogPath, modelCachePath, credential, profile, handoff, projectPath, promptOverride, stage, beatPlanId, selectionId, motionConfig, artworkConfig } = message;
    activeStage = stage;
    logPath = join(`${projectPath}.broll-logs`, `broll-${stage}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.jsonl`);
    logEvent({ kind: 'run', stage, model: profile.model, dialect: profile.dialect, logPath });
    catalog = await openImageCatalog({ databasePath: catalogPath, modelCachePath });
    const provider = createImageTagProvider({ dialect: profile.dialect, apiKey: credential, endpoint: profile.endpoint,
      timeoutMs: profile.settings?.timeoutMs ?? 60_000, logger: logEvent });
    if (stage === 'beats') {
      const plan = await planBrollBeats({ handoff, catalog, provider, model: profile.model, artworkConfig,
        promptOverride: promptOverride?.beatPlanning ?? null, signal: controller.signal });
      if (controller.signal.aborted) throw new Error('B-roll planning canceled');
      if (!plan.ok && plan.code === 'search_not_ready') {
        parentPort.postMessage({ type: 'not_ready', result: plan }); return;
      }
      await saveBrollBeatPlan(projectPath, plan);
      parentPort.postMessage({ type: 'done', result: { id: plan.id, handoffId: plan.handoffId, catalogId: plan.catalogId,
        beatCount: plan.beats.length, status: plan.status, searchNotReady: plan.beats.filter(beat => beat.searchStatus === 'search_not_ready').length } });
    } else if (stage === 'selection') {
      const beatPlan = await readBrollBeatPlan(projectPath, beatPlanId);
      const { differenceHash } = await import('../src/image-tagging/near-duplicate.mjs');
      const state = await catalog.execute('catalog.snapshot', { limit: 1 });
      if (state.catalog.id !== beatPlan.catalogId || state.catalog.revision !== beatPlan.catalogRevision) {
        throw new Error('The image catalog changed since beat planning. Replan beats before selecting from saved candidates.');
      }
      const selection = await selectBrollImages({ beatPlan, provider, model: profile.model,
        promptOverrides: promptOverride, signal: controller.signal,
        nearDuplicateHash: async imageId => {
          const [image] = await catalog.execute('images.resolve', { imageIds: [imageId] });
          if (!image || !image.active || image.availability !== 'present' || image.reviewState !== 'accepted') throw new Error('Selected image is no longer an available accepted catalog image');
          return differenceHash(image.path);
        } });
      if (controller.signal.aborted) throw new Error('Image selection canceled');
      await saveBrollSelection(projectPath, selection);
      parentPort.postMessage({ type: 'done', result: { id: selection.id, beatPlanId: selection.beatPlanId,
        selectedCount: selection.finalDecisions.filter(item => item.selectedImageId).length,
        brollPercent: selection.coverage.brollPercent, warningCount: selection.coverage.warnings.length } });
    } else if (stage === 'motion') {
      const beatPlan = await readBrollBeatPlan(projectPath, beatPlanId);
      const { readBrollSelection } = await import('../src/broll-selection.mjs');
      const selection = await readBrollSelection(projectPath, selectionId);
      const state = await catalog.execute('catalog.snapshot', { limit: 1 });
      if (state.catalog.id !== beatPlan.catalogId) throw new Error('The active image catalog differs from this beat plan');
      const imageIds = [...new Set(selection.finalDecisions.map(item => item.selectedImageId).filter(Boolean))];
      const catalogImages = imageIds.length ? await catalog.execute('images.resolve', { imageIds }) : [];
      validateMotionCatalogImages({ beatPlan, selection, catalogImages });
      const motion = await planBrollMotion({ beatPlan, selection, provider, model: profile.model,
        config: motionConfig, promptOverride: promptOverride?.motion ?? null, signal: controller.signal });
      if (controller.signal.aborted) throw new Error('Motion planning canceled');
      await saveBrollMotion(projectPath, motion);
      parentPort.postMessage({ type: 'done', result: { id: motion.id, selectionId: motion.selectionId,
        motionCount: motion.motions.length, warningCount: motion.motions.reduce((n, item) => n + item.geometry.warnings.length, 0) } });
    } else {
      throw new Error('Unknown B-roll worker stage');
    }
  } catch (error) {
    const providerError = error?.requestContext?.error;
    const status = providerError?.statusCode ?? providerError?.status;
    const detail = providerError?.providerMessage ?? String(error?.message ?? error);
    logEvent({ kind: 'worker-error', stage: activeStage, error: { message: String(error?.message ?? error), provider: providerError ?? null } });
    await logQueue;
    parentPort.postMessage({ type: 'failed', message: `B-roll ${activeStage} failed${status ? ` (provider HTTP ${status})` : ''}: ${detail}`, logPath });
  } finally { await logQueue; catalog?.close(); catalog = null; controller = null; activeStage = 'startup'; logPath = null; logQueue = Promise.resolve(); }
});

parentPort.once('close', () => catalog?.close());
