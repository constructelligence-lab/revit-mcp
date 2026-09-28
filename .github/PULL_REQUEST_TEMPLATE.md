## What this changes

## Which part
- [ ] MCP server (tool / prompt / resource / bridge client)
- [ ] Revit add-in
- [ ] Docs

## Checklist

- [ ] A new tool has: `docs/protocol.md`, a catalogue entry, an add-in handler, and tests
- [ ] A new **write** also has: `docs/security.md`, an entry in `RevitOps.Writes`, preview by default, one
      transaction, and a refusal for anything broader
- [ ] `npm test` passes in `server/`
- [ ] `npm run check:docs` passes (README menus regenerated with `npm run tools:table` if needed)
- [ ] `dotnet build` passes in `addin/`
- [ ] CHANGELOG entry under Unreleased

## How I checked it
(Sample model, live Revit, or both — say which, and say what you could not check.)
