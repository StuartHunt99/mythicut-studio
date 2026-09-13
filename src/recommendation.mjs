export function validateRecommendation(value, packet) {
  const keys = ['candidateId', 'caseId', 'reason', 'unresolved'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.join(',')) throw new Error('Invalid recommendation fields');
  if (value.caseId !== packet.caseId) throw new Error('Stale or unknown case');
  if (typeof value.unresolved !== 'boolean' || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 240) throw new Error('Invalid recommendation explanation');
  if (value.candidateId !== null && !packet.allowedCandidateIds.includes(value.candidateId)) throw new Error('Unknown candidate');
  if (value.candidateId === null && !value.unresolved) throw new Error('Resolved recommendation requires a candidate');
  return { ...value };
}
