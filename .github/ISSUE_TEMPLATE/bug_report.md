---
name: Bug report
about: Something did not work — a tool, the bridge, the build, or the docs
labels: bug
---

**What happened**

**What you expected**

**Which part** (tick one)
- [ ] MCP server (tools, prompts, resources, mock)
- [ ] Revit add-in (bridge, ribbon, settings)
- [ ] Docs / guide
- [ ] Build or install

**Environment**
- Revit version:
- MCP client (Claude Desktop / Claude Code / Cursor / DSCode / other):
- Node version (`node --version`):
- OS:
- Writes enabled? (add-in `allowWrites`, server `--allow-writes`):

**Evidence**
- For a tool problem: the tool name, the arguments, and the result
- For a bridge problem: the last lines of `%APPDATA%\revit-mcp\bridge.log`
- `revit_status` output, if you can get one (redact the document path if you must)
