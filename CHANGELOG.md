# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are semver, and the bridge protocol in
`docs/protocol.md` is versioned with them.

## [Unreleased]

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
