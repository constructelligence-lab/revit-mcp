# What the bridge exposes, and what it does not

An AI that can read a live Revit model is useful. An AI that can change one is a different kind of
decision, and this file is the honest accounting of both — including the parts that are not protected.

## The shape of it

```
Revit  ──add-in──►  127.0.0.1:8712  ◄──HTTP──  MCP server  ◄──stdio──  AI client
         (in-process)   loopback only              (same machine)        (may be a hosted model)
```

Nothing about Revit is on the network: the add-in binds loopback, and the MCP server is a local process.
The part that can leave the machine is whatever the AI client sends to its model provider. That is the
client's decision, not this bridge's, and it is the reason to read the next section before pointing a
hosted model at a client's building.

## Controls, and what each one is for

| Control | Default | What it buys |
|---|---|---|
| Loopback bind | always | No other machine can reach the bridge, whatever the firewall says |
| Bearer token | generated on first run | A different local user, or a stray process, cannot drive the bridge |
| Read-only | **on** | A fresh install cannot change anything; `parameter.set` is refused with `writes_disabled` before any Revit work |
| Write opt-in in two places | off | The add-in (`settings.json`) and the MCP server (`--allow-writes`) must both allow it — neither can open the gate alone |
| Preview by default | on | `parameter.set` answers with the old and new value; the change needs `apply: true` |
| One transaction per write | always | One Ctrl+Z in Revit undoes it; a refusal happens before the transaction opens |
| Instance parameters only | always | A type parameter would change every instance of that type; that is not a change to make over a socket |
| No create, delete, move, save, sync | always | v0.1 has no op for any of them |
| Abandoned-request rule | always | A request whose client already got a timeout is skipped, so "it did not happen" stays true |
| Local logs only | always | `%APPDATA%\revit-mcp\bridge.log` records what ran; nothing is sent anywhere by this bridge |

## What is *not* protected

- **The token file is readable by anything running as the same user.** It is a boundary between users and
  stray processes, not a defence against a compromised account. Rotate it by deleting `~/.revit-mcp/token`
  and `%APPDATA%\revit-mcp\settings.json`'s `token` and restarting Revit.
- **Whatever a tool returns goes to the AI client, and possibly to its model provider.** A `model_overview`
  of a client's tower is client information. If the client is a hosted model, that data leaves the machine
  under that provider's terms — decide that the way you would decide to email the same extract.
- **A read-only bridge is still a disclosure.** Reading schedules, sheets and warnings is often enough to
  infer commercial information. Read-only means "cannot change", not "cannot leak".
- **The model can be wrong about what it read.** Warnings and counts are Revit's, but the sentence built
  from them is the model's. Nothing here is a QA report, an audit, or a substitute for a person checking
  the model — say so in whatever you build on top.
- **The add-in runs with your rights inside Revit.** It is compiled from this repository; if you build from
  a fork, read `addin/Bridge/BridgeServer.cs` before you load it into a live project.
- **Cloud models.** If the model is cloud-workshared (ACC/BIM 360), the add-in still reads the local
  document Revit has open — including local changes not yet synced. What you read may not be what the team
  sees. Say which document and when it was last synced, or do not claim more than that.

## Recommended settings by situation

| Situation | `allowWrites` | `--allow-writes` | Notes |
|---|---|---|---|
| Trying it out | false | no | Sample model, or a throwaway copy |
| Reading a live project | false | no | The useful default; ask for the parameter changes in Revit |
| Editing with someone watching | true | yes | Preview first, say what will change, one change at a time |
| Anything in a contract | — | — | Not this. The model, the numbers and the sentence about them need a person's name on them |
