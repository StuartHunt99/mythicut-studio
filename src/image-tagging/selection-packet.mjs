const roundScore = value => Number.isFinite(value) ? Number(value.toFixed(6)) : null;

function optionalText(value, name, maximum = 20_000) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${name} must be text`);
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (normalized.length > maximum) throw new Error(`${name} must be ${maximum.toLocaleString('en-US')} characters or fewer`);
  return normalized || null;
}

function humanMetadata(definition, values) {
  const metadata = {};
  for (const field of definition.fields) {
    const value = values?.[field.key];
    if (field.type === 'free_text') {
      const text = optionalText(value, field.label, 4_000);
      if (text) metadata[field.key] = text;
      continue;
    }
    if (!Array.isArray(value) || !value.length) continue;
    metadata[field.key] = value.map(key => field.options.find(option => option.key === key)?.label ?? key);
  }
  return metadata;
}

export function buildSelectionPacket({ definition, searchResponse, context = {} }) {
  if (!searchResponse?.ok) throw new Error('A successful hybrid search response is required');
  const query = searchResponse.query;
  const candidates = searchResponse.results.map((result, index) => ({
    imageId: result.imageId,
    filename: result.filename,
    retrievalRank: index + 1,
    metadata: humanMetadata(definition, result.values),
    rankingEvidence: {
      semanticScore: roundScore(result.scores.semantic),
      semanticRank: result.scores.semanticRank,
      lexicalRank: result.scores.lexicalRank,
      characterMatchRatio: roundScore(result.scores.characterMatchRatio),
      settingMatchRatio: roundScore(result.scores.settingMatchRatio),
      moodMatchRatio: roundScore(result.scores.moodMatchRatio),
      imageTypeMatchRatio: roundScore(result.scores.imageTypeMatchRatio),
      reciprocalRankFusion: roundScore(result.scores.reciprocalRankFusion),
      structuredBoost: roundScore(result.scores.structuredBoost),
      finalScore: roundScore(result.scores.final)
    }
  }));
  return {
    packetVersion: 1,
    visualBeat: {
      spokenText: optionalText(context.spokenText, 'Spoken text') ?? query.semanticText,
      paragraphContext: optionalText(context.paragraphContext, 'Paragraph context'),
      videoTheme: optionalText(context.videoTheme, 'Video theme'),
      visualQuery: query.semanticText
    },
    retrievalConstraints: {
      bookKeys: query.bookKeys,
      centralCharacterKeys: query.centralCharacterKeys,
      settingKeys: query.settingKeys,
      moodKeys: query.moodKeys,
      imageTypeKeys: query.imageTypeKeys,
      hardFiltersAlreadyApplied: [...(query.bookKeys.length ? ['bookKeys'] : []), ...(query.characterHardFilter && query.centralCharacterKeys.length ? ['centralCharacterKeys'] : [])]
    },
    selectionGuidance: [
      'Select exactly one candidate imageId from this packet, or null when none illustrates the visual beat adequately.',
      query.characterHardFilter ? 'Do not relax the already-applied book or central-character constraints.' : 'Treat named characters as ranking evidence, not a mandatory filter. Respect an explicit book constraint when present.',
      'Prioritize literal scene fit, then central-character fit, then mood; use retrieval scores as evidence rather than an automatic decision.',
      'Do not invent an imageId or use metadata outside this packet.'
    ],
    candidates,
    responseContract: {
      selectedImageId: 'one candidate imageId or null',
      reason: 'brief comparison grounded in candidate metadata and ranking evidence'
    }
  };
}
