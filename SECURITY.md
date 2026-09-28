# Security

## Reporting

Open a [private security advisory](https://github.com/constructelligence-lab/revit-mcp/security/advisories/new)
rather than a public issue, and include: what you did, what happened, the Revit version, the MCP client, and
whether writes were enabled. Expect an answer within a few days.

## In scope

- Reaching the bridge from anywhere other than loopback (it binds `127.0.0.1`)
- Getting a write applied with writes disabled at either end, or without `apply: true`
- A timed-out or cancelled request still changing the model
- Reading or writing files outside the intended temp folder via `view.export_image`
- Prompt injection that turns a *read* into a *write* or a disclosure — the model is untrusted input here, the
  same as a web page would be
- Privilege escalation inside Revit through the add-in's ribbon commands or settings file

## Out of scope (by design, documented in docs/security.md)

- The token file being readable by processes running as the same user
- Whatever an AI client sends to its model provider after a tool returns data
- A user enabling writes and then being surprised that writes happen
- Revit's own behaviour, or Autodesk's API

## What this project will not do

- Add a capability that changes many elements at once, saves the file, or deletes anything
- Add a cloud component, telemetry, or an account
- Weaken the two-switch write gate, or the preview-by-default rule, for convenience

`docs/security.md` is the current threat model; changes to it are part of the pull request that changes the
behaviour.
