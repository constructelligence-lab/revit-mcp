using System.Collections.Concurrent;
using Autodesk.Revit.UI;

namespace RevitMcp.Bridge;

/// <summary>Marshal work onto Revit's thread. The HTTP loop runs on a thread pool thread; the document does not.</summary>
public interface IRevitDispatcher
{
    Task<T> InvokeAsync<T>(Func<UIApplication, T> work, TimeSpan timeout, CancellationToken token = default);

    long Queued { get; }
    long Completed { get; }
}

/// <summary>
/// Revit's API is single-threaded: everything that touches a document must run on Revit's own thread, and
/// that thread is busy drawing the model. This owns an <see cref="ExternalEvent"/> and a queue; a request
/// posts a closure, Revit fires the event when it is idle, the closure runs, and the waiting HTTP thread
/// gets the answer.
///
/// The timeout is a real limit on patience, not on work. If Revit has a modal dialog open the closure has
/// not run yet; when the dialog closes it *will* run. So a request that timed out is marked abandoned and
/// skipped when its turn comes — otherwise a write whose answer was already reported as "did not happen"
/// could quietly happen a minute later, which is the one failure mode that must not exist here.
/// </summary>
public sealed class RevitDispatcher : IExternalEventHandler, IRevitDispatcher
{
    private readonly ConcurrentQueue<Work> _queue = new();
    private readonly ExternalEvent _event;
    private long _queued;
    private long _completed;

    public RevitDispatcher() => _event = ExternalEvent.Create(this);

    public long Queued => Interlocked.Read(ref _queued);
    public long Completed => Interlocked.Read(ref _completed);

    public async Task<T> InvokeAsync<T>(Func<UIApplication, T> work, TimeSpan timeout, CancellationToken token = default)
    {
        var item = new Work(app => work(app)!);
        _queue.Enqueue(item);
        Interlocked.Increment(ref _queued);
        _event.Raise();

        try
        {
            var result = await item.Completion.Task.WaitAsync(timeout, token).ConfigureAwait(false);
            Interlocked.Increment(ref _completed);
            return (T)result;
        }
        catch (TimeoutException)
        {
            item.Abandon("timed out before Revit ran it (a modal dialog or a long command had the UI thread)");
            throw new TimeoutException("Revit did not run the request in time — a modal dialog or a long-running command blocks its UI thread. Close it and try again.");
        }
        catch (OperationCanceledException)
        {
            item.Abandon("the client went away before Revit ran it");
            throw;
        }
    }

    /// <summary>Revit's thread: run everything queued, in order, and never let one item stop the next.</summary>
    public void Execute(UIApplication app)
    {
        while (_queue.TryDequeue(out var item))
        {
            if (item.IsAbandoned)
            {
                McpSettings.Log("skipped an abandoned request (its client already had a timeout)");
                continue;
            }
            item.Run(app);
        }
    }

    public string GetName() => "revit-mcp bridge";

    private sealed class Work(Func<UIApplication, object> run)
    {
        private volatile bool _abandoned;

        public TaskCompletionSource<object> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool IsAbandoned => _abandoned;

        public void Abandon(string why)
        {
            _abandoned = true;
            McpSettings.Log($"abandoned request: {why}");
        }

        public void Run(UIApplication app)
        {
            try
            {
                Completion.TrySetResult(run(app));
            }
            catch (Exception ex)
            {
                McpSettings.Log($"request failed on Revit's thread: {ex}");
                Completion.TrySetException(ex);
            }
        }
    }
}
