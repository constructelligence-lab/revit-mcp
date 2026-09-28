using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitMcp;

/// <summary>
/// What the bridge is allowed to do, read once at startup from
/// <c>%APPDATA%\revit-mcp\settings.json</c> (an environment variable wins):
///
/// <code>
/// { "port": 8712, "allowWrites": false, "token": "", "autoStart": true }
/// </code>
///
/// Two defaults matter. <see cref="AllowWrites"/> is false, so a fresh install can only read — an AI that
/// can change a live model the first time it is connected is not a sensible default, whatever the model is.
/// And the bridge binds loopback only: Revit is on a workstation with drawings on it, not on a network share.
/// </summary>
public sealed class McpSettings
{
    /// <summary>Where the settings file lives. Also the folder the token file is written to.</summary>
    public static string Directory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "revit-mcp");

    /// <summary>The token file the MCP server reads: <c>~/.revit-mcp/token</c>.</summary>
    public static string TokenPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".revit-mcp", "token");

    public int Port { get; set; } = 8712;

    /// <summary>Whether the write tools (currently <c>parameter.set</c>) may change the model at all.</summary>
    public bool AllowWrites { get; set; }

    /// <summary>A shared secret the MCP server must present. Generated on first run when left empty.</summary>
    public string Token { get; set; } = string.Empty;

    /// <summary>Start the bridge with Revit. False means "only when I press the ribbon button".</summary>
    public bool AutoStart { get; set; } = true;

    [JsonIgnore]
    public string Endpoint => $"http://127.0.0.1:{Port}/";

    public static McpSettings Load()
    {
        var settings = new McpSettings();
        var path = Path.Combine(Directory, "settings.json");
        if (File.Exists(path))
        {
            try
            {
                settings = JsonSerializer.Deserialize<McpSettings>(
                    File.ReadAllText(path),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true, ReadCommentHandling = JsonCommentHandling.Skip }) ?? settings;
            }
            catch (Exception ex)
            {
                Log($"settings.json could not be read ({ex.Message}); using defaults (read-only)");
            }
        }

        if (int.TryParse(Environment.GetEnvironmentVariable("REVIT_MCP_PORT"), out var port) && port is > 0 and < 65536)
            settings.Port = port;
        if (Environment.GetEnvironmentVariable("REVIT_MCP_ALLOW_WRITES") is { Length: > 0 } writes)
            settings.AllowWrites = writes is "1" or "true" or "TRUE" or "yes";

        // A token is generated once and reused; the file is per-user, and the server reads the same path.
        if (string.IsNullOrWhiteSpace(settings.Token))
        {
            var existing = File.Exists(TokenPath) ? File.ReadAllText(TokenPath).Trim() : string.Empty;
            settings.Token = existing.Length > 0 ? existing : Compat.ToHex(Guid.NewGuid().ToByteArray());
        }
        try
        {
            System.IO.Directory.CreateDirectory(Path.GetDirectoryName(TokenPath)!);
            File.WriteAllText(TokenPath, settings.Token);
        }
        catch (Exception ex)
        {
            Log($"token file could not be written to {TokenPath}: {ex.Message}");
        }
        return settings;
    }

    /// <summary>Append one line to <c>%APPDATA%\revit-mcp\bridge.log</c>. Support artefacts, not telemetry: nothing leaves the machine.</summary>
    public static void Log(string message)
    {
        try
        {
            System.IO.Directory.CreateDirectory(Directory);
            File.AppendAllText(Path.Combine(Directory, "bridge.log"), $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never be the reason the add-in fails to load.
        }
    }
}
