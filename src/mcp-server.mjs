import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { beatsFromMcpProject, loadMcpProject, summarizeMcpProject, transcriptFromMcpProject } from './mcp-project.mjs';

const readOnlyAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const fpsSchema = z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() });

const asToolResult = value => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value
});

export function createMythicutMcpServer(projectPath) {
  const server = new McpServer({ name: 'mythicut-project', version: '0.1.0' });

  server.registerTool('get_project_summary', {
    title: 'Get MythiCut project summary',
    description: 'Read a safe summary of the configured MythiCut project, its locked transcript, and its visual-beat plan. Source file paths are omitted.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      project: z.object({
        id: z.string(), name: z.string(), revision: z.number().int().nonnegative(), phase: z.string(),
        sourceRecordingCount: z.number().int().nonnegative(),
        sourceRecordings: z.array(z.object({ id: z.string(), filename: z.string(), durationSeconds: z.number().nonnegative() })),
        scriptCharacterCount: z.number().int().nonnegative(), scriptParagraphCount: z.number().int().nonnegative(), scriptSentenceCount: z.number().int().nonnegative()
      }),
      lockedTranscript: z.object({
        configured: z.boolean(), available: z.boolean(), id: z.string().nullable(), matchesProject: z.boolean(),
        wordCount: z.number().int().nonnegative(), durationFrames: z.number().int().nonnegative(), durationSeconds: z.number().nonnegative()
      }),
      beatPlan: z.object({
        configured: z.boolean(), available: z.boolean(), id: z.string().nullable(), status: z.string().nullable(),
        beatCount: z.number().int().nonnegative(), matchesLockedTranscript: z.boolean()
      }),
      warnings: z.array(z.string())
    }),
    annotations: readOnlyAnnotations
  }, async () => asToolResult(summarizeMcpProject(await loadMcpProject(projectPath))));

  server.registerTool('get_transcript', {
    title: 'Get locked transcript',
    description: 'Read the immutable locked edit transcript. By default this returns the complete text; request a bounded word page to inspect stable word IDs and sequence-frame timing.',
    inputSchema: z.object({
      includeWords: z.boolean().default(false).describe('Include a bounded page of word-level timing records.'),
      offset: z.number().int().nonnegative().default(0).describe('Zero-based word offset used when includeWords is true.'),
      limit: z.number().int().min(1).max(500).default(200).describe('Maximum word records to return when includeWords is true.')
    }),
    outputSchema: z.object({
      handoffId: z.string(), kind: z.string(), wordCount: z.number().int().positive(), text: z.string(),
      timeline: z.object({ fps: fpsSchema, durationFrames: z.number().int().positive(), durationSeconds: z.number().positive() }),
      timingNeedsReviewCount: z.number().int().nonnegative(),
      wordPage: z.object({
        offset: z.number().int().nonnegative(), limit: z.number().int().positive(), returned: z.number().int().nonnegative(), total: z.number().int().positive(),
        words: z.array(z.object({
          id: z.string(), text: z.string(), sourceId: z.string(), startFrame: z.number().int().nonnegative(),
          endFrame: z.number().int().positive(), timingNeedsReview: z.boolean()
        }))
      }).optional()
    }),
    annotations: readOnlyAnnotations
  }, async input => asToolResult(transcriptFromMcpProject(await loadMcpProject(projectPath), input)));

  server.registerTool('get_beats', {
    title: 'Get visual beats',
    description: 'Read the current saved B-roll visual-beat plan without returning artwork paths or changing any provisional decisions.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      planId: z.string(), handoffId: z.string(), matchesLockedTranscript: z.boolean(), status: z.string(), beatCount: z.number().int().nonnegative(),
      timeline: z.object({ fps: fpsSchema, durationFrames: z.number().int().positive(), durationSeconds: z.number().positive() }),
      beats: z.array(z.object({
        id: z.string(), startWordId: z.string(), endWordId: z.string(), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive(),
        durationSeconds: z.number().positive(), text: z.string(), visualIntent: z.string(), artworkNeed: z.string(), talkingHeadPriority: z.string(),
        searchQuery: z.string(), reason: z.string(), warnings: z.array(z.string()), searchStatus: z.string().nullable(), candidateCount: z.number().int().nonnegative()
      }))
    }),
    annotations: readOnlyAnnotations
  }, async () => asToolResult(beatsFromMcpProject(await loadMcpProject(projectPath))));

  return server;
}
