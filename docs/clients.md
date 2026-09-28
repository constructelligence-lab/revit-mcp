# Client configuration

Every MCP client wants the same thing: a command, its arguments, and a name. Use the **absolute path** to
`server/server.mjs` — clients do not run in the directory you think they do — and `node` from a PATH the
client can see (on macOS, GUI apps often do not inherit your shell PATH; use the full path to
`node` if the tools do not appear).

Read-only is the default. To allow writes, add `--allow-writes` **and** set `"allowWrites": true` in
`%APPDATA%\revit-mcp\settings.json`, then restart both.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "revit": {
      "command": "node",
      "args": ["C:/path/to/revit-mcp/server/server.mjs"]
    }
  }
}
```

## Claude Code

```sh
claude mcp add revit -- node /path/to/revit-mcp/server/server.mjs
claude mcp add revit -- node /path/to/revit-mcp/server/server.mjs --allow-writes   # writes allowed
```

## Cursor

`~/.cursor/mcp.json` (or Settings → MCP):

```json
{ "mcpServers": { "revit": { "command": "node", "args": ["/path/to/revit-mcp/server/server.mjs"] } } }
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{ "mcpServers": { "revit": { "command": "node", "args": ["/path/to/revit-mcp/server/server.mjs"] } } }
```

## VS Code (Copilot agent mode)

`.vscode/mcp.json` in the workspace, or user settings:

```json
{ "servers": { "revit": { "type": "stdio", "command": "node", "args": ["/path/to/revit-mcp/server/server.mjs"] } } }
```

## DSCode (and any client that takes the same shape)

```json
{ "mcpServers": { "revit": { "command": "node", "args": ["/path/to/revit-mcp/server/server.mjs"] } } }
```

## The sample model, in any client

Add `--mock` to work without Revit — useful for demos, for showing a colleague, and for writing prompts
before a model is available:

```json
{ "command": "node", "args": ["/path/to/revit-mcp/server/server.mjs", "--mock"] }
```

Every result says `"mock": true`, so it cannot be mistaken for a live model.

## From npm, without a clone

```json
{ "command": "npx", "args": ["-y", "@constructelligence/revit-mcp"] }
```

Add `--mock` the same way if you want it working without Revit.

## Environment variables

| Variable | What it does |
|---|---|
| `REVIT_MCP_BRIDGE` | Add-in address, default `http://127.0.0.1:8712` |
| `REVIT_MCP_TOKEN` | Bearer token; overrides the file the add-in wrote |
| `REVIT_MCP_TIMEOUT` | Per-call timeout in seconds (default 30, writes 60) |
| `REVIT_MCP_MOCK=1` | Same as `--mock` |
| `REVIT_MCP_ALLOW_WRITES=1` | Same as `--allow-writes` (the add-in has its own switch) |

A client that cannot pass flags can use the environment instead:

```json
{ "mcpServers": { "revit": { "command": "node", "args": ["/path/to/server.mjs"],
  "env": { "REVIT_MCP_MOCK": "1" } } } }
```
