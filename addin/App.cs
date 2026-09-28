using Autodesk.Revit.UI;
using RevitMcp.Bridge;

namespace RevitMcp;

/// <summary>
/// The add-in entry point. It starts the loopback bridge inside Revit (nothing to launch separately, and
/// nothing to leave running when Revit closes), and puts two buttons on a ribbon tab so the state of the
/// bridge is answerable from inside Revit rather than from a log.
///
/// Loading this add-in does not connect anything to anything: the bridge listens on loopback only, requires
/// the token file as a bearer token, and refuses writes unless <c>allowWrites</c> is set. Connecting a client
/// is a separate, deliberate step — see the repository README.
/// </summary>
public sealed class App : IExternalApplication
{
    /// <summary>The running bridge, for the ribbon commands. Null when autoStart is off and nobody started it.</summary>
    public static BridgeServer? Bridge { get; private set; }

    public Result OnStartup(UIControlledApplication application)
    {
        try
        {
            var settings = McpSettings.Load();
            var dispatcher = new RevitDispatcher();
            Bridge = new BridgeServer(settings, dispatcher);

            if (settings.AutoStart)
            {
                try
                {
                    Bridge.Start();
                }
                catch (Exception ex)
                {
                    // A port already in use must not stop Revit from loading; the ribbon says what happened.
                    McpSettings.Log($"bridge could not start: {ex}");
                }
            }

            CreateRibbon(application);
            return Result.Succeeded;
        }
        catch (Exception ex)
        {
            McpSettings.Log($"add-in failed to start: {ex}");
            TaskDialog.Show("revit-mcp", $"The revit-mcp add-in could not start:\n\n{ex.Message}\n\nSee %APPDATA%\\revit-mcp\\bridge.log.");
            return Result.Failed;
        }
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        Bridge?.Dispose();
        Bridge = null;
        return Result.Succeeded;
    }

    private static void CreateRibbon(UIControlledApplication application)
    {
        const string tab = "revit-mcp";
        try
        {
            application.CreateRibbonTab(tab);
        }
        catch (Exception)
        {
            // The tab already exists (another add-in, or a reload during development) — reuse it.
        }

        var panel = application.CreateRibbonPanel(tab, "AI bridge");
        var statusButton = new PushButtonData("RevitMcpStatus", "Bridge\nstatus", typeof(App).Assembly.Location, typeof(BridgeStatusCommand).FullName)
        {
            ToolTip = "Where the revit-mcp bridge is listening, whether it will accept writes, and where its token is.",
        };
        var folderButton = new PushButtonData("RevitMcpFolder", "Settings\nfolder", typeof(App).Assembly.Location, typeof(OpenSettingsFolderCommand).FullName)
        {
            ToolTip = "Open the folder holding settings.json and bridge.log.",
        };

        panel.AddItem(statusButton);
        panel.AddItem(folderButton);
    }
}
