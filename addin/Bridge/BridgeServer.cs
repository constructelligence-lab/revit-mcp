using System.Net;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.UI;
using RevitMcp.Handlers;

namespace RevitMcp.Bridge;

/// <summary>
/// The loopback HTTP surface the MCP server talks to. Two routes, one JSON envelope:
///
///   GET  /health → { ok, result: { bridge, revit } }
///   POST /op     → { op, args } → { ok: true, result } | { ok: false, error: { code, message } }
///
/// Deliberate limits, because this port is a way into a live model:
/// <list type="bullet">
/// <item>Prefix <c>http://127.0.0.1:{port}/</c> only. Nothing off this machine can reach it, whatever the
/// firewall says.</item>
/// <item>A bearer token (generated on first run, written to <c>~/.revit-mcp/token</c>, read by the server
/// from the same path) is required for every route once one exists.</item>
/// <item>Writes are refused unless the operator allowed them: <c>parameter.set</c> is rejected with
/// <c>writes_disabled</c> before any Revit work happens, so the refusal is never half-applied.</item>
/// <item>One call at a time goes to Revit's thread; a slow call does not queue up a backlog of writes.</item>
/// </list>
/// The contract itself — every op, argument and result — is docs/protocol.md.
/// </summary>
public sealed class BridgeServer : IDisposable
{
    /// <summary>How long a read may take before the client is told Revit is busy. Writes get twice this: a transaction can wait on a workset checkout.</summary>
    public static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan WriteTimeout = TimeSpan.FromSeconds(60);

    private const int MaxBodyBytes = 1 * 1024 * 1024;

    private readonly McpSettings _settings;
    private readonly IRevitDispatcher _dispatcher;
    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _stop = new();

    public BridgeServer(McpSettings settings, IRevitDispatcher dispatcher)
    {
        _settings = settings;
        _dispatcher = dispatcher;
    }

    public bool IsRunning => _listener.IsListening;
    public string Endpoint => _settings.Endpoint;
    public McpSettings Settings => _settings;

    /// <summary>Requests Revit has run, and requests still waiting for its thread — what the ribbon's status dialog shows.</summary>
    public long CompletedCount => _dispatcher.Completed;
    public long QueuedCount => _dispatcher.Queued;

    public void Start()
    {
        _listener.Prefixes.Clear();
        _listener.Prefixes.Add(_settings.Endpoint);
        _listener.Start();
        _ = Task.Run(AcceptLoopAsync);
        McpSettings.Log($"bridge listening on {_settings.Endpoint} (writes {( _settings.AllowWrites ? "ALLOWED" : "off")})");
    }

    public void Stop()
    {
        _stop.Cancel();
        try { _listener.Stop(); } catch { /* already gone */ }
        McpSettings.Log("bridge stopped");
    }

    private async Task AcceptLoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception) when (_stop.IsCancellationRequested || !_listener.IsListening)
            {
                return;   // Stop() is not an error
            }
            catch (Exception ex)
            {
                McpSettings.Log($"accept failed: {ex.Message}");
                continue;
            }
            _ = Task.Run(() => HandleAsync(context));
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        var request = context.Request;
        try
        {
            if (!Authorised(request))
            {
                await WriteAsync(context, 401, new { ok = false, error = new { code = "unauthorized", message = $"Send the token from {McpSettings.TokenPath} as 'Authorization: Bearer <token>'." } });
                return;
            }

            if (request.HttpMethod == "GET" && request.Url?.AbsolutePath == "/health")
            {
                var health = await OnRevitThread(app => RevitOps.Status(app, _settings), ReadTimeout, _stop.Token);
                await WriteAsync(context, 200, new { ok = true, result = health });
                return;
            }

            if (request.HttpMethod == "POST" && request.Url?.AbsolutePath == "/op")
            {
                await HandleOpAsync(context);
                return;
            }

            await WriteAsync(context, 404, new { ok = false, error = new { code = "not_found", message = "Use GET /health or POST /op." } });
        }
        catch (Exception ex)
        {
            McpSettings.Log($"request failed: {ex}");
            await WriteAsync(context, 500, new { ok = false, error = new { code = "bridge_error", message = ex.Message } });
        }
    }

    private async Task HandleOpAsync(HttpListenerContext context)
    {
        if (context.Request.ContentLength64 > MaxBodyBytes)
        {
            await WriteAsync(context, 400, new { ok = false, error = new { code = "too_large", message = "The request body is over 1 MB; this bridge takes arguments, not uploads." } });
            return;
        }

        string body;
        using (var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8))
            body = await reader.ReadToEndAsync();

        string op;
        JsonElement args;
        try
        {
            using var parsed = JsonDocument.Parse(body);
            op = parsed.RootElement.TryGetProperty("op", out var opElement) ? opElement.GetString() ?? string.Empty : string.Empty;
            args = parsed.RootElement.TryGetProperty("args", out var argsElement) ? argsElement.Clone() : default;
        }
        catch (JsonException ex)
        {
            await WriteAsync(context, 400, new { ok = false, error = new { code = "bad_json", message = ex.Message } });
            return;
        }

        if (string.IsNullOrWhiteSpace(op))
        {
            await WriteAsync(context, 400, new { ok = false, error = new { code = "bad_request", message = "'op' is required." } });
            return;
        }

        // The write gate, before any Revit work: a refusal must never leave half a change behind.
        if (RevitOps.IsWrite(op) && !_settings.AllowWrites)
        {
            await WriteAsync(context, 200, new { ok = false, error = new { code = "writes_disabled", message = $"'{op}' changes the model and this add-in is read-only. Set allowWrites in %APPDATA%\\revit-mcp\\settings.json (or REVIT_MCP_ALLOW_WRITES=1) and restart Revit." } });
            return;
        }

        try
        {
            var timeout = RevitOps.IsWrite(op) ? WriteTimeout : ReadTimeout;
            var result = await OnRevitThread(app => RevitOps.Run(app, _settings, op, args), timeout, _stop.Token);
            await WriteAsync(context, 200, new { ok = true, result });
        }
        catch (RevitOpException ex)
        {
            await WriteAsync(context, 200, new { ok = false, error = new { code = ex.Code, message = ex.Message } });
        }
        catch (TimeoutException ex)
        {
            await WriteAsync(context, 200, new { ok = false, error = new { code = "timeout", message = ex.Message } });
        }
        catch (Exception ex)
        {
            McpSettings.Log($"op {op} failed: {ex}");
            await WriteAsync(context, 200, new { ok = false, error = new { code = "revit_error", message = ex.Message } });
        }
    }

    /// <summary>One place where the HTTP world crosses into Revit's thread, so the marshal is auditable in one read.</summary>
    private Task<object> OnRevitThread(Func<UIApplication, object> work, TimeSpan timeout, CancellationToken token) =>
        _dispatcher.InvokeAsync(work, timeout, token);

    private bool Authorised(HttpListenerRequest request)
    {
        if (string.IsNullOrEmpty(_settings.Token)) return true;   // an operator who removed the token means it
        var header = request.Headers["Authorization"];
        return header is not null
               && header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
               && CryptographicEquals(header.Substring(7).Trim(), _settings.Token);
    }

    /// <summary>Compare without an early exit, so a wrong token cannot be narrowed down a character at a time.</summary>
    private static bool CryptographicEquals(string a, string b) => Compat.FixedTimeEquals(a, b);

    private static async Task WriteAsync(HttpListenerContext context, int status, object payload)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length);
        context.Response.Close();
    }

    public void Dispose()
    {
        Stop();
        _stop.Dispose();
        ((IDisposable)_listener).Dispose();
    }
}
