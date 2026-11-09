# MythiCut project MCP server

The MythiCut project MCP server is a read-only local prototype that exposes saved project context to an MCP-compatible client. It does not control the Electron interface and cannot change the project, original media, reviewed selection, locked edit handoff, or B-roll decisions.

## Tools

- `get_project_summary` returns project metadata, source-recording filenames, artifact availability, and safe warnings. It omits source paths.
- `get_transcript` returns the complete locked transcript text. Optional bounded word pages include stable word IDs and sequence-frame timing.
- `get_beats` returns the saved visual beats, their intent and warnings, search state, and candidate counts. It omits artwork paths and candidate details.

The server opens one project path supplied by the user when the process starts. Tool arguments cannot select a different project or browse the filesystem. Locked handoffs and beat plans are loaded through the same fingerprint-verifying readers used by MythiCut Studio.

## Run locally

Install dependencies, then start the server with a saved auto-edit project:

```powershell
npm install
npm run mcp:project -- --project-file "C:\path\to\project.json"
```

The process uses MCP over standard input/output, so it normally runs as a child process launched by an MCP client rather than as an interactive terminal program. A generic client configuration resembles:

```json
{
  "mcpServers": {
    "mythicut": {
      "command": "node",
      "args": [
        "C:\\Repos\\mythicut-studio\\scripts\\mythicut-mcp.mjs",
        "--project-file",
        "C:\\path\\to\\project.json"
      ]
    }
  }
}
```

Client configuration formats differ. Keep the two paths absolute so the client does not depend on its launch directory.

## Trust boundary

- The configured project and its adjacent fingerprinted artifacts are read on every tool call.
- Source recordings are checked for availability by the existing project loader, but their contents and paths are not returned.
- No provider credentials, environment variables, catalog paths, or arbitrary files are exposed.
- The server has no mutation tools. Automated suggestions and saved B-roll decisions remain provisional and human review remains authoritative.
- A locked edit handoff is required for `get_transcript`; a saved beat plan is required for `get_beats`.

Run `npm test` to exercise the MCP connection, tool discovery, schemas, and all three tool calls through the matching MCP client SDK.
