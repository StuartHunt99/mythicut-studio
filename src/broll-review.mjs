import { pathToFileURL } from 'node:url';
import { resolvedBrollDecisions } from './broll-overrides.mjs';
import { detectionAnchors } from './broll-motion.mjs';
import { summarizeBrollCoverage } from './broll-selection.mjs';
import { brollPreviewLayout } from './broll-preview-layout.mjs';
import { artworkMinimumForPlan } from './broll-artwork-config.mjs';

export function buildBrollReviewData({ beatPlan, selection, motion, overrides = [], catalogImages = [], catalogWarning = null }) {
  const decisions = new Map(resolvedBrollDecisions({ beatPlan, selection, motion, overrides }).map(item => [item.beatId, item]));
  const fps = beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator;
  const coverage = summarizeBrollCoverage(beatPlan.beats, new Map([...decisions].map(([beatId, item]) =>
    [beatId, { selectedImageId: item.imageId }])), fps, artworkMinimumForPlan(beatPlan));
  const uses = new Map();
  for (const beat of beatPlan.beats) {
    const imageId = decisions.get(beat.id)?.imageId;
    if (!imageId) continue;
    const earlier = uses.get(imageId);
    if (earlier && !beat.opening && !beat.closing && !earlier.opening && !earlier.closing) {
      coverage.warnings.push({ code: 'manual_duplicate_image', firstBeatId: earlier.id, secondBeatId: beat.id, imageId });
    } else if (!earlier) uses.set(imageId, beat);
  }
  const current = new Map(catalogImages.map(image => [image.imageId, image]));
  const beats = beatPlan.beats.map(beat => {
    const decision = decisions.get(beat.id);
    const candidates = (beat.search?.response?.results ?? []).map(image => {
      const now = current.get(image.imageId);
      const usable = Boolean(now && now.active && now.availability === 'present' && now.reviewState === 'accepted' &&
        now.imageVersionId === image.imageVersionId && now.revisionId === image.revisionId);
      return { imageId: image.imageId, filename: image.filename, imageVersionId: image.imageVersionId,
        revisionId: image.revisionId,
        width: image.width, height: image.height, detection: image.detection,
        anchors: detectionAnchors(image.detection),
        previewUrl: usable && now.path ? pathToFileURL(now.path).href : null,
        usable, warning: !now ? 'Image not found in the current catalog.' : !usable ? 'Image changed, deactivated, unavailable, or no longer accepted.' : null };
    });
    const selected = candidates.find(item => item.imageId === decision.imageId) ?? null;
    return { id: beat.id, startFrame: beat.startFrame, endFrame: beat.endFrame,
      text: beat.text, previousSentence: beat.previousSentence, nextSentence: beat.nextSentence,
      artworkNeed: beat.artworkNeed, talkingHeadPriority: beat.talkingHeadPriority,
      opening: beat.opening, closing: beat.closing, establishing: beat.establishing,
      searchStatus: beat.searchStatus, searchWarnings: beat.warnings,
      selectedImageId: decision.imageId, selectedFilename: selected?.filename ?? null,
      decisionReason: decision.reason, selectedUsable: !decision.imageId || Boolean(selected?.usable),
      intent: decision.intent, geometry: decision.geometry ? { ...decision.geometry, previewLayout: brollPreviewLayout(decision.geometry) } : null,
      trackLayer: decision.trackLayer,
      manuallyOverridden: decision.override, candidates };
  });
  return { beatPlanId: beatPlan.id, selectionId: selection.id, motionId: motion.id,
    output: { width: beatPlan.timeline.width, height: beatPlan.timeline.height, fps: beatPlan.timeline.fps },
    artworkMinimumSeconds: artworkMinimumForPlan(beatPlan),
    coverage, catalogWarning, beats };
}
