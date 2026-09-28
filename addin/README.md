# The Revit add-in

A `IExternalApplication` that starts a loopback HTTP bridge inside Revit and serves the ops in
`../docs/protocol.md`. Revit loads it; there is nothing else to launch.

## Build

```sh
dotnet build -c Release                                  # against Revit 2025 (net8.0-windows)
dotnet build -c Release -p:RevitVersion=2026             # 2026 or 2027
dotnet build -c Release -p:RevitVersion=2024 -p:TargetFramework=net48   # 2024 and older: .NET Framework 4.8
```

The two `Nice3point.Revit.Api.*` packages are **compile-time only** (`ExcludeAssets="runtime"`): they carry
the API surface and no implementation, so this builds on any machine with the .NET SDK, including CI and
macOS, while Revit supplies the real assemblies at run time. `EnableWindowsTargeting` is what allows a
`net8.0-windows` library to compile off Windows.

## Install

Copy the DLL and the manifest into the Revit release folder — `2025` below is the year, and it must match
the release you are running:

```powershell
copy bin\Release\net8.0-windows\RevitMcp.dll              %APPDATA%\Autodesk\Revit\Addins\2025\
copy bin\Release\net8.0-windows\manifest\RevitMcp.addin   %APPDATA%\Autodesk\Revit\Addins\2025\
```

Start Revit and open the **revit-mcp** tab. *Bridge status* answers, from inside Revit, what the bridge is
doing; *Settings folder* opens `%APPDATA%\revit-mcp` where `settings.json` and `bridge.log` live.

## Settings

`%APPDATA%\revit-mcp\settings.json` (created with defaults on first run; an environment variable wins):

```json
{
  "port": 8712,          // loopback port; change it if something else owns 8712
  "allowWrites": false,  // false = no tool can change this model, whatever the client asks
  "token": "",           // empty = a token was generated for you and written to ~/.revit-mcp/token
  "autoStart": true      // false = the bridge starts only when you press the ribbon button (not wired in v0.1)
}
```

Environment overrides: `REVIT_MCP_PORT`, `REVIT_MCP_ALLOW_WRITES=1`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Client says `No revit-mcp add-in at …` | Revit is closed, the add-in is not loaded, or the port differs | Check the ribbon tab; check `bridge.log` |
| Client says the token was refused | `~/.revit-mcp/token` (used by the server) differs from `settings.json` (used by Revit) | Delete both and restart Revit to regenerate, then restart the server |
| Client says Revit did not answer in time | A modal dialog or a long command holds Revit's UI thread | Close the dialog; nothing was half-applied (see below) |
| `writes_disabled` | The add-in is read-only | Set `allowWrites` to true **and** start the server with `--allow-writes` |
| Nothing in the log, ribbon says the bridge failed to start | Port already in use | Change `port`, restart Revit |

A timed-out request is marked abandoned and skipped when Revit's thread frees up: a write whose answer was
"it did not happen" must never happen a minute later. Writes run in a single `Transaction`, so one Ctrl+Z in
Revit undoes one tool call — and no op can save, sync, create or delete.
