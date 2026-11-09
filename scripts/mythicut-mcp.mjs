import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMythicutMcpServer } from '../src/mcp-server.mjs';
import { loadMcpProject } from '../src/mcp-project.mjs';

function projectFileArgument(args) {
  const index = args.indexOf('--project-file');
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('Usage: node scripts/mythicut-mcp.mjs --project-file <project.json>');
  }
  return resolve(args[index + 1]);
}

async function main() {
  const projectPath = projectFileArgument(process.argv.slice(2));
  await loadMcpProject(projectPath);
  const server = createMythicutMcpServer(projectPath);
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(`MythiCut MCP server failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
