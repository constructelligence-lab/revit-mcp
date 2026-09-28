# Roadmap

What exists, what is next, and what is deliberately not planned — so you can judge whether to depend on it.

## v0.1 — shipped

- Loopback bridge inside Revit, bearer token, read-only by default, writes gated in both processes
- 15 tools: model and category reads, element query/details, levels, views, sheets, families, schedules,
  warnings, current selection, view-to-PNG, and `set_parameter` (preview, one transaction, instance only)
- 4 prompt workflows and 3 live resources, so clients inherit a method rather than inventing one
- Sample model for demos, CI and tests with no Revit installed; 22 tests
- `docs/protocol.md` (the contract), `docs/security.md` (what is and is not protected)

## Next

1. **Family type parameters**, with the sentence that matters: *"this changes 14 instances of Single-Flush
   0915 × 2134mm"* and an explicit yes. The refusal text is already written; the tool is not.
2. **Sheet and PDF export** — `export_sheet_pdf`, because issuing a set is the next thing people ask for.
3. **Rooms and boundaries** — room list with area, level, department; boundary loops for take-off.
4. **Dimensions and grids** — read, not write: what is dimensioned, what is on a grid line.
5. **Change journal** — every write recorded locally with document, element, parameter, old value, new value,
   so a session can be reviewed afterwards, not just undone.

## Later

- **Approval step for creates**: draft an element (wall, door, level) and require a human to confirm twice
  before it lands.
- **IFC path** via IfcOpenShell for teams without Revit — a different bridge with the same tool names.
- **Worksharing awareness**: say whether the document is checked out, who has what, and refuse writes that
  would collide rather than letting Revit raise a dialog.
- **A visual diff**: render a view before and after a batch of previewed changes.

## Not planned

- **Deleting or moving elements over the bridge.** Undo exists, but "the AI deleted the wrong wall" is not a
  sentence worth engineering around.
- **Saving, syncing or worksharing operations.** The bridge reads and edits the open model; it never writes
  the file.
- **A cloud service.** There is no account, no upload, no sync. If that is what you want, it is a different
  product and it should say so on the tin.
- **Compliance or QA verdicts.** Warnings are prompts to look. Anything stronger needs a person's name on it.
