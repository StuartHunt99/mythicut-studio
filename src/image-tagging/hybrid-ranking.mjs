const rankContribution = (rank, weight, constant) => rank == null ? 0 : weight / (constant + rank);

export function fuseHybridRanks(candidates, {
  lexicalWeight = 1,
  semanticWeight = 1,
  rrfConstant = 60
} = {}) {
  return candidates.map(candidate => {
    const rrfScore = rankContribution(candidate.lexicalRank, lexicalWeight, rrfConstant)
      + rankContribution(candidate.semanticRank, semanticWeight, rrfConstant);
    const structuredBoost = (candidate.characterMatchRatio ?? 0) * 0.003
      + (candidate.settingMatchRatio ?? 0) * 0.0015
      + (candidate.moodMatchRatio ?? 0) * 0.00075
      + (candidate.imageTypeMatchRatio ?? 0) * 0.0005;
    return { ...candidate, rrfScore, structuredBoost, finalScore: rrfScore + structuredBoost };
  }).sort((left, right) => right.finalScore - left.finalScore
    || (right.semanticScore ?? -Infinity) - (left.semanticScore ?? -Infinity)
    || left.imageId.localeCompare(right.imageId));
}
