# FAQ

**Is this safe to point at a live project?**
Read [security.md](security.md) and decide; the summary is that nothing is exposed on the network (loopback
only), a token is required, and writes are off until you turn them on in two places. Read-only is still a
disclosure: a model that can read schedules and warnings can infer commercial things. Treat whatever the
client sees the way you would treat an extract you emailed.

**Does it phone home?**
This bridge does not: no telemetry, logs stay in `%APPDATA%\revit-mcp\bridge.log`, and the only outbound
traffic is whatever your AI client sends to its model provider. If you use a hosted model, model data reaches
that provider — that is the client's decision, and the reason the mock exists for testing prompts.

**Why two processes?**
The Revit API only works inside Revit and only on Revit's thread. The add-in owns that; the MCP server owns
the AI protocol. It also means the tool definitions are testable on any machine, including CI, without Revit.

**Why not read the .rvt file directly?**
Because a file is a snapshot and the interesting questions ("what is selected", "what warnings does this
session have", "what does this schedule compute") are answered by a running Revit. It also avoids writing a
second, worse Revit.

**Why are there so few write tools?**
There are two. Because "an AI changed our model" should be a small, reviewable sentence. `set_parameter` covers the majority
of useful edits (Marks, Comments, Fire Rating, status parameters) and `create_schedule` adds one schedule view; both preview by default, runs in one
transaction, and refuses type parameters — a type change silently rewrites every instance. Delete,
move, save and sync are deliberately absent, and creating model elements is on the roadmap behind an approval step; they are decisions for a person in Revit.

**Can it change a family type parameter?**
Not yet. When it does, it will say "this changes N instances" and ask, because that is the sentence a person
needs before saying yes.

**Which Revit versions does it build for?**
The framework follows the release: Revit 2025 and 2026 host .NET 8 (`net8.0-windows`), Revit 2027 hosts
.NET 10 (`net10.0-windows`), Revit 2024 and older host .NET Framework 4.8 (`net48`). Pass
`-p:RevitVersion=2027` and the project picks the framework; CI builds all four, on Linux and Windows. Only
running it needs Windows and Revit.

**Does it work with cloud-workshared (ACC/BIM 360) models?**
It reads the document Revit has open, which is the local copy: it may be ahead of or behind what the rest of
the team sees, and it may include unsynced work. Say what you read; do not claim it is "the model".

**What about IFC, Navisworks, Civil 3D?**
Not this. The bridge is Revit's API. An IFC path (IfcOpenShell) is on the roadmap for teams without Revit.

**Can two clients connect at once?**
Yes — they take turns. The add-in queues calls and runs them on Revit's thread, one at a time.

**Is a warning a defect?**
No. It is Revit telling you it wants a human to look. The counts and messages are Revit's; the sentence built
from them is the model's, and neither is a QA report.

**What happens if a request times out?**
The add-in marks it abandoned and skips it when Revit's thread frees up, so a write whose answer was "it did
not happen" cannot happen a minute later. Retry after closing the dialog that held the thread.
