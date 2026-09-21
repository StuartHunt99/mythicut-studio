import { join } from 'node:path';
import { safeFtsQuery } from './retrieval-text.mjs';
import { decodeFloat32LE, cosineForNormalizedVectors } from './vector-search.mjs';
import { fuseHybridRanks } from './hybrid-ranking.mjs';

const GENERIC_SUBJECT_KEYS = new Set(['person', 'animal', 'object', 'landscape']);

const uniqueStrings = (value, name, maximum = 100) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${name} must be an array of keys`);
  return [...new Set(value.map(item => item.trim()))];
};

function fieldOptions(definition, key) {
  const field = definition.fields.find(item => item.key === key);
  return { field, keys: new Set(field?.options?.map(option => option.key) ?? []) };
}

function validatedKeys(definition, key, value, name, { rejectGeneric = false } = {}) {
  const requested = uniqueStrings(value, name);
  const { field, keys } = fieldOptions(definition, key);
  if (!field && requested.length) throw new Error(`The active schema has no ${key} field`);
  for (const item of requested) {
    if (!keys.has(item)) throw new Error(`Unknown ${name} key: ${item}`);
    if (rejectGeneric && GENERIC_SUBJECT_KEYS.has(item)) throw new Error(`${item} is a generic subject, not a central character`);
  }
  return requested;
}

export function validateHybridQuery(definition, input = {}) {
  const semanticText = String(input.semanticText ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!semanticText || semanticText.length > 4_000) throw new Error('Semantic search text must be 1-4,000 characters');
  const bookKeys = validatedKeys(definition, 'book', input.bookKeys, 'book');
  if (!bookKeys.length) return { ok: false, code: 'missing_book', message: 'At least one canonical book is required for image search' };
  const limit = Number(input.limit ?? 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Search limit must be between 1 and 50');
  return {
    ok: true,
    semanticText,
    bookKeys,
    centralCharacterKeys: validatedKeys(definition, 'characters', input.centralCharacterKeys, 'central character', { rejectGeneric: true }),
    settingKeys: validatedKeys(definition, 'setting', input.settingKeys, 'setting'),
    moodKeys: validatedKeys(definition, 'mood', input.moodKeys, 'mood'),
    imageTypeKeys: validatedKeys(definition, 'image_type', input.imageTypeKeys, 'image type'),
    limit
  };
}

const ratio = (actual, requested) => {
  if (!requested.length) return 0;
  const present = new Set(Array.isArray(actual) ? actual : []);
  return requested.filter(value => present.has(value)).length / requested.length;
};

function resolvedImagePath(row) {
  return row.root_path && row.relative_path ? join(row.root_path, ...row.relative_path.split('/')) : row.display_path;
}

export async function searchHybridImages({ db, catalogId, schemaVersionId, profile, definition, query, embeddingModel }) {
  const validated = validateHybridQuery(definition, query);
  if (!validated.ok) return { ...validated, results: [] };
  const rows = db.prepare(`SELECT i.id image_id, i.display_path, i.filename, i.availability,
    v.id image_version_id, v.width, v.height, v.media_type,
    root.canonical_path root_path, ir.relative_path,
    tr.id revision_id, tr.values_json,
    rd.retrieval_text_hash, re.vector,
    (SELECT dr.coordinates_json FROM image_detection_results dr WHERE dr.image_version_id = v.id ORDER BY dr.created_at DESC LIMIT 1) detection_json
    FROM retrieval_documents rd
    JOIN images i ON i.id = rd.image_id AND i.active = 1 AND i.availability = 'present' AND i.current_version_id = rd.image_version_id
    JOIN image_versions v ON v.id = rd.image_version_id
    JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = rd.schema_version_id AND at.review_state = 'accepted' AND at.accepted_revision_id = rd.tag_revision_id
    JOIN tag_revisions tr ON tr.id = rd.tag_revision_id
    JOIN retrieval_embeddings re ON re.tag_revision_id = rd.tag_revision_id AND re.retrieval_text_hash = rd.retrieval_text_hash AND re.profile_id = ?
    LEFT JOIN image_roots ir ON ir.image_id = i.id AND ir.root_id = (SELECT min(ir2.root_id) FROM image_roots ir2 WHERE ir2.image_id = i.id AND ir2.present = 1)
    LEFT JOIN roots root ON root.id = ir.root_id
    WHERE i.catalog_id = ? AND rd.schema_version_id = ?`).all(profile.id, catalogId, schemaVersionId);
  const hardFiltered = rows.filter(row => {
    const values = JSON.parse(row.values_json);
    if (ratio(values.book, validated.bookKeys) === 0) return false;
    if (validated.centralCharacterKeys.length && ratio(values.characters, validated.centralCharacterKeys) === 0) return false;
    row.values = values;
    return true;
  });
  if (!hardFiltered.length) return { ok: true, query: validated, resultCount: 0, results: [] };

  const lexicalRanks = new Map();
  const ftsQuery = safeFtsQuery(validated.semanticText);
  if (ftsQuery) {
    const matches = db.prepare(`SELECT image_version_id FROM retrieval_fts
      WHERE retrieval_fts MATCH ? AND schema_version_id = ? ORDER BY rank LIMIT 500`).all(ftsQuery, schemaVersionId);
    matches.forEach((row, index) => lexicalRanks.set(row.image_version_id, index + 1));
  }

  const queryVector = await embeddingModel.embedQuery(validated.semanticText);
  const scored = hardFiltered.map(row => ({
    row,
    semanticScore: cosineForNormalizedVectors(queryVector, decodeFloat32LE(row.vector, profile.dimension))
  })).sort((left, right) => right.semanticScore - left.semanticScore || left.row.image_id.localeCompare(right.row.image_id));
  const candidates = scored.map((item, index) => ({
    imageId: item.row.image_id,
    imageVersionId: item.row.image_version_id,
    revisionId: item.row.revision_id,
    retrievalTextHash: item.row.retrieval_text_hash,
    filename: item.row.filename,
    path: resolvedImagePath(item.row),
    width: item.row.width,
    height: item.row.height,
    mediaType: item.row.media_type,
    availability: item.row.availability,
    values: item.row.values,
    detection: item.row.detection_json == null ? null : JSON.parse(item.row.detection_json),
    semanticScore: item.semanticScore,
    semanticRank: index + 1,
    lexicalRank: lexicalRanks.get(item.row.image_version_id) ?? null,
    characterMatchRatio: ratio(item.row.values.characters, validated.centralCharacterKeys),
    settingMatchRatio: ratio(item.row.values.setting, validated.settingKeys),
    moodMatchRatio: ratio(item.row.values.mood, validated.moodKeys),
    imageTypeMatchRatio: ratio(item.row.values.image_type, validated.imageTypeKeys)
  }));
  const results = fuseHybridRanks(candidates).slice(0, validated.limit).map(candidate => ({
    imageId: candidate.imageId,
    imageVersionId: candidate.imageVersionId,
    revisionId: candidate.revisionId,
    retrievalTextHash: candidate.retrievalTextHash,
    path: candidate.path,
    filename: candidate.filename,
    width: candidate.width,
    height: candidate.height,
    mediaType: candidate.mediaType,
    availability: candidate.availability,
    values: candidate.values,
    detection: candidate.detection,
    scores: {
      lexicalRank: candidate.lexicalRank,
      semanticRank: candidate.semanticRank,
      semantic: candidate.semanticScore,
      characterMatchRatio: candidate.characterMatchRatio,
      settingMatchRatio: candidate.settingMatchRatio,
      moodMatchRatio: candidate.moodMatchRatio,
      imageTypeMatchRatio: candidate.imageTypeMatchRatio,
      reciprocalRankFusion: candidate.rrfScore,
      structuredBoost: candidate.structuredBoost,
      final: candidate.finalScore
    },
    embeddingProfile: { id: profile.id, model: profile.model, revision: profile.model_revision, dimension: profile.dimension }
  }));
  return { ok: true, query: validated, resultCount: results.length, results };
}
