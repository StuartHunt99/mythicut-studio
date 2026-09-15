import { createHash, randomUUID } from 'node:crypto';

const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_TYPES = new Set(['tags', 'free_text']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function definitionHash(definition) {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label} must be 1-${max} characters`);
  return value.trim();
}

export function inferFieldKey(label, used = new Set()) {
  const base = String(label ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'field';
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    const tail = `_${suffix++}`;
    key = `${base.slice(0, 64 - tail.length)}${tail}`;
  }
  return key;
}

export function inferOptionKey(label, used = new Set()) {
  return inferFieldKey(label, used);
}

export function validateSchemaDefinition(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 100) throw new Error('A schema needs 1-100 fields');
  const fieldKeys = new Set();
  const fieldIds = new Set();
  const fields = input.fields.map((field, index) => {
    if (!field || typeof field.id !== 'string' || !field.id || fieldIds.has(field.id)) throw new Error(`Field ${index + 1} needs a unique ID`);
    fieldIds.add(field.id);
    const label = text(field.label, `Field ${index + 1} label`);
    const key = field.key == null || field.key === '' ? inferFieldKey(label, fieldKeys) : text(field.key, `Field ${index + 1} key`, 64);
    if (!KEY.test(key) || fieldKeys.has(key)) throw new Error(`Field key “${key}” must be unique lower_snake_case`);
    fieldKeys.add(key);
    // enum and multi_enum are accepted only when reopening catalogs created by the first prototype.
    // The public schema interface is now tags (multi-value) or free_text.
    const type = field.type === 'free_text' || field.freeText === true ? 'free_text' : field.type === 'enum' || field.type === 'multi_enum' || field.type === 'tags' || field.type == null ? 'tags' : field.type;
    if (!FIELD_TYPES.has(type)) throw new Error(`Field ${key} has an unsupported type`);
    const options = [];
    if (type !== 'free_text') {
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 500) throw new Error(`Field ${key} needs 1-500 options`);
      const optionIds = new Set(); const optionKeys = new Set();
      for (const [optionIndex, option] of field.options.entries()) {
        if (!option || typeof option.id !== 'string' || !option.id || optionIds.has(option.id)) throw new Error(`Option ${optionIndex + 1} in ${key} needs a unique ID`);
        optionIds.add(option.id);
        const optionLabel = text(option.label ?? option.key, `Option ${optionIndex + 1} label`);
        const optionKey = option.key == null || option.key === '' ? inferOptionKey(optionLabel, optionKeys) : text(option.key, `Option ${optionIndex + 1} key`, 64);
        if (!KEY.test(optionKey) || optionKeys.has(optionKey)) throw new Error(`Option key “${optionKey}” in ${key} must be unique lower_snake_case`);
        optionKeys.add(optionKey);
        options.push({ id: option.id, key: optionKey, label: optionLabel });
      }
    } else if (field.options !== undefined && (!Array.isArray(field.options) || field.options.length)) {
      throw new Error(`Free-text field ${key} cannot define options`);
    }
    return { id: field.id, key, label, type, options, includeInRetrievalText: Boolean(field.includeInRetrievalText) };
  });
  return { schemaVersion: 1, fields };
}

export function createStarterDefinition(id = randomUUID) {
  const option = (key, label) => ({ id: id(), key, label });
  return validateSchemaDefinition({
    schemaVersion: 1,
    fields: [
      { id: id(), label: 'Setting', type: 'tags', options: [option('interior', 'Interior'), option('exterior', 'Exterior'), option('unknown', 'Unknown')], includeInRetrievalText: true },
      { id: id(), label: 'Subjects', type: 'tags', options: [option('person', 'Person'), option('animal', 'Animal'), option('landscape', 'Landscape'), option('object', 'Object')], includeInRetrievalText: true },
      { id: id(), key: 'scene_description', label: 'Scene Description', type: 'free_text', options: [], includeInRetrievalText: true }
    ]
  });
}

export function compileOutputSchema(definition) {
  const validated = validateSchemaDefinition(definition);
  const properties = {};
  for (const field of validated.fields) {
    if (field.type === 'free_text') properties[field.key] = { anyOf: [{ type: 'string' }, { type: 'null' }], description: field.label };
    else properties[field.key] = { type: 'array', items: { type: 'string', enum: field.options.map(option => option.key) }, description: field.label };
  }
  return { type: 'object', properties, required: validated.fields.map(field => field.key), additionalProperties: false };
}

export function validateTagValues(definition, input) {
  const schema = validateSchemaDefinition(definition);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tag output must be a JSON object');
  const expected = new Set(schema.fields.map(field => field.key));
  const actual = Object.keys(input);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) throw new Error('Tag output must contain exactly the published schema fields');
  const result = {};
  for (const field of schema.fields) {
    const value = input[field.key];
    if (field.type === 'free_text') {
      if (value !== null && typeof value !== 'string') throw new Error(`${field.label} must be text or null`);
      const normalized = value?.trim() ?? null;
      if (normalized && normalized.length > 4096) throw new Error(`${field.label} is too long`);
      result[field.key] = normalized || null;
      continue;
    }
    const allowed = new Set(field.options.map(option => option.key));
    // Scalar enum values from v1 catalogs are upgraded to a one-item tag array.
    const values = value === null ? [] : Array.isArray(value) ? value : [value];
    if (values.length > field.options.length || values.some(item => typeof item !== 'string' || !allowed.has(item))) throw new Error(`${field.label} must contain only known options`);
    const selected = new Set(values);
    result[field.key] = field.options.filter(option => selected.has(option.key)).map(option => option.key);
  }
  return result;
}
