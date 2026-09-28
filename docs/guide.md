# The 20-minute guide

From nothing to an assistant that can read the model you have open — and, if you decide it should, change
one parameter at a time. Twenty minutes is honest: five to try it, ten to install the add-in, five for the
first real conversation.

- [What you need](#what-you-need)
- [1. Try it without Revit](#1-try-it-without-revit)
- [2. Install the add-in](#2-install-the-add-in)
- [3. Connect your client](#3-connect-your-client)
- [4. Your first conversation](#4-your-first-conversation)
- [Five workflows worth learning](#five-workflows-worth-learning)
- [The house rules](#the-house-rules)
- [When something is wrong](#when-something-is-wrong)

## What you need

| | |
|---|---|
| Revit | 2025 (add-in built for it by default), 2026/2027 with `-p:RevitVersion=`, 2024 and older with `-p:TargetFramework=net48` |
| Node | 20 or newer, on the same machine as Revit |
| An MCP client | Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, DSCode — any of them (see [clients.md](clients.md)) |
| .NET SDK | only if you build the add-in yourself |

Five minutes of it needs no Revit at all, which is the point of starting there: you can see exactly what the
tools return, and what they refuse to do, before a live model is involved.

## 1. Try it without Revit

```sh
git clone https://github.com/constructelligence-lab/revit-mcp
cd revit-mcp/server
npm install
npm run demo
```

The demo drives the real MCP server against the sample model over the real protocol, so what scrolls past is
what a client sees:

```
tools (15):     revit_status, model_overview, list_levels, list_categories, query_elements,
                element_details, list_views, list_sheets, list_families, model_warnings,
                list_schedules, read_schedule, current_selection, export_view_image, set_parameter
prompts (4):    model_health_check, quantities_from_schedules, sheet_qa, parameter_audit
resources (3):  revit://status, revit://model/overview, revit://warnings
```

```json
{ "mock": true, "revit": { "version": "2025.2", "document": "Sample Tower.rvt", "units": "millimeters",
  "workshared": true, "activeView": "L2 - Floor Plan" }, "writesAllowed": false, "levels": 3 }
```

Note `"mock": true`: every answer from the sample model says so, so nobody mistakes it for a building. And
`writesAllowed: false`, which is the default everywhere in this project.

## 2. Install the add-in

On the Windows machine that runs Revit:

```powershell
cd revit-mcp\addin
dotnet build -c Release
copy bin\Release\net8.0-windows\RevitMcp.dll               %APPDATA%\Autodesk\Revit\Addins\2025\
copy bin\Release\net8.0-windows\manifest\RevitMcp.addin    %APPDATA%\Autodesk\Revit\Addins\2025\
```

Start Revit and open a model. A **revit-mcp** tab appears; *Bridge status* tells you, from inside Revit, the
address it listens on, whether writes are allowed, and where the token lives. The bridge is loopback-only
(`127.0.0.1:8712`), so the answer to "what did this open on the network" is "nothing".

Writes stay off. Turning them on is a decision you make twice — once in
`%APPDATA%\revit-mcp\settings.json` (`"allowWrites": true`) and once when you start the server
(`--allow-writes`) — and read [security.md](security.md) before you do.

## 3. Connect your client

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "revit": { "command": "node",
  "args": ["C:/path/to/revit-mcp/server/server.mjs"] } } }
```

Claude Code:

```sh
claude mcp add revit -- node C:/path/to/revit-mcp/server/server.mjs
```

Every other client, and the Windows-path variants, are in [clients.md](clients.md). Restart the client after
editing its config; the revit-mcp tools should appear in its tool list.

## 4. Your first conversation

Ask something a person would ask, and watch which tools get used:

> **You:** What's in the model I have open, and what should I look at before the coordination meeting?

The assistant calls `revit_status`, then `model_overview`, then `model_warnings`, and answers with the
document name, the sizes, and the warnings grouped by what they mean. Real output from the sample model:

```json
{ "document": "Sample Tower.rvt", "levels": 3, "views": 9, "sheets": 6, "schedules": 3,
  "warnings": 5, "elements": 132,
  "categories": [ { "name": "Walls", "instances": 42 }, { "name": "Rooms", "instances": 36 },
                  { "name": "Windows", "instances": 24 }, { "name": "Doors", "instances": 18 } ] }
```

Then get specific. `query_elements` returns rows and — more importantly — **ids**, which everything else
takes:

```json
{ "category": "Doors", "total_matched": 6, "scanned": 18,
  "rows": [ { "id": 100037, "category": "Doors", "family": "Double-Flush",
              "type": "1830 x 2134mm", "level": "L1", "mark": "D-100" } ] }
```

> **You:** Show me what's selected in Revit.

`current_selection` answers with ids and categories — the fastest way to talk about "this wall" without
describing it.

## Five workflows worth learning

These are also shipped as **prompts** in the server, so you can ask for them by name rather than typing the
method out.

1. **Model health check** (`model_health_check`) — status → overview → every warning → what is on each level.
   Ask it before a coordination meeting and you get the five things worth a person's attention, with the
   document named.
2. **Quantities from schedules** (`quantities_from_schedules`) — reads the schedules the model computes
   rather than counting elements by hand, and says which schedule each number came from. Where a schedule is
   missing, it counts elements and says it did that instead.
3. **Sheet QA** (`sheet_qa`) — sheets, their views, and the views that are on no sheet, which are usually the
   interesting ones.
4. **Parameter audit** (`parameter_audit`) — finds empty `Mark`s (or any parameter), proposes a scheme that
   fits the values already there, and previews each change before any is applied.
5. **Look at the drawing** (`export_view_image`) — renders a view to PNG and returns the path, so the
   assistant can read a picture next to the data. It writes a file in `%TEMP%\revit-mcp`, never the model.

## The house rules

The server's `instructions` say these to every client, and the prompts repeat them, because they are the
difference between a useful assistant and a confident wrong one:

- **Read before you claim.** Every number must come from a tool call in the conversation. Ids come from
  `query_elements` or `current_selection` — never invented.
- **Preview before you write.** `set_parameter` answers with the old and new value unless `apply: true` is
  passed. Say what will change, on which element, in which document, and get a yes.
- **One transaction, one Ctrl+Z.** Every write is a single Revit transaction; nothing saves, syncs, creates
  or deletes.
- **A warning is a prompt to look.** Revit's messages and counts are data; the sentence built from them is
  the model's. Not a QA report, not an audit, not a compliance record.
- **Say what you did not look at.** A read of the active document is not the whole story, especially with
  cloud-workshared models.

## When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| `No revit-mcp add-in at …` | Revit closed, add-in not loaded, port differs | Ribbon tab, then `%APPDATA%\revit-mcp\bridge.log` |
| Token refused | Server token file differs from `settings.json` | Delete `~/.revit-mcp/token`, restart Revit, restart the server |
| Did not answer in time | A modal dialog or long command holds Revit's UI thread | Close it; nothing was half-applied |
| `writes_disabled` | One of the two switches is off | Both `allowWrites` and `--allow-writes` |
| Tools missing in the client | Config path or Node not found | Test `node server.mjs --mock` in a terminal first |

More: [addin/README.md](../addin/README.md), [faq.md](faq.md), [protocol.md](protocol.md).
