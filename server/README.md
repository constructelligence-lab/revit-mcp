# @constructelligence/revit-mcp

The MCP server for [revit-mcp](https://github.com/constructelligence-lab/revit-mcp): it puts the Autodesk
Revit model a user has open in front of any MCP client — Claude Desktop, Claude Code, Cursor, Windsurf,
VS Code, DSCode — as eighteen tools, five workflow prompts and three live resources.

```sh
npx @constructelligence/revit-mcp --mock     # the sample model: try every tool without Revit
npx @constructelligence/revit-mcp            # talk to Revit on 127.0.0.1:8712
```

The other half is a Revit add-in (in the same repository) that serves a loopback bridge inside Revit. Install
it, and this server finds it; without it, `--mock` keeps everything demonstrable.

```json
{ "mcpServers": { "revit": { "command": "npx", "args": ["-y", "@constructelligence/revit-mcp"] } } }
```

**Read-only by default.** One tool can change the model (`set_parameter`): instance parameters only,
previewed unless `apply: true`, one Revit transaction per change, and it needs writes enabled in both
processes. No create, delete, save or sync anywhere.

Full guide, protocol, security model and the tool/prompt/resource menus:
<https://github.com/constructelligence-lab/revit-mcp>.

MIT licensed. Revit is a trademark of Autodesk, Inc.; this project is not affiliated with Autodesk.
