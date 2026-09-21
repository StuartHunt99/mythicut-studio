import { createHash } from 'node:crypto';
import { validateSchemaDefinition, validateTagValues } from './schema.mjs';

export const RETRIEVAL_TEXT_VERSION = 'mythicut-retrieval-text-v1';

function normalizedText(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function buildRetrievalDocument(definition, input) {
  const schema = validateSchemaDefinition(definition);
  const values = validateTagValues(schema, input);
  const lines = [];
  const tagValues = [];
  for (const field of schema.fields) {
    if (!field.includeInRetrievalText) continue;
    if (field.type === 'free_text') {
      const value = normalizedText(values[field.key]);
      if (value) lines.push(`${normalizedText(field.label)}: ${value}`);
      continue;
    }
    const selected = new Set(values[field.key]);
    const options = field.options.filter(option => selected.has(option.key));
    for (const option of options) tagValues.push({ fieldKey: field.key, optionKey: option.key });
    if (options.length) lines.push(`${normalizedText(field.label)}: ${options.map(option => normalizedText(option.label)).join('; ')}`);
  }
  const text = lines.join('\n');
  const hash = createHash('sha256').update(`${RETRIEVAL_TEXT_VERSION}\n${text}`, 'utf8').digest('hex');
  return { version: RETRIEVAL_TEXT_VERSION, text, hash, tagValues };
}

export function safeFtsQuery(value) {
  const words = normalizedText(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 64) ?? [];
  return [...new Set(words)].map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ');
}
