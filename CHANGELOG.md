# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are semver, and the bridge protocol in
`docs/protocol.md` is versioned with them.

## [Unreleased]

## [0.3.0]

### Added

- **Photoreal renders.** `render_photoreal` exports the model as glTF and renders it with Blender Cycles on
  the same machine: physical sky, the sun placed from the model's latitude, the date and time, real glass,
  ground, AgX colour, bloom and vignette. `render_turntable` makes a frame sequence (and an MP4 with ffmpeg).
- **`export_model`**: PDF, DWG, IFC (IFC4) and glTF (geometry with materials) to files on the Revit machine.
  Nothing in the model changes.
- **More of the model, read-only:** `list_rooms` (with boundary loops), `project_structure` (grids, links,
  phases, design options, worksets, revisions), `list_materials`, `wall_layers` (layer build-ups),
  `geometry_quantities` (area, volume, length by type) and `check_clashes` (category against category).
- **`create_schedule`**: a second gated write. Previewed unless `apply: true`, one transaction.
- Camera: sun position from latitude, date and solar time (`sunPosition`). 10 new tools, 10 new tests (43).
- `docs/rendering.md`.

## [0.2.0]

### Added

- **Renderings.** `render_scene` and `render_gallery` make presentation pictures and hand the image back to
  the client so it can judge and re-shoot. Named shots (exterior corners, aerials, elevations, top, interior
  of a room) or an explicit camera; `mood` or an exact sun date and time at the model's real site; sky,
  outlines, visual style, hidden categories, section box; up to 4000 px.
- **`scene_info`**: bounds, true north, site, levels, room centres and existing 3D views, so a camera is
  placed from facts.
- **`presentation_renders`** prompt: plan the shots, shoot, look, fix, choose.
- `export_view_image` now returns the image to the client as well as the path.
- Add-in `scene.info` and `scene.render` ops. The render builds a throw-away 3D view and rolls a
  `TransactionGroup` back: no lasting change to the model, its views or the undo stack. 180 s timeout.
- `server/camera.mjs`: camera planning in testable JavaScript; 11 new tests (33 in all).

### Fixed

### Fixed

- **The CI matrix now builds every supported Revit release.** Revit 2027's API package targets .NET 10, and
  the `net48` build for Revit 2024 needed .NET Framework reference assemblies, `System.Text.Json`, and a
  `Compat` layer for the APIs that framework lacks (`Math.Clamp`, `Task.WaitAsync`, `Convert.ToHexString`,
  `Environment.ProcessId`, `CryptographicOperations.FixedTimeEquals`, `Dictionary.TryAdd`, range syntax,
  `GetValueOrDefault`, `ToHashSet`).
- **`fail-fast: false`** on the add-in matrix: one release failing no longer cancels the others, which is how
  the Revit 2026 job went unreported on the first run.
- The `net48` job restores with the framework override before building: an implicit restore during
  `dotnet build` does not see `-p:TargetFramework`.

## [0.1.0] — 2026-09-28

### Added

- **Bridge inside Revit** (`addin/`): loopback `HttpListener` on `127.0.0.1:8712`, bearer token generated on
  first run and written to `~/.revit-mcp/token`, `ExternalEvent` marshal onto Revit's thread, ribbon tab with
  a status dialog and a settings-folder button.
- **MCP server** (`server/`): 15 tools, 4 prompt workflows, 3 live resources, a mock model for demos and CI,
  and a demo transcript (`npm run demo`).
- **One write**, off by default: `set_parameter` — instance parameters only, preview by default, applied in a
  single undoable transaction, gated in both processes.
- **Docs**: the contract (`docs/protocol.md`), the threat model (`docs/security.md`), the 20-minute guide
  (`docs/guide.md`), client configs (`docs/clients.md`), FAQ and roadmap.
- **Tests**: 22 across tool/prompt/resource catalogues, bridge failure modes, end-to-end MCP over stdio, and
  the write gate. The add-in compiles against the genuine Revit 2025 API reference assemblies.
- **CI**: server on Node 20 and 22, add-in against Revit 2025/2026/2027, and a docs-drift check that fails
  when the README menus no longer match the catalogues.

### Notes

- The add-in has not yet been run inside a live Revit by the maintainers; it compiles against the real API
  and its bridge logic is covered by the server's contract tests. First live run is the top of the roadmap.
