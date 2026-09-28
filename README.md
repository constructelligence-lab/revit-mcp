# revit-mcp

<p align="center"><strong>Autodesk Revit to any MCP client: read the model you have open, and — if you let it — change one parameter at a time.</strong></p>

<p align="center">A Revit add-in that serves a loopback bridge, and an MCP server that turns that bridge into tools an AI assistant can call.</p>

Most "AI for BIM" asks you to upload a model somewhere, or to trust a cloud service with a client's building.
This does the opposite: Revit stays where it is, the data stays on the workstation, and the assistant gets a
narrow, auditable set of reads — plus exactly one write, off by default, one parameter at a time, undoable
with a single Ctrl+Z.

## How it fits together

```
Claude Desktop · Claude Code · DSCode · any MCP client
        │  MCP over stdio
        ▼
server/server.mjs                    Node, portable — runs on Windows, macOS, Linux, in tests and demos
        │  HTTP + JSON on 127.0.0.1:8712, bearer token        (docs/protocol.md)
        ▼
addin/RevitMcp.dll                   C#, loaded by Revit — the only place the Revit API can be called
        │  Revit API on Revit's own thread (ExternalEvent)
        ▼
the model the user has open
```

Two processes because the Revit API is in-process and single-threaded: nothing outside Revit can read a
document, and nothing that touches one may run off Revit's thread. The MCP server is where the AI protocol
lives; the add-in is where the model lives.

## Try it without Revit (30 seconds)

```sh
cd server && npm install && npm run mock
```

That serves the sample model — three levels, walls, doors, rooms, schedules, warnings — so the tools, the
client config and the tests all work on a machine that has never seen Revit. Every result says `mock: true`,
so a client can never mistake it for a live building.

## Install the add-in (Windows + Revit)

```powershell
git clone https://github.com/constructelligence-lab/revit-mcp
cd revit-mcp\addin
dotnet build -c Release            # or -p:RevitVersion=2026 / 2027
copy bin\Release\net8.0-windows\RevitMcp.dll  %APPDATA%\Autodesk\Revit\Addins\2025\
copy bin\Release\net8.0-windows\manifest\RevitMcp.addin %APPDATA%\Autodesk\Revit\Addins\2025\
```

Start Revit, open a model, and the **revit-mcp** ribbon tab shows the bridge address and whether writes are
allowed. Settings live in `%APPDATA%\revit-mcp\settings.json`; the token is written to `~/.revit-mcp/token`
and read by the server from the same path. `addin/README.md` has the details, including running two Revit
versions side by side.

## Add the server to your client

Claude Desktop (`claude_desktop_config.json`) or any client with the same shape:

```json
{
  "mcpServers": {
    "revit": {
      "command": "node",
      "args": ["/path/to/revit-mcp/server/server.mjs"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add revit -- node /path/to/revit-mcp/server/server.mjs
```

To allow writes, add `--allow-writes` to the args **and** set `allowWrites` in the add-in's settings, then
restart both. Either switch alone leaves the bridge read-only.

## Tools

<!-- Generated from server/tools.mjs by `npm run tools:table` — do not edit by hand. -->
| Tool | What it does | Changes the model |
|---|---|---|
| `revit_status` | Is Revit open, which document is active, its units and worksharing state, and whether the add-in will accept writes. Call this first when anything else fails: it tells you whether the bridge is up at all. | no |
| `model_overview` | The model at a glance: file name, Revit version, level, sheet and view counts, the biggest categories by element count, and how many warnings Revit is holding. Start here for "what is in this model". | no |
| `list_levels` | Every level with its elevation and how many elements sit on it, so you can see what the model is organised around. | no |
| `list_categories` | Model categories with instance counts — walls, doors, windows, rooms, furniture and anything else the model uses. | no |
| `query_elements` | Find elements by category, level, family, type or a parameter value. Returns a compact row per element (id, category, family/type, level, mark) — the ids are what element_details, set_parameter and the other element tools take. | no |
| `element_details` | One element in full: instance and type parameters, family/type, level, host, workset and bounding box. Use it before set_parameter to see what a parameter is called and what it holds now. | no |
| `list_views` | Views in the model (floor plans, sections, 3D, schedules) with their type, level and sheet, if placed. | no |
| `list_sheets` | Sheets with number, name and the views placed on them — the drawing set as issued. | no |
| `list_families` | Loaded families with how many types each carries and how many instances are placed. | no |
| `model_warnings` | Revit's own warnings (rooms not enclosed, duplicate instances, overlapping walls) with the elements they point at. A warning is a prompt to look, not a defect finding. | no |
| `list_schedules` | Schedule views in the model — quantities, door schedules, room schedules, sheets of data. | no |
| `read_schedule` | The rows and columns of one schedule as it computes them, for quantities and take-off questions. Header names are Revit's; totals rows are marked as such. | no |
| `current_selection` | What the user has selected in Revit right now. The fastest way to answer "this wall" — ask, then work from these ids. | no |
| `export_view_image` | Render a view (the active one by default) to a PNG file and return its path and size, so a picture can be read alongside the data. Writes an image file in a temp folder; it never changes the model. | no |
| `set_parameter` | Change one parameter on one element. Preview by default (apply: false) and returns the old and new value; with apply: true it runs in a single Revit transaction, so one Ctrl+Z undoes it. Requires writes to be enabled on both the server and the add-in, and never touches type parameters that would change every instance. | **yes** — preview by default |
<!-- end tools -->

Every tool call is one bridge op, read live from the open document — no caching, no copy of the model
anywhere. `revit_status` first, then `model_overview`; ids come from `query_elements` or
`current_selection`, never from the model's imagination.

## What it deliberately does not do (v0.1)

- **No create, delete, move, or type changes.** One instance parameter at a time, previewed, in one
  transaction. Anything else is a decision for a person in Revit.
- **No save, no sync, no worksharing operations.** The bridge cannot write the file, only the model.
- **No IFC or cloud (ACC/BIM 360) access.** It reads the document Revit has open; if that is a cloud model,
  you are reading the local copy, which may be ahead of or behind what the team sees.
- **No QA verdict.** Warnings and counts are Revit's; any sentence built from them belongs to the model that
  built it. Not an audit, not a compliance record.

Roadmap in rough order: family type parameters with an explicit "this changes N instances" confirmation;
sheet and PDF export; dimension and room-boundary reads; create-and-place behind an approval step; an IFC
path (IfcOpenShell) for teams without Revit.

## Development

```sh
cd server && npm install && npm test      # 17 tests: catalogue, bridge failure modes, end-to-end MCP over stdio
cd addin && dotnet build                  # compiles against the real Revit 2025 API reference assemblies
```

The server's tests run everywhere (including CI and this Mac); the add-in compiles everywhere and runs only
where Revit does — `EnableWindowsTargeting` is what lets a net8.0-windows library build on macOS/Linux.

## Licence

MIT — see [LICENSE](LICENSE). The Autodesk Revit API assemblies are Autodesk's, referenced at compile time
and never redistributed here. Revit and Autodesk are trademarks of Autodesk, Inc.; this project is not
affiliated with or endorsed by Autodesk.
