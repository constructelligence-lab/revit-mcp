using System.Diagnostics;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMcp;

/// <summary>What the bridge is doing right now, said where the person who owns the model can see it.</summary>
[Transaction(TransactionMode.ReadOnly)]
[Regeneration(RegenerationOption.Manual)]
public sealed class BridgeStatusCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        var settings = McpSettings.Load();
        var bridge = App.Bridge;
        var lines = new List<string>
        {
            bridge is null ? "Bridge: not created (autoStart is off — restart Revit after enabling it)"
                : bridge.IsRunning ? "Bridge: running" : "Bridge: stopped",
            $"Address: {settings.Endpoint} (loopback only)",
            $"Writes: {(settings.AllowWrites ? "ALLOWED — a client may change parameters" : "read-only — no tool can change this model")}",
            $"Token: {McpSettings.TokenPath}",
            $"Settings: {Path.Combine(McpSettings.Directory, "settings.json")}",
            $"Log: {Path.Combine(McpSettings.Directory, "bridge.log")}",
        };
        if (bridge is not null)
            lines.Add($"Requests: {bridge.CompletedCount} completed, {bridge.QueuedCount} waiting on Revit");

        TaskDialog.Show("revit-mcp", string.Join(Environment.NewLine, lines));
        return Result.Succeeded;
    }
}

/// <summary>Open the settings folder, so editing <c>allowWrites</c> is a two-click job rather than a hunt.</summary>
[Transaction(TransactionMode.ReadOnly)]
[Regeneration(RegenerationOption.Manual)]
public sealed class OpenSettingsFolderCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        Directory.CreateDirectory(McpSettings.Directory);
        Process.Start(new ProcessStartInfo("explorer.exe", McpSettings.Directory) { UseShellExecute = true });
        return Result.Succeeded;
    }
}
