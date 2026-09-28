# revit-mcp

[![CI](https://github.com/constructelligence-lab/revit-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/constructelligence-lab/revit-mcp/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](server/package.json)
[![Revit](https://img.shields.io/badge/Revit-2025%20%C2%B7%202026%20%C2%B7%202027-0696D7.svg)](#install-the-add-in)
[![npm](https://img.shields.io/badge/npm-%40constructelligence%2Frevit--mcp-CB3837.svg)](server/README.md)

<img src="assets/banner.svg" alt="revit-mcp — Autodesk Revit to any MCP client" width="100%">

<p align="center"><strong>Autodesk Revit to any MCP client: read the model you have open — and, if you let it, change one parameter at a time.</strong></p>

Most "AI for BIM" asks you to upload a model somewhere, or to trust a cloud service with a client's building.
This does the opposite. Revit stays where it is, the data stays on the workstation, and the assistant gets a
narrow, auditable set of reads plus exactly one write: off by default, previewed before it happens, applied in
a single undoable transaction.

<img src="assets/diagram.svg" alt="An AI client speaks MCP over stdio to the MCP server, which speaks HTTP over loopback to the add-in inside Revit, which uses the Revit API on Revit's own thread to read and edit the open model" width="100%">

## How it works

Two processes, because the Revit API is in-process and single-threaded: nothing outside Revit can read a
document, and nothing may touch one off Revit's thread. The **MCP server** owns the AI protocol; the
**add-in** owns the model.

| | |
|---|---|
| **AI client → MCP server** | MCP over stdio. The client is the only part that may be hosted: if it is, it sends whatever a tool returned to its provider. This project sends nothing anywhere. |
| **MCP server → add-in** | HTTP + JSON on `127.0.0.1:8712` with a bearer token, loopback only. [`docs/protocol.md`](docs/protocol.md) is the contract: routes, envelope, error codes, every op. |
| **add-in → Revit** | The Revit API, on Revit's thread. Requests are queued and marshalled with an `ExternalEvent`, so Revit finishes what it is doing first. |
| **Reads** | Always available. Live at call time, never cached: a `revit://…` resource or a tool call is a read of the document as it is now. |
| **Writes** | One tool, two gates, preview by default, one transaction. Neither process can open the gate alone. |

### Where everything lives

| Path | What it does |
|---|---|
| `server/server.mjs` | MCP server: registers the menu, applies the write gate, maps tools to bridge ops |
| `server/tools.mjs` · `prompts.mjs` · `resources.mjs` | The menu itself — one place, so the README, the tests and the protocol cannot drift |
| `server/bridge.mjs` | Loopback client: token discovery, timeouts, and the error messages a person reads |
| `server/mock.mjs` | The sample model that makes all of this testable without Revit |
| `addin/Bridge/BridgeServer.cs` | `HttpListener` on loopback, token check, write gate, one JSON envelope |
| `addin/Bridge/RevitDispatcher.cs` | The queue and `ExternalEvent` that put work on Revit's thread; the abandoned-request rule |
| `addin/Handlers/` | The Revit API work: fourteen reads and one write (`parameter.set`) |
| `docs/protocol.md` · `security.md` · `guide.md` | The contract, the threat model, and the 20-minute guide |

Two processes, because the Revit API is in-process and single-threaded: nothing outside Revit can read a
document, and nothing may touch one off Revit's thread. The MCP server owns the AI protocol; the add-in owns
the model.

## Why this one

| | |
|---|---|
| **Read-only until *two* switches are on** | The add-in refuses writes with `writes_disabled` before any Revit work, and the server refuses to call the write tool. Neither can open the gate alone. |
| **One write, and it is small** | `set_parameter`: instance parameters only, preview by default, one transaction per change (one Ctrl+Z), type parameters refused with the reason. No create, delete, save or sync anywhere. |
| **A written contract** | [`docs/protocol.md`](docs/protocol.md) is the bridge: every op, argument, result and error code. Tests fail when the catalogue and the docs disagree. |
| **Testable without Revit** | A sample model behind the same bridge means the tools, prompts, resources and failure modes are covered in CI on Linux, macOS and Windows — 22 tests, no Windows required. |
| **It compiles against the real API** | The add-in builds against the genuine Revit reference assemblies, so the API misuse a CI run would catch is caught without a Revit licence. |
| **An honest threat model** | [`docs/security.md`](docs/security.md) says what is protected *and* what is not (the token file, provider egress, why read-only is still a disclosure). |
| **Numbers come from Revit** | Every figure is a live read at call time. No caching, no copy of the model, no invented ids: ids come from `query_elements` or `current_selection`. |

## Try it in 30 seconds (no Revit)

```sh
git clone https://github.com/constructelligence-lab/revit-mcp
cd revit-mcp/server
npm install
npm run demo        # a real MCP transcript against the sample model
```

```
revit-mcp demo — sample model, no Revit required

tools (15):     revit_status, model_overview, list_levels, list_categories, query_elements,
                element_details, list_views, list_sheets, list_families, model_warnings,
                list_schedules, read_schedule, current_selection, export_view_image, set_parameter
prompts (4):    model_health_check, quantities_from_schedules, sheet_qa, parameter_audit
resources (3):  revit://status, revit://model/overview, revit://warnings

{ "mock": true, "revit": { "version": "2025.2", "document": "Sample Tower.rvt",
  "units": "millimeters", "workshared": true, "activeView": "L2 - Floor Plan" },
  "writesAllowed": false, "levels": 3 }
```

Every sample answer carries `"mock": true`, so it can never be mistaken for a live building.

## Install the add-in (Windows + Revit)

```powershell
cd revit-mcp\addin
dotnet build -c Release        # Revit 2025; add -p:RevitVersion=2026 or 2027 for newer
copy bin\Release\net8.0-windows\RevitMcp.dll            %APPDATA%\Autodesk\Revit\Addins\2025\
copy bin\Release\net8.0-windows\manifest\RevitMcp.addin %APPDATA%\Autodesk\Revit\Addins\2025\
```

Start Revit, open a model, and the **revit-mcp** tab tells you the address, whether writes are allowed, and
where the token is. Full detail, including Revit 2024 and two versions side by side, in
[addin/README.md](addin/README.md).

## Connect your client

```json
{ "mcpServers": { "revit": { "command": "node",
  "args": ["/path/to/revit-mcp/server/server.mjs"] } } }
```

That shape works for Claude Desktop, Cursor, Windsurf, VS Code, DSCode and most others; Claude Code is
`claude mcp add revit -- node /path/to/revit-mcp/server/server.mjs`. Every client, plus environment
variables and the Windows path variants: [docs/clients.md](docs/clients.md).

To allow writes, add `--allow-writes` **and** set `"allowWrites": true` in
`%APPDATA%\revit-mcp\settings.json`, then restart both. Either switch alone leaves the bridge read-only.

<!-- Generated from server/tools.mjs by `npm run tools:table` — do not edit by hand. -->
## The menu

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

### Workflow prompts

| Prompt | The workflow it writes out |
|---|---|
| `model_health_check` | Read the model the way a BIM manager would on a Monday: sizes, warnings, what is on each level, what stands out. |
| `quantities_from_schedules` | Take-off numbers for an estimate, read from the schedules the model computes, with the caveats a quantity surveyor would want. |
| `sheet_qa` | Check what was issued: sheets, their views, revisions, and anything printed that should not have been. |
| `parameter_audit` | Find empty Marks and other unpopulated identity data, then preview the fix one element at a time — nothing is written without a yes. |

### Live resources

| Resource | What a client gets |
|---|---|
| `revit://status` | Which document is open, the Revit version, and whether the bridge will accept writes. Read this before blaming a tool for failing. |
| `revit://model/overview` | Counts and the biggest categories in the open model — the same answer model_overview gives. |
| `revit://warnings` | Revit's own warnings for the open model, live. A warning is a prompt to look, not a finding. |
<!-- end menus -->

`revit_status` first, then `model_overview`; ids come from `query_elements` or `current_selection`, never
from the model's imagination. A call with no `apply: true` changes nothing.

## What a session looks like

One call, end to end — the same path for every read, and the two extra steps a write takes:

<img src="assets/call-path.svg" alt="A read goes client to server to add-in to Revit and back; a write is previewed first and only applied with apply true, inside one transaction; a request that times out is abandoned so it cannot apply later" width="100%">


```jsonc
// query_elements { "category": "Doors", "parameter": "Fire Rating", "value": "90" }
{ "category": "Doors", "total_matched": 6, "scanned": 18,
  "rows": [ { "id": 100037, "category": "Doors", "family": "Double-Flush",
              "type": "1830 x 2134mm", "level": "L1", "mark": "D-100" } ] }

// set_parameter { "element_id": 100043, "parameter": "Mark", "value": "D-999" }   ← no apply
{ "element_id": 100043, "element": "Single-Flush: 0915 x 2134mm", "parameter": "Mark",
  "old_value": "D-105", "new_value": "D-999", "applied": false,
  "note": "Preview only. Nothing changed — call again with apply: true to make this change." }
```

Five worked workflows — model health check, quantities from schedules, sheet QA, parameter audit, and reading
a rendered view — are in [docs/guide.md](docs/guide.md), and four of them ship as prompts.

## Documentation

| | |
|---|---|
| [docs/guide.md](docs/guide.md) | The 20-minute guide, five workflows, the house rules, troubleshooting |
| [docs/protocol.md](docs/protocol.md) | The bridge contract: routes, envelope, error codes, every op |
| [docs/security.md](docs/security.md) | What is protected, what is not, and the settings to use by situation |
| [docs/clients.md](docs/clients.md) | Every client config, environment variables, the mock |
| [docs/faq.md](docs/faq.md) | Safety, cloud models, Revit versions, why only one write tool |
| [docs/roadmap.md](docs/roadmap.md) | What is next, and what is deliberately not planned |

## What it deliberately does not do

- **No create, delete, move or type changes.** One instance parameter at a time, previewed, in one
  transaction; anything else is a decision for a person in Revit.
- **No save, sync or worksharing operations.** The bridge edits the open model; it never writes the file.
- **No IFC or cloud (ACC/BIM 360) access.** It reads the document Revit has open, which may be ahead of or
  behind what the rest of the team sees.
- **No QA verdict.** Warnings and counts are Revit's; the sentence built from them is the model's. Not an
  audit, not a compliance record.

## Development

```sh
cd server && npm install
npm test              # 22 tests: catalogues, bridge failure modes, end-to-end MCP over stdio, write gate
npm run demo          # the transcript above, for real
npm run tools:table   # regenerate the menus in this README
npm run check:docs    # fail if they are out of date (CI runs this)

cd ../addin && dotnet build    # compiles against the real Revit 2025 reference assemblies
```

CI runs the server on Node 20 and 22, builds the add-in against Revit 2025, 2026 and 2027 plus .NET Framework
4.8, and fails on documentation drift. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a tool, and
[SECURITY.md](SECURITY.md) for reporting.

## Licence

MIT — see [LICENSE](LICENSE). The Autodesk Revit API assemblies are Autodesk's, referenced at compile time and
never redistributed. Revit and Autodesk are trademarks of Autodesk, Inc.; this project is not affiliated with
or endorsed by Autodesk.

Built by [Constructelligence](https://constructelligence.co) — the same people who write the
[AI in construction guide](https://github.com/constructelligence-lab/ai-in-construction-guide).
