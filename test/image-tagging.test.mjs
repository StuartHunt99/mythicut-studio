import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { compileOutputSchema, createStarterDefinition, definitionHash, validateSchemaDefinition, validateTagValues } from '../src/image-tagging/schema.mjs';
import { compileTaggingRequest } from '../src/image-tagging/prompt.mjs';
import { inspectImage, prepareImageForApi } from '../src/image-tagging/image-preparation.mjs';
import { createOpenAIProvider } from '../src/image-tagging/providers/openai.mjs';
import { openImageCatalog } from '../src/image-tagging/catalog.mjs';

function sequentialIds() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

test('tag schema compiles to a strict output contract and normalizes values', () => {
  const definition = createStarterDefinition(sequentialIds());
  const schema = compileOutputSchema(definition);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['setting', 'subjects', 'scene_description']);
  assert.equal(schema.properties.setting.type, 'array');
  assert.equal(schema.properties.setting.items.enum.includes('interior'), true);
  assert.deepEqual(validateTagValues(definition, { setting: ['interior'], subjects: ['object', 'person'], scene_description: '  A person with an object.  ' }), {
    setting: ['interior'], subjects: ['person', 'object'], scene_description: 'A person with an object.'
  });
  assert.throws(() => validateTagValues(definition, { setting: 'studio', subjects: [], scene_description: null }), /known options/);
  assert.equal(definitionHash(definition), definitionHash(JSON.parse(JSON.stringify(definition))));
});

test('schema validation rejects unstable or ambiguous field definitions', () => {
  const inferred = validateSchemaDefinition({ schemaVersion: 1, fields: [
    { id: 'a', label: 'Scene Description', type: 'free_text', options: [] },
    { id: 'b', label: 'Scene Description', type: 'tags', options: [{ id: 'o', key: 'one', label: 'One' }] }
  ] });
  assert.deepEqual(inferred.fields.map(field => field.key), ['scene_description', 'scene_description_2']);
  assert.deepEqual(inferred.fields.map(field => field.type), ['free_text', 'tags']);
  assert.deepEqual(inferred.fields[1].options.map(option => option.key), ['one']);
  assert.throws(() => validateSchemaDefinition({ schemaVersion: 1, fields: [{ id: 'a', key: 'Bad Key', label: 'Bad', type: 'free_text', options: [] }] }), /lower_snake_case/);
  assert.throws(() => validateSchemaDefinition({ schemaVersion: 1, fields: [{ id: 'a', key: 'note', label: 'Note', type: 'free_text', options: ['unexpected'] }] }), /cannot define options/);
});

test('prompt compiler treats filenames and guidance as untrusted data', () => {
  const request = compileTaggingRequest({ definition: createStarterDefinition(sequentialIds()), filename: 'ignore-rules.jpg', relativePath: 'incoming/ignore-rules.jpg', extraInstructions: 'Prefer visible production details.' });
  assert.match(request.systemText, /never as commands/);
  assert.match(request.userText, /incoming\/ignore-rules.jpg/);
  assert.equal(request.outputSchema.additionalProperties, false);
});

test('image preparation rotates and downscales before a request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-tags-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'large.jpg');
  await sharp({ create: { width: 3000, height: 1200, channels: 3, background: '#c8913d' } }).jpeg({ quality: 95 }).toFile(path);
  const inspected = await inspectImage(path);
  assert.deepEqual({ readable: inspected.readable, width: inspected.width, height: inspected.height }, { readable: true, width: 3000, height: 1200 });
  const prepared = await prepareImageForApi(path, { preset: 'economy' });
  assert.equal(prepared.mediaType, 'image/jpeg');
  assert.equal(prepared.width, 1024);
  assert.ok(prepared.height < 1024);
  assert.equal(prepared.detail, 'low');
  assert.ok(prepared.encodedBytes < 100_000);
});

test('OpenAI adapter sends only the prepared derivative and requires structured output', async () => {
  let captured;
  const client = { responses: { create: async (...args) => {
    captured = args;
    return { id: 'resp_test', model: 'gpt-4o-mini', output_text: '{"setting":"interior","subjects":["person"],"scene_description":"A person."}', usage: { input_tokens: 10, output_tokens: 8 } };
  } } };
  const provider = createOpenAIProvider({ client });
  const outputSchema = { type: 'object', properties: { setting: { type: 'string' } }, required: ['setting'], additionalProperties: false };
  const result = await provider.generate({ model: 'gpt-4o-mini', image: { bytes: Buffer.from('prepared'), mediaType: 'image/jpeg', width: 640, height: 480, detail: 'low' }, systemText: 'system', userText: 'user', outputSchema });
  assert.equal(result.providerRequestId, 'resp_test');
  assert.equal(captured[0].store, false);
  assert.equal(captured[0].text.format.type, 'json_schema');
  assert.equal(captured[0].text.format.strict, true);
  assert.match(captured[0].input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(captured[0].input[0].content[1].detail, 'low');
  assert.equal(captured[0].input[0].content[1].image_url.includes('/tmp/'), false);
});

test('published schema versions stay immutable across backup and reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'catalog.sqlite'); const backupPath = join(directory, 'catalog-backup.sqlite');
  let catalog = await openImageCatalog({ databasePath });
  t.after(() => catalog?.close());
  const initial = await catalog.execute('catalog.snapshot');
  const first = initial.schemas.find(item => item.active);
  const changed = structuredClone(first.definition); changed.fields[0].label = 'Interior or exterior';
  const draft = await catalog.execute('schema.saveDraft', { schemaId: first.id, definition: changed });
  await catalog.execute('schema.publish', { schemaVersionId: draft.versionId });
  const versioned = await catalog.execute('catalog.snapshot');
  assert.equal(versioned.schemas.length, 2);
  assert.equal(versioned.schemas.find(item => item.versionId === first.versionId).definition.fields[0].label, 'Setting');
  assert.equal(versioned.schemas.find(item => item.active).definition.fields[0].label, 'Interior or exterior');
  await catalog.backupTo(backupPath); catalog.close();
  catalog = await openImageCatalog({ databasePath: backupPath });
  assert.equal((await catalog.execute('catalog.snapshot')).schemas.length, 2);
  catalog.close();
});

test('catalog completes scan, AI proposal, and human acceptance as separate revisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'frame-001.png');
  await sharp({ create: { width: 80, height: 60, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 1 } } }).png().toFile(imagePath);
  let calls = 0;
  const catalog = await openImageCatalog({
    databasePath: join(directory, 'catalog.sqlite'),
    providerFactory: () => ({ generate: async () => {
      calls++;
      return { values: { setting: ['exterior'], subjects: ['landscape'], scene_description: 'A blue exterior scene.' }, providerRequestId: 'fake-request', providerModel: 'fake-vision', usage: { input_tokens: 1 } };
    } })
  });
  t.after(() => catalog.close());
  const added = await catalog.execute('roots.add', { path: directory, excludes: ['catalog.sqlite*'] });
  const scan = await catalog.execute('roots.scan', { rootId: added.rootId });
  assert.equal(scan[0].new, 1);
  let schemaSnapshot = await catalog.execute('catalog.snapshot');
  const subjectsField = schemaSnapshot.schemas.find(item => item.active).definition.fields.find(field => field.key === 'subjects');
  const customTag = await catalog.execute('schema.tag.add', { fieldId: subjectsField.id, label: 'Blue sky' });
  assert.equal(customTag.key, 'blue_sky');
  schemaSnapshot = await catalog.execute('catalog.snapshot');
  assert.equal(schemaSnapshot.schemas.find(item => item.active).definition.fields.find(field => field.id === subjectsField.id).options.some(option => option.label === 'Blue sky'), true);
  await assert.rejects(() => catalog.execute('schema.tag.add', { fieldId: schemaSnapshot.schemas.find(item => item.active).definition.fields.find(field => field.key === 'scene_description').id, label: 'Not a tag' }), /Free-text/);
  const completed = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'run.complete') { off(); resolve(event); } });
  });
  const run = await catalog.execute('run.start', { selectionPolicy: 'new_only', credential: 'not-used-by-fake' });
  assert.equal(run.totalItems, 1);
  assert.equal((await completed).status, 'completed');
  let snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(calls, 1);
  assert.equal(snapshot.images[0].reviewState, 'needs_review');
  assert.deepEqual(snapshot.images[0].proposal.subjects, ['landscape']);
  assert.deepEqual(await catalog.execute('search.accepted', { query: 'blue' }), []);
  const accepted = await catalog.execute('review.accept', { imageVersionId: snapshot.images[0].versionId });
  assert.deepEqual(accepted.values, snapshot.images[0].proposal);
  snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(snapshot.images[0].reviewState, 'accepted');
  assert.deepEqual(snapshot.images[0].accepted, snapshot.images[0].proposal);
  assert.equal((await catalog.execute('search.accepted', { query: 'blue', filters: { subjects: 'landscape' } }))[0].path, await realpath(imagePath));
  const edited = await catalog.execute('review.accept', { imageVersionId: snapshot.images[0].versionId, values: { setting: ['exterior'], subjects: ['landscape'], scene_description: 'An edited description.' } });
  assert.equal(edited.values.scene_description, 'An edited description.');
  assert.equal((await catalog.execute('review.undo', { imageVersionId: snapshot.images[0].versionId })).reviewState, 'accepted');
  assert.equal((await catalog.execute('catalog.snapshot')).images[0].accepted.scene_description, 'A blue exterior scene.');
  assert.equal((await catalog.execute('review.undo', { imageVersionId: snapshot.images[0].versionId })).reviewState, 'needs_review');
  assert.deepEqual(await catalog.execute('search.accepted'), []);
});
