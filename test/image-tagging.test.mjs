import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { MockLanguageModelV4 } from 'ai/test';
import { compileOutputSchema, createStarterDefinition, definitionHash, validateSchemaDefinition, validateTagValues } from '../src/image-tagging/schema.mjs';
import { compileTaggingRequest } from '../src/image-tagging/prompt.mjs';
import { inspectImage, prepareImageForApi } from '../src/image-tagging/image-preparation.mjs';
import { createImageTagProvider } from '../src/image-tagging/providers/ai-sdk.mjs';
import { BEAT_PROPOSAL_SCHEMA } from '../src/broll-beats.mjs';
import { openImageCatalog } from '../src/image-tagging/catalog.mjs';
import { openCatalogDatabase } from '../src/image-tagging/database.mjs';
import { BGE_SMALL_PROFILE } from '../src/image-tagging/embedding-model.mjs';
import { buildRetrievalDocument } from '../src/image-tagging/retrieval-text.mjs';
import { decodeFloat32LE, encodeFloat32LE } from '../src/image-tagging/vector-search.mjs';

function sequentialIds() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function fakeEmbedding(text) {
  const vector = new Float32Array(BGE_SMALL_PROFILE.dimension);
  for (const word of String(text).toLocaleLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    vector[hash % vector.length] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

const fakeEmbeddingFactory = async () => ({
  profile: BGE_SMALL_PROFILE,
  embedDocuments: async texts => texts.map(fakeEmbedding),
  embedQuery: async text => fakeEmbedding(text),
  close: async () => {}
});

test('catalog reopens when Git converts migration files to Windows line endings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-migration-eol-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'catalog.sqlite');
  const created = await openCatalogDatabase(databasePath);
  created.close();
  const reopened = await openCatalogDatabase(databasePath, {
    readMigration: async url => (await readFile(url, 'utf8')).replace(/\r\n?/g, '\n').replaceAll('\n', '\r\n')
  });
  assert.equal(reopened.db.prepare('SELECT count(*) count FROM migrations').get().count, 4);
  reopened.close();
});

test('catalog upgrades legacy raw migration checksums', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-legacy-checksum-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'catalog.sqlite');
  const created = await openCatalogDatabase(databasePath);
  created.close();

  const legacy = new DatabaseSync(databasePath);
  for (const [version, filename] of [[1, '001-initial.sql'], [2, '002-tag-vocabulary.sql']]) {
    const sql = await readFile(new URL(`../src/image-tagging/migrations/${filename}`, import.meta.url));
    legacy.prepare('UPDATE migrations SET checksum = ? WHERE version = ?')
      .run(createHash('sha256').update(sql).digest('hex'), version);
  }
  legacy.close();

  const reopened = await openCatalogDatabase(databasePath);
  const checksums = reopened.db.prepare('SELECT checksum FROM migrations ORDER BY version').all().map(row => row.checksum);
  const canonicalChecksums = [];
  for (const filename of ['001-initial.sql', '002-tag-vocabulary.sql', '003-object-detection.sql', '004-hybrid-retrieval.sql']) {
    const sql = await readFile(new URL(`../src/image-tagging/migrations/${filename}`, import.meta.url), 'utf8');
    canonicalChecksums.push(createHash('sha256').update(sql.replace(/\r\n?/g, '\n')).digest('hex'));
  }
  assert.deepEqual(checksums, canonicalChecksums);
  reopened.close();
});

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
  const logs = [];
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
    modelFactory: () => model,
    logger: event => logs.push(event)
  });
  const outputSchema = { type: 'object', properties: { setting: { type: 'string' } }, required: ['setting'], additionalProperties: false };
  const result = await provider.generateTags({ model: 'test-vision', image: { bytes: Buffer.from('prepared'), mediaType: 'image/jpeg', width: 640, height: 480, detail: 'low' }, systemText: 'system', userText: 'user', outputSchema });
  assert.deepEqual(result.values, { setting: 'interior' });
  assert.equal(result.providerRequestId, 'response-test');
  assert.equal(result.providerModel, 'test-vision');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(logs[1].response.output, { setting: 'interior' });
  assert.equal(logs[1].response.text, '{"setting":"interior"}');
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
  assert.deepEqual(captured.body.generationConfig.responseJsonSchema, {
    type: 'object',
    properties: { setting: { type: 'string' } },
    required: ['setting'],
    additionalProperties: false
  });
  assert.deepEqual(captured.body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
});

test('hosted text agent reuses configured provider dialect and structured output without image input', async () => {
  let captured;
  const provider = createImageTagProvider({ dialect: 'google', apiKey: 'test-key', endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    modelFactory: name => ({ id: name }), logger: () => {},
    generate: async options => { captured = options; return { output: { beats: [] }, response: { id: 'request-1', modelId: 'gemini-test' }, usage: { totalTokens: 10 } }; } });
  const result = await provider.generateStructuredText({ model: 'gemini-test', systemText: 'System', userText: 'User',
    outputSchema: { type: 'object', properties: { beats: { type: 'array', items: { type: 'object' } } }, required: ['beats'] } });
  assert.deepEqual(result.values, { beats: [] });
  assert.equal(captured.instructions, 'System');
  assert.deepEqual(captured.messages[0].content, [{ type: 'text', text: 'User' }]);
  assert.equal(captured.providerOptions.google.structuredOutputs, true);
  assert.equal(result.providerRequestId, 'request-1');
});

test('Gemini beat planning sends the compact provider schema once and parses the response', async () => {
  let request;
  const provider = createImageTagProvider({ dialect: 'google', apiKey: 'test-key', logger: () => {},
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ beats: [{
        startWordId: 'w0', endWordId: 'w1', visualIntent: 'A forest', artworkNeed: 'optional', talkingHeadPriority: 'normal',
        searchQuery: 'forest', reason: 'The story enters a forest.'
      }] }) }] }, finishReason: 'STOP' }] });
    } });
  const response = await provider.generateStructuredText({ model: 'gemini-3.6-flash', systemText: 'Plan beats',
    userText: 'Two words', outputSchema: BEAT_PROPOSAL_SCHEMA });
  assert.equal(request.generationConfig.responseMimeType, 'application/json');
  assert.equal(request.generationConfig.responseJsonSchema.properties.beats.maxItems, undefined);
  assert.equal(request.generationConfig.responseJsonSchema.properties.beats.items.additionalProperties, undefined);
  assert.equal('bookKeys' in request.generationConfig.responseJsonSchema.properties.beats.items.properties, false);
  assert.doesNotMatch(request.systemInstruction.parts[0].text, /"startWordId"/);
  assert.equal(response.values.beats[0].startWordId, 'w0');
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

test('catalog roots can be relocated without losing image identity or relative links', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-relocate-'));
  const originalRoot = join(directory, 'Old drive', 'Artwork');
  const relocatedRoot = join(directory, 'New drive', 'Artwork');
  await mkdir(originalRoot, { recursive: true });
  const originalImage = join(originalRoot, 'chapter-one', 'frame.png');
  await mkdir(join(originalRoot, 'chapter-one'));
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#345678' } }).png().toFile(originalImage);
  const catalog = await openImageCatalog({ databasePath: join(directory, 'catalog.sqlite') });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const added = await catalog.execute('roots.add', { path: originalRoot });
  await catalog.execute('roots.scan', { rootId: added.rootId });
  const before = await catalog.execute('catalog.snapshot');

  await mkdir(join(directory, 'New drive'), { recursive: true });
  await rename(originalRoot, relocatedRoot);
  const relocated = await catalog.execute('roots.relocate', { rootId: added.rootId, path: relocatedRoot });
  const after = await catalog.execute('catalog.snapshot');

  assert.equal(relocated.imageCount, 1);
  assert.equal(after.roots[0].path, await realpath(relocatedRoot));
  assert.equal(after.images[0].id, before.images[0].id);
  assert.equal(after.images[0].versionId, before.images[0].versionId);
  assert.equal(after.images[0].path, await realpath(join(relocatedRoot, 'chapter-one', 'frame.png')));
  const rescan = await catalog.execute('roots.scan', { rootId: added.rootId });
  assert.equal(rescan[0].unchanged, 1);
});

test('text-agent errors retain provider status and safe response detail for worker diagnostics', async () => {
  const provider = createImageTagProvider({ dialect: 'google', apiKey: 'test-key', logger: () => {},
    generate: async () => { throw Object.assign(new Error('Request contains an invalid argument.'), {
      statusCode: 400, responseBody: JSON.stringify({ error: { message: 'Response schema is too complex' } })
    }); } });
  await assert.rejects(() => provider.generateStructuredText({ model: 'gemini-test', systemText: 'System', userText: 'User',
    outputSchema: { type: 'object', properties: { beats: { type: 'array', items: { type: 'string' } } }, required: ['beats'] } }), error => {
    assert.equal(error.requestContext.error.statusCode, 400);
    assert.equal(error.requestContext.error.providerMessage, 'Response schema is too complex');
    assert.equal('responseBody' in error.requestContext.error, false);
    return true;
  });
});

test('text-agent parse failures retain the provider response text for diagnostics', async () => {
  const logs = [];
  const provider = createImageTagProvider({ dialect: 'google', apiKey: 'test-key', logger: event => logs.push(event),
    generate: async () => { throw Object.assign(new Error('No object generated'), { text: '```json\n{ "beats": [] }\n```' }); } });
  await assert.rejects(() => provider.generateStructuredText({ model: 'gemini-test', systemText: 'System', userText: 'User',
    outputSchema: { type: 'object', properties: { beats: { type: 'array' } }, required: ['beats'] } }), /No object generated/);
  assert.equal(logs.at(-1).kind, 'error');
  assert.equal(logs.at(-1).error.responseText, '```json\n{ "beats": [] }\n```');
});

test('catalog snapshots can filter to selected roots while including subfolders', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-root-filter-'));
  const firstRoot = join(directory, 'first');
  const secondRoot = join(directory, 'second');
  await mkdir(join(firstRoot, 'nested'), { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#345678' } }).png().toFile(join(firstRoot, 'nested', 'child.png'));
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#785634' } }).png().toFile(join(secondRoot, 'other.png'));
  const catalog = await openImageCatalog({ databasePath: join(directory, 'catalog.sqlite') });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const first = await catalog.execute('roots.add', { path: firstRoot });
  const second = await catalog.execute('roots.add', { path: secondRoot });
  await catalog.execute('roots.scan', { rootId: first.rootId });
  await catalog.execute('roots.scan', { rootId: second.rootId });

  const filtered = await catalog.execute('catalog.snapshot', { rootIds: [first.rootId] });
  assert.equal(filtered.imageCount, 1);
  assert.deepEqual(filtered.images.map(image => image.filename), ['child.png']);
  const empty = await catalog.execute('catalog.snapshot', { rootIds: [] });
  assert.equal(empty.imageCount, 0);
  assert.deepEqual(empty.images, []);
  assert.equal((await catalog.execute('catalog.snapshot')).imageCount, 2);
  assert.equal(second.rootId !== first.rootId, true);
});

test('catalog completes scan, AI proposal, and human acceptance as separate revisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-catalog-'));
  const imagePath = join(directory, 'frame-001.png');
  await sharp({ create: { width: 80, height: 60, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 1 } } }).png().toFile(imagePath);
  let calls = 0;
  const catalog = await openImageCatalog({
    databasePath: join(directory, 'catalog.sqlite'),
    providerFactory: () => ({ generateTags: async () => {
      calls++;
      return { values: calls === 1
        ? { setting: ['exterior'], subjects: ['landscape'], scene_description: 'A blue exterior scene.' }
        : { setting: ['interior'], subjects: ['object'], scene_description: 'A retagged interior scene.' }, providerRequestId: 'fake-request', providerModel: 'fake-vision', usage: { input_tokens: 1 } };
    } })
  });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
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
  assert.equal(snapshot.images[0].runState, 'succeeded');
  assert.deepEqual(snapshot.images[0].proposal.subjects, ['landscape']);
  assert.deepEqual(await catalog.execute('search.accepted', { query: 'blue' }), []);
  const accepted = await catalog.execute('review.accept', { imageVersionId: snapshot.images[0].versionId });
  assert.deepEqual(accepted.values, snapshot.images[0].proposal);
  snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(snapshot.images[0].reviewState, 'accepted');
  assert.deepEqual(snapshot.images[0].accepted, snapshot.images[0].proposal);
  assert.equal((await catalog.execute('search.accepted', { query: 'blue', filters: { subjects: 'landscape' } }))[0].path, await realpath(imagePath));
  const retagged = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'run.complete') { off(); resolve(event); } });
  });
  await catalog.execute('run.start', { selectionPolicy: 'force_all', credential: 'not-used-by-fake' });
  assert.equal((await retagged).status, 'completed');
  snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(snapshot.images[0].reviewState, 'needs_review');
  assert.equal(snapshot.images[0].accepted.scene_description, 'A blue exterior scene.');
  assert.equal(snapshot.images[0].proposal.scene_description, 'A retagged interior scene.');
  const edited = await catalog.execute('review.accept', { imageVersionId: snapshot.images[0].versionId, values: { setting: ['exterior'], subjects: ['landscape'], scene_description: 'An edited description.' } });
  assert.equal(edited.values.scene_description, 'An edited description.');
  assert.equal((await catalog.execute('review.undo', { imageVersionId: snapshot.images[0].versionId })).reviewState, 'accepted');
  assert.equal((await catalog.execute('catalog.snapshot')).images[0].accepted.scene_description, 'A blue exterior scene.');
  assert.equal((await catalog.execute('review.undo', { imageVersionId: snapshot.images[0].versionId })).reviewState, 'needs_review');
  assert.deepEqual(await catalog.execute('search.accepted'), []);
});

test('B-roll artwork editor revises accepted tags and deactivates images without deleting them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-artwork-edit-'));
  await sharp({ create: { width: 40, height: 24, channels: 3, background: '#456789' } })
    .png().toFile(join(directory, 'scene.png'));
  const catalog = await openImageCatalog({ databasePath: join(directory, 'catalog.sqlite') });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const root = await catalog.execute('roots.add', { path: directory, excludes: ['catalog.sqlite*'] });
  await catalog.execute('roots.scan', { rootId: root.rootId });
  const first = (await catalog.execute('catalog.snapshot')).images[0];
  const originalValues = { setting: ['interior'], subjects: ['object'], scene_description: 'A room.' };
  const accepted = await catalog.execute('review.accept', { imageVersionId: first.versionId, values: originalValues });
  const image = (await catalog.execute('images.resolve', { imageIds: [first.id] }))[0];
  assert.deepEqual(image.accepted, originalValues);
  const editedValues = { ...originalValues, scene_description: 'An edited room.' };
  const edited = await catalog.execute('review.editArtwork', { imageId: first.id,
    expectedImageVersionId: first.versionId, expectedRevisionId: accepted.revisionId,
    values: editedValues, active: false });
  assert.notEqual(edited.revisionId, accepted.revisionId);
  assert.equal(edited.active, false);
  assert.equal(edited.tagsChanged, true);
  const current = (await catalog.execute('images.resolve', { imageIds: [first.id] }))[0];
  assert.equal(current.active, false);
  assert.deepEqual(current.accepted, editedValues);
  assert.deepEqual(await catalog.execute('search.accepted', { query: 'edited' }), []);
  await assert.rejects(() => catalog.execute('review.editArtwork', { imageId: first.id,
    expectedImageVersionId: first.versionId, expectedRevisionId: accepted.revisionId,
    values: originalValues, active: true }), /changed; reopen/);
  const reactivated = await catalog.execute('review.editArtwork', { imageId: first.id,
    expectedImageVersionId: first.versionId, expectedRevisionId: edited.revisionId,
    values: editedValues, active: true });
  assert.equal(reactivated.revisionId, edited.revisionId);
  assert.equal((await catalog.execute('images.resolve', { imageIds: [first.id] }))[0].active, true);
  assert.equal((await catalog.execute('search.accepted', { query: 'edited' }))[0].imageId, first.id);
});

test('bulk review adds and removes tag values across selected images', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-bulk-review-'));
  for (const filename of ['a.png', 'b.png']) {
    await sharp({ create: { width: 30, height: 20, channels: 3, background: '#345678' } }).png().toFile(join(directory, filename));
  }
  const catalog = await openImageCatalog({ databasePath: join(directory, 'catalog.sqlite') });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const added = await catalog.execute('roots.add', { path: directory, excludes: ['catalog.sqlite*'] });
  await catalog.execute('roots.scan', { rootId: added.rootId });
  let snapshot = await catalog.execute('catalog.snapshot');
  const schema = snapshot.schemas.find(item => item.active);
  const subjects = schema.definition.fields.find(field => field.key === 'subjects');
  const graphic = await catalog.execute('schema.tag.add', { schemaVersionId: schema.versionId, fieldId: subjects.id, label: 'Graphic' });
  const scene = await catalog.execute('schema.tag.add', { schemaVersionId: schema.versionId, fieldId: subjects.id, label: 'Scene' });
  const first = snapshot.images.find(image => image.filename === 'a.png');
  const second = snapshot.images.find(image => image.filename === 'b.png');
  await catalog.execute('review.accept', { imageVersionId: first.versionId, values: { setting: ['interior'], subjects: [graphic.key], scene_description: 'First' } });
  await catalog.execute('review.accept', { imageVersionId: second.versionId, values: { setting: ['interior'], subjects: ['landscape'], scene_description: 'Second' } });

  const result = await catalog.execute('review.bulk.accept', {
    imageVersionIds: [first.versionId, second.versionId],
    changes: { subjects: { add: [scene.key], remove: [graphic.key] }, scene_description: { set: 'Shared description' } }
  });
  assert.equal(result.count, 2);
  snapshot = await catalog.execute('catalog.snapshot');
  assert.deepEqual(snapshot.images.find(image => image.filename === 'a.png').accepted.subjects, [scene.key]);
  assert.deepEqual(snapshot.images.find(image => image.filename === 'b.png').accepted.subjects, ['landscape', scene.key]);
  assert.equal(snapshot.images.every(image => image.accepted.scene_description === 'Shared description'), true);
});

test('selected tagging runs only on requested images and proposals can be batch accepted unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-selected-run-'));
  const paths = ['a.png', 'b.png'].map(filename => join(directory, filename));
  for (const path of paths) await sharp({ create: { width: 30, height: 20, channels: 3, background: '#345678' } }).png().toFile(path);
  let calls = 0;
  const catalog = await openImageCatalog({
    databasePath: join(directory, 'catalog.sqlite'),
    providerFactory: () => ({ generateTags: async () => {
      calls++;
      return { values: { setting: ['interior'], subjects: ['object'], scene_description: 'Selected only.' }, providerRequestId: 'selected-run', providerModel: 'fake-vision', usage: {} };
    } })
  });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const added = await catalog.execute('roots.add', { path: directory, excludes: ['catalog.sqlite*'] });
  await catalog.execute('roots.scan', { rootId: added.rootId });
  let snapshot = await catalog.execute('catalog.snapshot');
  const selected = snapshot.images.find(image => image.filename === 'a.png');
  const completed = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'run.complete') { off(); resolve(event); } });
  });
  const run = await catalog.execute('run.start', { selectionPolicy: 'force_all', imageVersionIds: [selected.versionId], credential: 'not-used-by-fake' });
  assert.equal(run.totalItems, 1);
  assert.equal((await completed).status, 'completed');
  snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(calls, 1);
  assert.equal(snapshot.images.find(image => image.filename === 'a.png').proposal.scene_description, 'Selected only.');
  assert.equal(snapshot.images.find(image => image.filename === 'b.png').proposal, null);
  const accepted = await catalog.execute('review.bulk.accept', { imageVersionIds: [selected.versionId], changes: {} });
  assert.equal(accepted.count, 1);
  snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(snapshot.images.find(image => image.filename === 'a.png').accepted.scene_description, 'Selected only.');
  assert.equal(snapshot.images.find(image => image.filename === 'b.png').reviewState, 'not_ready');
});

test('retry failed selects only images whose latest tag attempt failed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-retry-failed-'));
  for (const filename of ['good.png', 'failed.png']) {
    await sharp({ create: { width: 30, height: 20, channels: 3, background: '#345678' } }).png().toFile(join(directory, filename));
  }
  const calls = [];
  let failedOnce = false;
  const catalog = await openImageCatalog({
    databasePath: join(directory, 'catalog.sqlite'),
    providerFactory: () => ({ generateTags: async request => {
      const filename = request.userText.includes('failed.png') ? 'failed.png' : 'good.png';
      calls.push(filename);
      if (filename === 'failed.png' && !failedOnce) { failedOnce = true; throw new Error('Temporary provider failure'); }
      return {
        values: { setting: ['interior'], subjects: ['object'], scene_description: `${filename} tagged.` },
        providerRequestId: `request-${calls.length}`, providerModel: 'fake-vision', finishReason: 'stop', usage: {}
      };
    } })
  });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const added = await catalog.execute('roots.add', { path: directory, excludes: ['catalog.sqlite*'] });
  await catalog.execute('roots.scan', { rootId: added.rootId });
  const firstCompleted = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'run.complete') { off(); resolve(event); } });
  });
  const first = await catalog.execute('run.start', { selectionPolicy: 'new_only', credential: 'not-used-by-fake' });
  assert.equal(first.totalItems, 2);
  await firstCompleted;
  const retryCompleted = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'run.complete') { off(); resolve(event); } });
  });
  const retry = await catalog.execute('run.start', { selectionPolicy: 'retry_failed', credential: 'not-used-by-fake' });
  assert.equal(retry.totalItems, 1);
  assert.equal((await retryCompleted).status, 'completed');
  assert.deepEqual(calls, ['failed.png', 'good.png', 'failed.png']);
  const snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(snapshot.images.find(image => image.filename === 'failed.png').runState, 'succeeded');
  assert.equal(snapshot.images.find(image => image.filename === 'failed.png').proposal.scene_description, 'failed.png tagged.');
});

test('reopening a catalog recovers interrupted work and unblocks retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-interrupted-run-'));
  const databasePath = join(directory, 'catalog.sqlite');
  await sharp({ create: { width: 30, height: 20, channels: 3, background: '#345678' } }).png().toFile(join(directory, 'image.png'));
  let catalog = await openImageCatalog({ databasePath });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const added = await catalog.execute('roots.add', { path: directory, excludes: ['catalog.sqlite*'] });
  await catalog.execute('roots.scan', { rootId: added.rootId });
  const snapshot = await catalog.execute('catalog.snapshot');
  const imageVersionId = snapshot.images[0].versionId;
  const catalogId = snapshot.catalog.id;
  const schemaVersionId = snapshot.catalog.activeSchemaVersionId;
  const providerProfileId = snapshot.catalog.activeProviderProfileId;
  catalog.close();

  const raw = new DatabaseSync(databasePath);
  const createdAt = '2026-01-01T00:00:00.000Z';
  raw.prepare(`INSERT INTO runs(id, catalog_id, schema_version_id, provider_profile_id, provider_snapshot_json, prompt_snapshot_json, image_preset, selection_policy, status, total_items, created_at, started_at)
    VALUES ('interrupted-tag-run', ?, ?, ?, '{}', '{}', 'economy', 'retry_failed', 'running', 1, ?, ?)`).run(catalogId, schemaVersionId, providerProfileId, createdAt, createdAt);
  raw.prepare(`INSERT INTO run_items(id, run_id, image_version_id, state, attempt_count, created_at, updated_at)
    VALUES ('interrupted-tag-item', 'interrupted-tag-run', ?, 'running', 1, ?, ?)`).run(imageVersionId, createdAt, createdAt);
  raw.prepare(`INSERT INTO detection_runs(id, catalog_id, provider_profile_id, provider_snapshot_json, prompt_snapshot_json, image_preset, status, total_items, created_at, started_at)
    VALUES ('interrupted-detection-run', ?, ?, '{}', '{}', 'economy', 'queued', 1, ?, ?)`).run(catalogId, providerProfileId, createdAt, createdAt);
  raw.prepare(`INSERT INTO detection_run_items(id, run_id, image_version_id, state, created_at, updated_at)
    VALUES ('interrupted-detection-item', 'interrupted-detection-run', ?, 'queued', ?, ?)`).run(imageVersionId, createdAt, createdAt);
  raw.close();

  catalog = await openImageCatalog({
    databasePath,
    providerFactory: () => ({ generateTags: async () => ({
      values: { setting: ['interior'], subjects: ['object'], scene_description: 'Recovered retry.' },
      providerRequestId: 'recovered', providerModel: 'fake-vision', finishReason: 'stop', usage: {}
    }) })
  });
  const recovered = await catalog.execute('catalog.snapshot');
  assert.equal(recovered.runs[0].status, 'failed');
  assert.equal(recovered.runs[0].failedItems, 1);
  assert.equal(recovered.detectionRuns[0].status, 'failed');
  assert.equal(recovered.detectionRuns[0].failedItems, 0);
  assert.equal(recovered.images[0].runState, 'failed');
  assert.match(recovered.images[0].errorMessage, /Interrupted/);

  const completed = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'run.complete') { off(); resolve(event); } });
  });
  const retry = await catalog.execute('run.start', { selectionPolicy: 'retry_failed', credential: 'not-used-by-fake' });
  assert.equal(retry.totalItems, 1);
  assert.equal((await completed).status, 'completed');
});

test('object detection stores normalized face and object regions in a separate run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-object-detection-'));
  const imagePath = join(directory, 'face.png');
  await sharp({ create: { width: 30, height: 20, channels: 3, background: '#345678' } }).png().toFile(imagePath);
  const catalog = await openImageCatalog({
    databasePath: join(directory, 'catalog.sqlite'),
    providerFactory: () => ({ generateTags: async () => ({
      values: {
        faces: [{ box_2d: [100, 200, 600, 700], label: 'person' }],
        objects: [{ box_2d: [250, 300, 800, 900], label: 'lamp' }]
      },
      providerRequestId: 'object-detection', providerModel: 'fake-vision', finishReason: 'stop', usage: {}
    }) })
  });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const added = await catalog.execute('roots.add', { path: directory });
  await catalog.execute('roots.scan', { rootId: added.rootId });
  const image = (await catalog.execute('catalog.snapshot')).images[0];
  const completed = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'detection.complete') { off(); resolve(event); } });
  });
  const run = await catalog.execute('detection.start', { imageVersionIds: [image.versionId], credential: 'not-used-by-fake' });
  assert.equal(run.totalItems, 1);
  assert.equal((await completed).status, 'completed');
  const snapshot = await catalog.execute('catalog.snapshot');
  assert.deepEqual(snapshot.images[0].detection.faces, [{ label: 'person', x: 0.2, y: 0.1, width: 0.5, height: 0.5 }]);
  assert.deepEqual(snapshot.images[0].detection.objects, [{ label: 'lamp', x: 0.3, y: 0.25, width: 0.6, height: 0.55 }]);
  assert.equal(snapshot.detectionRuns[0].status, 'completed');
  assert.equal(snapshot.runs.length, 0);
});

test('object detection accepts a flat Gemini response and classifies common labels', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-flat-object-detection-'));
  await sharp({ create: { width: 30, height: 20, channels: 3, background: '#345678' } }).png().toFile(join(directory, 'scene.png'));
  const catalog = await openImageCatalog({
    databasePath: join(directory, 'catalog.sqlite'),
    providerFactory: () => ({ generateTags: async () => ({
      values: [
        { box_2d: [111, 394, 228, 480], label: 'lucy_pevensie' },
        { box_2d: [222, 375, 361, 429], label: 'cordial bottle' },
        { box_2d: [250, 100, 450, 300], label: 'bear' },
        { box_2d: [500, 100, 650, 300], label: 'cheetah' },
        { box_2d: [700, 100, 850, 300], label: 'fox' }
      ],
      providerRequestId: 'flat-object-detection', providerModel: 'fake-vision', finishReason: 'stop', usage: {}
    }) })
  });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const added = await catalog.execute('roots.add', { path: directory });
  await catalog.execute('roots.scan', { rootId: added.rootId });
  const image = (await catalog.execute('catalog.snapshot')).images[0];
  const completed = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'detection.complete') { off(); resolve(event); } });
  });
  await catalog.execute('detection.start', { imageVersionIds: [image.versionId], credential: 'not-used-by-fake' });
  assert.equal((await completed).status, 'completed');
  const snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(snapshot.images[0].detection.faces[0].label, 'lucy_pevensie');
  assert.deepEqual(snapshot.images[0].detection.objects.map(item => item.label), ['cordial bottle', 'bear', 'cheetah', 'fox']);
});

test('retrieval text uses human labels and float vectors round-trip portably', () => {
  const definition = validateSchemaDefinition({ schemaVersion: 1, fields: [
    { id: 'book', key: 'book', label: 'Book', type: 'tags', options: [{ id: 'book-1', key: 'lww', label: 'The Lion, the Witch and the Wardrobe' }], includeInRetrievalText: true },
    { id: 'characters', key: 'characters', label: 'Characters', type: 'tags', options: [{ id: 'lucy', key: 'lucy_pevensie', label: 'Lucy Pevensie' }], includeInRetrievalText: true },
    { id: 'description', key: 'scene_description', label: 'Scene Description', type: 'free_text', options: [], includeInRetrievalText: true }
  ] });
  const document = buildRetrievalDocument(definition, { book: ['lww'], characters: ['lucy_pevensie'], scene_description: '  Lucy enters a snowy forest.  ' });
  assert.match(document.text, /Book: The Lion, the Witch and the Wardrobe/);
  assert.match(document.text, /Characters: Lucy Pevensie/);
  assert.match(document.text, /Scene Description: Lucy enters a snowy forest\./);
  const vector = fakeEmbedding(document.text);
  assert.deepEqual([...decodeFloat32LE(encodeFloat32LE(vector), vector.length)], [...vector]);
});

test('local embedding update powers hard-filtered hybrid search and deactivation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-hybrid-search-'));
  for (const filename of ['lucy.png', 'edmund.png']) await sharp({ create: { width: 64, height: 48, channels: 3, background: '#345678' } }).png().toFile(join(directory, filename));
  const catalog = await openImageCatalog({ databasePath: join(directory, 'catalog.sqlite'), embeddingFactory: fakeEmbeddingFactory });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  let snapshot = await catalog.execute('catalog.snapshot');
  const option = (id, key, label) => ({ id, key, label });
  const definition = validateSchemaDefinition({ schemaVersion: 1, fields: [
    { id: 'characters', key: 'characters', label: 'Characters', type: 'tags', options: [option('lucy', 'lucy_pevensie', 'Lucy Pevensie'), option('edmund', 'edmund_pevensie', 'Edmund Pevensie'), option('person', 'person', 'Person')], includeInRetrievalText: true },
    { id: 'book', key: 'book', label: 'Book', type: 'tags', options: [option('lww', 'lww', 'The Lion, the Witch and the Wardrobe'), option('pc', 'prince_caspian', 'Prince Caspian')], includeInRetrievalText: true },
    { id: 'setting', key: 'setting', label: 'Setting', type: 'tags', options: [option('snow', 'snowy_forest', 'Snowy Forest'), option('desert', 'desert', 'Desert')], includeInRetrievalText: true },
    { id: 'image-type', key: 'image_type', label: 'Image Type', type: 'tags', options: [option('illustration', 'illustration', 'Illustration')], includeInRetrievalText: true },
    { id: 'mood', key: 'mood', label: 'Mood', type: 'tags', options: [option('magical', 'magical', 'Magical'), option('tense', 'tense', 'Tense')], includeInRetrievalText: true },
    { id: 'description', key: 'scene_description', label: 'Scene Description', type: 'free_text', options: [], includeInRetrievalText: true }
  ] });
  const draft = await catalog.execute('schema.saveDraft', { schemaId: snapshot.schemas[0].id, definition });
  await catalog.execute('schema.publish', { schemaVersionId: draft.versionId });
  const root = await catalog.execute('roots.add', { path: directory, excludes: ['catalog.sqlite*'] });
  await catalog.execute('roots.scan', { rootId: root.rootId });
  snapshot = await catalog.execute('catalog.snapshot');
  const lucy = snapshot.images.find(image => image.filename === 'lucy.png');
  const edmund = snapshot.images.find(image => image.filename === 'edmund.png');
  await catalog.execute('review.accept', { imageVersionId: lucy.versionId, values: { characters: ['lucy_pevensie', 'person'], book: ['lww'], setting: ['snowy_forest'], image_type: ['illustration'], mood: ['magical'], scene_description: 'Lucy walks through a magical snowy forest.' } });
  await catalog.execute('review.accept', { imageVersionId: edmund.versionId, values: { characters: ['edmund_pevensie', 'person'], book: ['lww'], setting: ['desert'], image_type: ['illustration'], mood: ['tense'], scene_description: 'Edmund crosses a tense desert.' } });
  const completed = new Promise(resolve => {
    const off = catalog.onEvent(event => { if (event.type === 'embedding.complete') { off(); resolve(event); } });
  });
  const update = await catalog.execute('embeddings.update');
  assert.equal(update.totalItems, 2);
  assert.equal((await completed).status, 'completed');
  const missingBook = await catalog.execute('search.hybrid', { semanticText: 'Lucy in a snowy magical forest' });
  assert.equal(missingBook.code, 'missing_book');
  const results = await catalog.execute('search.hybrid', { semanticText: 'Lucy in a snowy magical forest', spokenText: 'Lucy stepped into the wood.', paragraphContext: 'She has just passed through the wardrobe.', videoTheme: 'Discovery and wonder', bookKeys: ['lww'], centralCharacterKeys: ['lucy_pevensie'], settingKeys: ['snowy_forest'], moodKeys: ['magical'], limit: 5 });
  assert.equal(results.results.length, 1);
  assert.equal(results.results[0].imageId, lucy.id);
  assert.equal(results.results[0].values.characters.includes('lucy_pevensie'), true);
  assert.equal(Number.isFinite(results.results[0].scores.final), true);
  assert.equal(Number.isFinite(results.results[0].scores.semantic), true);
  assert.equal(results.selectionPacket.visualBeat.spokenText, 'Lucy stepped into the wood.');
  assert.deepEqual(results.selectionPacket.candidates[0].metadata.characters, ['Lucy Pevensie', 'Person']);
  assert.equal(results.selectionPacket.candidates[0].imageId, lucy.id);
  assert.equal(Number.isFinite(results.selectionPacket.candidates[0].rankingEvidence.finalScore), true);
  assert.equal(Object.hasOwn(results.selectionPacket.candidates[0], 'path'), false);
  assert.equal(Object.hasOwn(results.selectionPacket.candidates[0], 'detection'), false);
  await catalog.execute('images.setActive', { imageIds: [lucy.id], active: false });
  assert.equal((await catalog.execute('catalog.snapshot')).inactiveImageCount, 1);
  assert.equal((await catalog.execute('catalog.snapshot', { activity: 'inactive' })).images[0].id, lucy.id);
  assert.equal((await catalog.execute('search.hybrid', { semanticText: 'Lucy in a snowy magical forest', bookKeys: ['lww'], centralCharacterKeys: ['lucy_pevensie'] })).results.length, 0);
  assert.equal((await catalog.execute('search.accepted', { query: 'Lucy' })).some(image => image.imageId === lucy.id), false);
});

test('B-roll search covers every accepted book or non-book image without spending incomplete embeddings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-broll-search-'));
  const originalRoot = join(directory, 'Original artwork');
  const relocatedRoot = join(directory, 'Moved artwork');
  await mkdir(originalRoot);
  const sizes = { 'lucy.png': [120, 80], 'sea.png': [120, 80], 'abstract.png': [120, 80], 'tiny.png': [80, 40] };
  for (const [filename, [width, height]] of Object.entries(sizes)) await sharp({ create: { width, height, channels: 3, background: '#345678' } }).png().toFile(join(originalRoot, filename));
  const catalog = await openImageCatalog({ databasePath: join(directory, 'catalog.sqlite'), embeddingFactory: fakeEmbeddingFactory });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  let snapshot = await catalog.execute('catalog.snapshot');
  const option = (key, label) => ({ id: key, key, label });
  const definition = validateSchemaDefinition({ schemaVersion: 1, fields: [
    { id: 'book', key: 'book', label: 'Book', type: 'tags', options: [option('lww', 'The Lion, the Witch and the Wardrobe'), option('prince_caspian', 'Prince Caspian')], includeInRetrievalText: true },
    { id: 'characters', key: 'characters', label: 'Characters', type: 'tags', options: [option('lucy_pevensie', 'Lucy Pevensie'), option('edmund_pevensie', 'Edmund Pevensie')], includeInRetrievalText: true },
    { id: 'description', key: 'scene_description', label: 'Scene Description', type: 'free_text', options: [], includeInRetrievalText: true }
  ] });
  const draft = await catalog.execute('schema.saveDraft', { schemaId: snapshot.schemas[0].id, definition });
  await catalog.execute('schema.publish', { schemaVersionId: draft.versionId });
  const root = await catalog.execute('roots.add', { path: originalRoot });
  await catalog.execute('roots.scan', { rootId: root.rootId });
  snapshot = await catalog.execute('catalog.snapshot');
  const byName = Object.fromEntries(snapshot.images.map(image => [image.filename, image]));
  const tags = {
    'lucy.png': { book: ['lww'], characters: ['lucy_pevensie'], scene_description: 'Lucy enters a snowy magical wood.' },
    'sea.png': { book: ['prince_caspian'], characters: [], scene_description: 'A ship sails on a blue sea.' },
    'abstract.png': { book: [], characters: [], scene_description: 'A strange abstract landscape.' },
    'tiny.png': { book: [], characters: [], scene_description: 'Small abstract texture.' }
  };
  for (const [filename, values] of Object.entries(tags)) await catalog.execute('review.accept', { imageVersionId: byName[filename].versionId, values });
  const query = { semanticText: 'a surprising magical landscape', outputWidth: 192, outputHeight: 108 };
  assert.equal((await catalog.execute('search.broll.readiness')).code, 'search_not_ready');
  const pending = await catalog.execute('search.broll', query);
  assert.equal(pending.code, 'search_not_ready');
  assert.equal(pending.readiness.acceptedItems, 4);
  assert.equal(pending.readiness.indexedItems, 0);
  assert.equal(pending.action, 'embeddings.update');
  const completed = new Promise(resolve => { const off = catalog.onEvent(event => { if (event.type === 'embedding.complete') { off(); resolve(event); } }); });
  await catalog.execute('embeddings.update');
  assert.equal((await completed).status, 'completed');
  assert.equal((await catalog.execute('search.broll.readiness')).ok, true);
  assert.equal((await catalog.execute('search.hybrid', { semanticText: query.semanticText })).code, 'missing_book');
  const all = await catalog.execute('search.broll', query);
  assert.equal(all.ok, true);
  assert.equal(all.query.limit, 8);
  const twoResults = await catalog.execute('search.broll', { ...query, limit: 2 });
  assert.equal(twoResults.query.limit, 2);
  assert.equal(twoResults.results.length, 2);
  assert.equal(all.readiness.staleItems, 0);
  assert.deepEqual(new Set(all.results.map(result => result.filename)), new Set(['lucy.png', 'sea.png', 'abstract.png']));
  assert.ok(all.results.every(result => result.width === 120 && result.height === 80 && result.availability === 'present' && result.revisionId));
  const resolved = await catalog.execute('images.resolve', { imageIds: [all.results[0].imageId] });
  assert.equal(resolved[0].imageVersionId, all.results[0].imageVersionId);
  assert.equal(resolved[0].reviewState, 'accepted');
  assert.ok(all.results.every(result => Object.hasOwn(result, 'detection')));
  assert.equal(all.eligibility.excludedForResolution, 1);
  assert.equal(all.eligibility.excludedExamples[0].reason, 'below_half_output_resolution');
  assert.equal(all.selectionPacket.candidates[0].filename, all.results[0].filename);
  assert.deepEqual(all.selectionPacket.retrievalConstraints.hardFiltersAlreadyApplied, []);
  assert.ok(!JSON.stringify(all.selectionPacket).includes(originalRoot));
  assert.ok(!JSON.stringify(all.selectionPacket).includes('coordinates'));
  const softCharacter = await catalog.execute('search.broll', { ...query, centralCharacterKeys: ['edmund_pevensie'] });
  assert.equal(softCharacter.results.length, 3);
  assert.deepEqual(softCharacter.selectionPacket.retrievalConstraints.hardFiltersAlreadyApplied, []);
  const bookSpecific = await catalog.execute('search.broll', { ...query, bookKeys: ['lww'] });
  assert.deepEqual(bookSpecific.results.map(result => result.filename), ['lucy.png']);
  assert.deepEqual(bookSpecific.selectionPacket.retrievalConstraints.hardFiltersAlreadyApplied, ['bookKeys']);
  const noResolutionFit = await catalog.execute('search.broll', { ...query, bookKeys: ['prince_caspian'], outputWidth: 500, outputHeight: 300 });
  assert.equal(noResolutionFit.results.length, 0);
  assert.equal(noResolutionFit.eligibility.excludedForResolution, 1);
  await rename(originalRoot, relocatedRoot);
  await catalog.execute('roots.relocate', { rootId: root.rootId, path: relocatedRoot });
  const relocated = await catalog.execute('search.broll', query);
  assert.equal(relocated.results.length, 3);
  assert.ok(relocated.results.every(result => result.path.startsWith(relocatedRoot)));
  assert.ok(!JSON.stringify(relocated.selectionPacket).includes(relocatedRoot));
  await catalog.execute('review.accept', { imageVersionId: byName['lucy.png'].versionId,
    values: { ...tags['lucy.png'], scene_description: 'Lucy enters a deeper snowy wood.' } });
  const stale = await catalog.execute('search.broll', query);
  assert.equal(stale.code, 'search_not_ready');
  assert.equal((await catalog.execute('search.broll.readiness')).readiness.staleItems, 1);
  assert.equal(stale.readiness.staleItems, 1);
  assert.deepEqual(stale.results, []);
  const manualWhileStale = await catalog.execute('search.broll.manual', { ...query, limit: 1 });
  assert.equal(manualWhileStale.ok, true);
  assert.equal(manualWhileStale.readiness.staleItems, 1);
  assert.equal(manualWhileStale.results.length, 1);
  assert.notEqual(manualWhileStale.results[0].filename, 'lucy.png');
  const refreshed = new Promise(resolve => { const off = catalog.onEvent(event => { if (event.type === 'embedding.complete') { off(); resolve(event); } }); });
  await catalog.execute('embeddings.update');
  assert.equal((await refreshed).status, 'completed');
  assert.equal((await catalog.execute('search.broll', query)).results.length, 3);
});

test('retiring vocabulary preserves accepted tags and does not publish a new schema version', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-retired-vocabulary-'));
  const imagePath = join(directory, 'tagged.png');
  await sharp({ create: { width: 30, height: 20, channels: 3, background: '#345678' } }).png().toFile(imagePath);
  const catalog = await openImageCatalog({ databasePath: join(directory, 'catalog.sqlite') });
  t.after(() => { catalog.close(); return rm(directory, { recursive: true, force: true }); });
  const root = await catalog.execute('roots.add', { path: directory, excludes: ['catalog.sqlite*'] });
  await catalog.execute('roots.scan', { rootId: root.rootId });

  let snapshot = await catalog.execute('catalog.snapshot');
  const schema = snapshot.schemas.find(item => item.active);
  const subjects = schema.definition.fields.find(field => field.key === 'subjects');
  const custom = await catalog.execute('schema.tag.add', { schemaVersionId: schema.versionId, fieldId: subjects.id, label: 'Temporary subject' });
  await catalog.execute('review.accept', {
    imageVersionId: snapshot.images[0].versionId,
    values: { setting: ['interior'], subjects: [custom.key], scene_description: 'Keeps its retired metadata.' }
  });

  await catalog.execute('schema.tag.archive', { schemaVersionId: schema.versionId, fieldId: subjects.id, optionId: custom.id });
  snapshot = await catalog.execute('catalog.snapshot');
  const activeSchema = snapshot.schemas.find(item => item.active);
  const retired = activeSchema.definition.fields.find(field => field.key === 'subjects').options.find(option => option.key === custom.key);
  assert.equal(activeSchema.versionId, schema.versionId);
  assert.equal(retired.archived, true);
  assert.deepEqual(snapshot.images[0].accepted.subjects, [custom.key]);
  const taggingRequest = compileTaggingRequest({ definition: activeSchema.definition, filename: 'tagged.png', relativePath: 'tagged.png' });
  assert.equal(taggingRequest.outputSchema.properties.subjects.items.enum.includes(custom.key), false);
  assert.equal(taggingRequest.systemText.includes(custom.key), false);
  await catalog.execute('review.accept', { imageVersionId: snapshot.images[0].versionId, values: snapshot.images[0].accepted });

  const reactivated = await catalog.execute('schema.tag.add', { schemaVersionId: schema.versionId, fieldId: subjects.id, label: 'Temporary subject' });
  assert.equal(reactivated.id, custom.id);
  snapshot = await catalog.execute('catalog.snapshot');
  assert.equal(snapshot.schemas.find(item => item.active).definition.fields.find(field => field.key === 'subjects').options.find(option => option.key === custom.key).archived, undefined);
});
