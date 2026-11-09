import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createProject, saveProject } from '../src/project.mjs';
import { buildReferenceHandoff, saveEditHandoff } from '../src/edit-handoff.mjs';
import { saveBrollBeatPlan } from '../src/broll-beats.mjs';
import { createMythicutMcpServer } from '../src/mcp-server.mjs';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'mythicut-mcp-'));
  const projectPath = join(folder, 'project.json');
  const tokens = ['A', 'short', 'locked', 'transcript', 'for', 'testing.'];
  const words = tokens.map((text, index) => ({
    id: `word-${index}`, text, mediaId: 'source-1', startMs: index * 500, endMs: (index + 1) * 500
  }));
  const handoff = buildReferenceHandoff({
    width: 1920,
    height: 1080,
    words,
    sources: { 'source-1': { filename: 'synthetic.mov', fps: { numerator: 30, denominator: 1 }, frames: 90 } },
    timeline: { fps: { numerator: 30, denominator: 1 }, duration: 90,
      intervals: [{ sourceId: 'source-1', inFrame: 0, outFrame: 90, start: 0, end: 90, wordIds: words.map(word => word.id) }] }
  });
  await saveEditHandoff(projectPath, handoff);

  const beatContent = {
    schemaVersion: 1,
    handoffId: handoff.id,
    catalogId: 'synthetic-catalog',
    artworkMinimumSeconds: 4,
    catalogRevision: 1,
    timeline: handoff.timeline,
    wholeScriptSummary: handoff.text,
    status: 'proposed',
    promptSnapshot: { model: 'synthetic', template: {}, responseSchema: {}, providerSchema: true, requests: [] },
    beats: [{
      id: 'beat-1', startWordId: 'word-0', endWordId: 'word-5', startIndex: 0, endIndex: 5,
      startFrame: 0, endFrame: 90, text: handoff.text, paragraphContext: handoff.text,
      visualIntent: 'Show a concise test sequence', artworkNeed: 'optional', talkingHeadPriority: 'normal',
      searchQuery: 'test sequence', reason: 'Synthetic integration fixture', warnings: [],
      searchStatus: 'candidates', search: { response: { results: [{ imageId: 'image-1' }] } }
    }]
  };
  const beatPlan = { ...beatContent, id: fingerprint(beatContent) };
  await saveBrollBeatPlan(projectPath, beatPlan);

  const project = createProject();
  project.name = 'MCP test project';
  project.lockedHandoffId = handoff.id;
  project.brollBeatPlanId = beatPlan.id;
  await saveProject(projectPath, project);
  return { projectPath, project, handoff, beatPlan };
}

test('MythiCut MCP lists and calls the three read-only project tools', async t => {
  const data = await fixture();
  const server = createMythicutMcpServer(data.projectPath);
  const client = new Client({ name: 'mythicut-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['get_beats', 'get_project_summary', 'get_transcript']);
  assert.ok(listed.tools.every(tool => tool.annotations?.readOnlyHint === true));

  const summary = await client.callTool({ name: 'get_project_summary', arguments: {} });
  assert.equal(summary.isError, undefined, JSON.stringify(summary));
  assert.ok(summary.structuredContent, JSON.stringify(summary));
  assert.equal(summary.structuredContent.project.name, 'MCP test project');
  assert.equal(summary.structuredContent.lockedTranscript.wordCount, 6);
  assert.equal(summary.structuredContent.beatPlan.matchesLockedTranscript, true);

  const transcript = await client.callTool({ name: 'get_transcript', arguments: { includeWords: true, offset: 1, limit: 2 } });
  assert.equal(transcript.structuredContent.text, 'A short locked transcript for testing.');
  assert.deepEqual(transcript.structuredContent.wordPage.words.map(word => word.id), ['word-1', 'word-2']);

  const beats = await client.callTool({ name: 'get_beats', arguments: {} });
  assert.equal(beats.structuredContent.beatCount, 1);
  assert.equal(beats.structuredContent.beats[0].candidateCount, 1);
  assert.equal(beats.structuredContent.beats[0].text, handoffText(data.handoff));
});

const handoffText = handoff => handoff.text;

test('MythiCut MCP command serves the configured project over stdio', async t => {
  const data = await fixture();
  const client = new Client({ name: 'mythicut-stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'scripts', 'mythicut-mcp.mjs'), '--project-file', data.projectPath],
    cwd: process.cwd(),
    stderr: 'pipe'
  });
  await client.connect(transport);
  t.after(async () => { await client.close(); });

  const summary = await client.callTool({ name: 'get_project_summary', arguments: {} });
  assert.equal(summary.isError, undefined, JSON.stringify(summary));
  assert.equal(summary.structuredContent.project.id, data.project.id);
});
