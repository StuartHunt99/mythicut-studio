import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { MockLanguageModelV4 } from 'ai/test';
import { compileOutputSchema, createStarterDefinition, definitionHash, validateSchemaDefinition, validateTagValues } from '../src/image-tagging/schema.mjs';
import { compileTaggingRequest } from '../src/image-tagging/prompt.mjs';
import { inspectImage, prepareImageForApi } from '../src/image-tagging/image-preparation.mjs';
import { createImageTagProvider } from '../src/image-tagging/providers/ai-sdk.mjs';
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

test('provider interface sends only the prepared image and returns normalized structured output', async () => {
  const model = new MockLanguageModelV4({
    provider: 'test-provider',
    modelId: 'test-vision',
    doGenerate: {
      content: [{ type: 'text', text: '{"setting":"interior"}' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 8, text: 8, reasoning: undefined }
      },
      response: { id: 'response-test', modelId: 'test-vision' },
      warnings: []
    }
  });
  const provider = createImageTagProvider({
    dialect: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: 60_000,
    modelFactory: () => model
  });
  const outputSchema = { type: 'object', properties: { setting: { type: 'string' } }, required: ['setting'], additionalProperties: false };
  const result = await provider.generateTags({ model: 'test-vision', image: { bytes: Buffer.from('prepared'), mediaType: 'image/jpeg', width: 640, height: 480, detail: 'low' }, systemText: 'system', userText: 'user', outputSchema });
  assert.deepEqual(result.values, { setting: 'interior' });
  assert.equal(result.providerRequestId, 'response-test');
  assert.equal(result.providerModel, 'test-vision');
  assert.equal(result.finishReason, 'stop');
  assert.equal(model.doGenerateCalls.length, 1);
  const call = model.doGenerateCalls[0];
  assert.equal(call.responseFormat.type, 'json');
  assert.deepEqual(call.responseFormat.schema, outputSchema);
  assert.equal(call.prompt[0].role, 'system');
  assert.equal(call.prompt[1].content[0].text, 'user');
  assert.equal(call.prompt[1].content[1].mediaType, 'image/jpeg');
  assert.equal(Buffer.from(call.prompt[1].content[1].data.data).toString(), 'prepared');
});

test('Google adapter uses the native Gemini image request while preserving the provider interface', async () => {
  let captured;
  const provider = createImageTagProvider({
    dialect: 'google',
    apiKey: 'google-test-key',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: 5_000,
    fetch: async (url, init) => {
      captured = { url: String(url), init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: '{"setting":"interior"}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, totalTokenCount: 18 },
        modelVersion: 'gemini-2.5-flash',
        responseId: 'gemini-response'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const result = await provider.generateTags({
    model: 'gemini-2.5-flash',
    image: { bytes: Buffer.from('prepared'), mediaType: 'image/jpeg', width: 640, height: 480, detail: 'low' },
    systemText: 'system',
    userText: 'user',
    outputSchema: { type: 'object', properties: { setting: { type: 'string' } }, required: ['setting'], additionalProperties: false }
  });
  assert.deepEqual(result.values, { setting: 'interior' });
  assert.equal(result.providerRequestId, 'gemini-response');
  assert.match(captured.url, /\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(captured.init.headers['x-goog-api-key'], 'google-test-key');
  assert.equal(captured.body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(captured.body.contents[0].parts[1].inlineData.data, 'base64').toString(), 'prepared');
  assert.equal(captured.body.generationConfig.responseMimeType, 'application/json');
});

test('provider logs request and error details when generation fails', async () => {
  const logs = [];
  const provider = createImageTagProvider({
    dialect: 'google',
    apiKey: 'google-test-key',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: 5_000,
    logger: event => logs.push(event),
    generate: async () => {
      throw Object.assign(new Error('API rejected the request'), { status: 400, body: { error: { message: 'bad request' } } });
    }
  });

  await assert.rejects(() => provider.generateTags({
    model: 'gemini-2.5-flash',
    image: { bytes: Buffer.from('prepared'), mediaType: 'image/jpeg', width: 640, height: 480, detail: 'low' },
    systemText: 'system',
    userText: 'user',
    outputSchema: { type: 'object', properties: { setting: { type: 'string' } }, required: ['setting'], additionalProperties: false }
  }), /API rejected the request/);

  assert.equal(logs[0].kind, 'request');
  assert.equal(logs[1].kind, 'error');
  assert.equal(logs[1].error.message, 'API rejected the request');
  assert.equal(logs[1].error.status, 400);
  assert.equal(logs[1].model, 'gemini-2.5-flash');
  assert.equal('systemText' in logs[1].request, true);
  assert.equal('systemText' in logs[1].request, true);
});

test('provider keeps compact error summaries for persisted failures', async () => {
  const errors = [];
  const provider = createImageTagProvider({
    dialect: 'google',
    apiKey: 'google-test-key',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: 5_000,
    logger: event => errors.push(event),
    generate: async () => {
      throw Object.assign(new Error('API rejected the request'), { status: 400, body: { error: { message: 'bad request' } } });
    }
  });

  await assert.rejects(() => provider.generateTags({
    model: 'gemini-2.5-flash',
    image: { bytes: Buffer.from('prepared'), mediaType: 'image/jpeg', width: 640, height: 480, detail: 'low' },
    systemText: 'system',
    userText: 'user',
    outputSchema: { type: 'object', properties: { setting: { type: 'string' } }, required: ['setting'], additionalProperties: false }
  }), /API rejected the request/);

  const summary = errors[1].error;
  assert.equal(summary.message, 'API rejected the request');
  assert.equal(summary.status, 400);
  assert.equal(summary.providerCode, undefined);
  assert.equal(typeof errors[1].request.systemText, 'string');
  assert.equal('requestContext' in Object(errors[1]), false);
});

test('catalog accepts a native Google Gemini provider profile', async t => {
  const catalog = await openImageCatalog({ databasePath: ':memory:' });
  t.after(() => catalog.close());
  const profile = await catalog.execute('provider.save', {
    name: 'Gemini',
    dialect: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    credentialRef: 'credential-reference',
    settings: { imagePreset: 'economy', timeoutMs: 60_000 }
  });
  assert.equal(profile.dialect, 'google');
  assert.equal(profile.endpoint, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(profile.hasCredential, true);
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
    providerFactory: () => ({ generateTags: async () => {
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
