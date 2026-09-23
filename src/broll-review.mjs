import { pathToFileURL } from 'node:url';
import { resolvedBrollDecisions } from './broll-overrides.mjs';
import { detectionAnchors } from './broll-motion.mjs';
import { summarizeBrollCoverage } from './broll-selection.mjs';
import { brollPreviewLayout } from './broll-preview-layout.mjs';
import { artworkMinimumForPlan } from './broll-artwork-config.mjs';

export function buildBrollReviewData({ beatPlan, selection, motion, overrides = [], manualCandidates = [], catalogImages = [], catalogWarning = null }) {
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
    const extras = [...overrides.filter(item => item.beatPlanId === beatPlan.id && item.beatId === beat.id)
      .map(item => item.candidate).filter(Boolean),
    ...manualCandidates.filter(item => item.beatId === beat.id).map(item => item.candidate)];
    const byImage = new Map((beat.search?.response?.results ?? []).map(item => [item.imageId, item]));
    for (const candidate of extras) byImage.set(candidate.imageId, candidate);
    const allCandidates = [...byImage.values()];
    const candidates = allCandidates.map(image => {
      const now = current.get(image.imageId);
      const usable = Boolean(now && now.active && now.availability === 'present' && now.reviewState === 'accepted' &&
        now.imageVersionId === image.imageVersionId);
      return { imageId: image.imageId, filename: image.filename, imageVersionId: image.imageVersionId,
        revisionId: now?.revisionId ?? image.revisionId, active: Boolean(now?.active),
        foundInCatalog: Boolean(now), availability: now?.availability ?? null,
        reviewState: now?.reviewState ?? null,
        accepted: now?.accepted ?? image.values ?? null,
        width: image.width, height: image.height, detection: image.detection,
        anchors: detectionAnchors(image.detection),
        previewUrl: usable && now.path ? pathToFileURL(now.path).href : null,
        usable, warning: !now ? 'Image not found in the current catalog.' : !usable ? 'Image changed, deactivated, unavailable, or no longer accepted.' : null };
    });
    const selected = candidates.find(item => item.imageId === decision.imageId) ?? null;
    const selectedMetadata = selected?.accepted ?? null;
    const tagFields = { bookKeys: 'book', centralCharacterKeys: 'characters', settingKeys: 'setting',
      moodKeys: 'mood', imageTypeKeys: 'image_type' };
    return { id: beat.id, startFrame: beat.startFrame, endFrame: beat.endFrame,
      text: beat.text, previousSentence: beat.previousSentence, nextSentence: beat.nextSentence,
      artworkNeed: beat.artworkNeed, talkingHeadPriority: beat.talkingHeadPriority,
      opening: beat.opening, closing: beat.closing, establishing: beat.establishing,
      searchStatus: beat.searchStatus, searchWarnings: beat.warnings,
      searchQuery: beat.search?.query?.semanticText ?? beat.searchQuery ?? beat.text,
      searchFilters: Object.fromEntries(Object.entries(tagFields).map(([queryKey, fieldKey]) =>
        [queryKey, beat.search?.query?.[queryKey]?.length ? beat.search.query[queryKey] :
          beat[queryKey]?.length ? beat[queryKey] : selectedMetadata?.[fieldKey] ?? []])),
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
