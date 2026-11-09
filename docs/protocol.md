# The bridge protocol

The contract between the two halves of revit-mcp: the MCP server (`server/`) and the add-in inside Revit
(`addin/`). Both sides implement this file; nothing else is negotiated. Tools are named for the AI client,
ops are named for this bridge, and `server/tools.mjs` maps one to the other — a new tool without an op, or
an op without a handler, fails the test suite rather than at 7am on a deadline.

## Transport

| | |
|---|---|
| Address | `http://127.0.0.1:8712/` — loopback only, bound by the add-in. The port is `port` in `%APPDATA%\revit-mcp\settings.json`. |
| Auth | `Authorization: Bearer <token>` on every route once a token exists. The add-in generates one on first run and writes it to `~/.revit-mcp/token`; the MCP server reads the same path (or `REVIT_MCP_TOKEN`). |
| Body | JSON. `POST /op` bodies over 1 MB are refused (`too_large`). |
| Version | `GET /health` reports `bridge.version`. A client that speaks a different *major* version should say so rather than guess. |

## Routes

### `GET /health`

```json
{ "ok": true, "result": {
    "bridge": { "version": "0.3.0", "pid": 4711, "writesAllowed": false, "port": 8712, "mock": false },
    "revit": { "version": "2025", "document": "Tower.rvt", "path": "C:\\Projects\\Tower.rvt",
               "units": "autodesk.spec.aec:length-millimeters", "workshared": true,
               "activeView": "L2 - Floor Plan", "modified": true },
    "levels": 12 } }
```

`revit` is null when no document is open — the bridge is up, the model is not, which is a different problem
with a different fix.

### `POST /op`

```json
{ "op": "elements.query", "args": { "category": "Walls", "level": "L2", "limit": 10 } }
```

Answer, always HTTP 200 so the error travels in one shape:

```json
{ "ok": true,  "result": { } }
{ "ok": false, "error": { "code": "not_found", "message": "No level named 'L9'. list_levels shows the levels in this document." } }
```

Only three things are not HTTP 200: `401` (bad or missing token), `400` (`bad_json`, `bad_request`,
`too_large`), `404` (not a known route). Everything Revit-related is a `200` with `ok: false`, because a
missing element is not a transport failure and a client should not have to tell them apart.

## Error codes

| Code | Meaning | What a client should do |
|---|---|---|
| `bad_request` | A required argument is missing or malformed | Fix the call; the message names the argument |
| `bad_json` | The body was not JSON | Fix the call |
| `too_large` | Body over 1 MB | Send arguments, not uploads |
| `unauthorized` | Token missing or wrong | Read the token file; do not retry blindly |
| `writes_disabled` | The op changes the model and the add-in is read-only | Ask the operator; there is no client-side override |
| `unknown_op` | No such op | The version of the two halves does not match |
| `no_document` | Revit is open with no model | Open a model |
| `not_found` | No such element, level, view or schedule | List first (`query_elements`, `list_levels`, …) |
| `unknown_category` | Category name not in this document | `categories.list` |
| `read_only_parameter` | Revit will not let that parameter be set | Nothing; it is calculated or system-controlled |
| `unsupported_storage` | Parameter is not text/number/element id | v0.1 has no handler for it |
| `revit_refused` | Revit rejected the value | The parameter has rules; set it in Revit to see why |
| `bad_value` | Value not parseable for that parameter | Send what Revit would accept |
| `timeout` | Revit did not run the request in time | Close the modal dialog; retry |
| `revit_error` | An API exception | Read `bridge.log` on the Revit machine |

## Timeouts, and what a timeout means

Reads get 30 s, writes 60 s (a transaction can wait on a workset checkout). Revit's API is single-threaded:
while a modal dialog is open, nothing queued runs, so a call can time out with the work *still queued*.
The add-in marks such a request abandoned and skips it when its turn comes — a write whose answer was "it
did not happen" must never quietly happen later.

## Ops

Args are JSON; all are optional unless marked required. Lengths are in the document's own units.

| Op | Args | Result |
|---|---|---|
| `status` | — | Bridge and Revit state, active document, `writesAllowed` |
| `model.overview` | `category_limit` (≤100) | Counts (levels, views, sheets, schedules, families, warnings, elements) + categories by instance count |
| `levels.list` | — | Levels with elevation and element count |
| `categories.list` | `limit` | Model categories with instance counts |
| `elements.query` | `category` **required**, `level`, `family`, `type`, `parameter`, `value`, `limit`, `offset` | Rows `{id, category, family, type, level, mark}`, plus `total_matched`, `scanned`, `truncated` |
| `element.details` | `element_id` **required** | Instance and type parameters, family/type, level, workset, host, bounding box |
| `views.list` | `type`, `limit` | Views with type, level and sheet |
| `sheets.list` | `limit` | Sheets with placed views and revision |
| `families.list` | `limit` | Families with type and instance counts |
| `warnings.list` | `limit` | Revit's failure messages with failing element ids |
| `schedules.list` | — | Schedule views with row and column counts |
| `schedule.read` | `schedule` **required**, `limit` | Column titles and computed rows |
| `selection.get` | — | What the user has selected in Revit |
| `view.export_image` | `view`, `width` | Writes a PNG under `%TEMP%\revit-mcp` and returns the path Revit wrote |
| `scene.info` | `room_limit` | Bounds of the model's elements, true north, site latitude/longitude, levels, room centres, existing 3D views |
| `scene.render` | `eye`, `target` **required** (`[x, y, z]` in the document unit); `perspective`, `style`, `sun`, `background`, `outlines`, `hide_categories`, `section_box`, `width`, `format`, `name` | Builds a temporary 3D view, exports it, rolls it back (`model_changed: false`); returns the image path. 180 s timeout |
| `rooms.list` | `level`, `boundaries`, `limit` | Rooms: number, name, level, department, area, perimeter, volume; optional boundary loops |
| `structure.list` | `kind` **required** (`grids`, `links`, `phases`, `design_options`, `worksets`, `revisions`), `limit` | Rows for that kind |
| `materials.list` | `name`, `limit` | Materials: class, colour, transparency |
| `wall.layers` | `element_id` **required** | Layer function, material and thickness for a wall, floor, roof or ceiling type |
| `geometry.quantities` | `category` **required**, `level` | Count, area (m²), volume (m³), length by type, from Revit's computed values |
| `clash.check` | `category_a`, `category_b` **required**, `level`, `limit` | Intersecting element pairs (`ElementIntersectsElementFilter`), sampled on large models |
| `export.pdf` / `export.dwg` | `sheets`, `views`, `name`, `separate` (pdf) | Files under `%TEMP%\revit-mcp\exports`; 180 s timeout |
| `export.ifc` | `name` | IFC4 file, same folder |
| `export.gltf` | `name`, `hide_categories`, `section_box` | glTF 2.0 (`.gltf` + `.bin`), metres, Y-up, materials as PBR colours; links skipped |
| `schedule.create` | `category`, `fields` **required**, `name`, `sort_by`, `apply` (default false) | **Write.** Preview lists matched and missing fields; `apply: true` adds the schedule in one transaction |
| `parameter.set` | `element_id`, `parameter`, `value` **required**, `apply` (default false) | Preview: old and new value. `apply: true`: one transaction, `applied: true` |

`scene.render` is not in the write set: it runs inside a `TransactionGroup` that is always rolled back, so nothing it creates survives. `parameter.set` and `schedule.create` are the only ops in the write set (see `RevitOps.Writes`). Adding another means changing that
list, the tool catalogue and `docs/security.md` together — the tests fail if they disagree.
