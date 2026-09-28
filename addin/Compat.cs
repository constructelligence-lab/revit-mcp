using System.Diagnostics;

namespace RevitMcp;

/// <summary>
/// The handful of helpers that .NET Framework 4.8 (Revit 2024 and older) does not ship: <c>Math.Clamp</c>,
/// <c>Task.WaitAsync</c>, <c>Convert.ToHexString</c>, <c>Environment.ProcessId</c>,
/// <c>CryptographicOperations.FixedTimeEquals</c> and the <c>string.Contains(string, StringComparison)</c>
/// overload. Everything the add-in shares with the server targets the older surface, so there is one code
/// path rather than two that drift.
/// </summary>
internal static class Compat
{
    public static int Clamp(int value, int min, int max) => value < min ? min : value > max ? max : value;

    public static double Clamp(double value, double min, double max) => value < min ? min : value > max ? max : value;

    public static string ToHex(byte[] bytes) => string.Concat(bytes.Select(b => b.ToString("x2")));

    public static int ProcessId => Process.GetCurrentProcess().Id;

    /// <summary>Case-insensitive substring test that exists on both frameworks.</summary>
    public static bool Contains(string text, string value) => text.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0;

    /// <summary>
    /// Wait for a task, or give up after <paramref name="timeout"/>. This is what <c>Task.WaitAsync</c> does on
    /// .NET 6+, written out so Revit 2024's framework has it too. The task is left running (it is Revit's work,
    /// and it will finish on Revit's thread); the caller decides what to do about an answer that came late.
    /// </summary>
    public static async Task<T> WaitAsync<T>(Task<T> task, TimeSpan timeout, CancellationToken token)
    {
        using var delay = CancellationTokenSource.CreateLinkedTokenSource(token);
        var expiry = Task.Delay(timeout, delay.Token);
        var finished = await Task.WhenAny(task, expiry).ConfigureAwait(false);
        if (finished == task)
        {
            delay.Cancel();      // stop the timer, do not leave it ticking
            return await task.ConfigureAwait(false);
        }
        throw new TimeoutException($"Revit did not answer within {timeout.TotalSeconds:0} s.");
    }

    /// <summary>
    /// Compare two secrets without an early exit, so a wrong token cannot be narrowed down a character at a
    /// time by watching how long the comparison takes. Written out because .NET Framework 4.8 has no
    /// <c>CryptographicOperations.FixedTimeEquals</c>.
    /// </summary>
    public static bool FixedTimeEquals(string a, string b)
    {
        var left = System.Text.Encoding.UTF8.GetBytes(a);
        var right = System.Text.Encoding.UTF8.GetBytes(b);
        var difference = left.Length ^ right.Length;
        for (var i = 0; i < left.Length; i++)
            difference |= left[i] ^ right[i % Math.Max(1, right.Length)];
        return difference == 0;
    }
}
