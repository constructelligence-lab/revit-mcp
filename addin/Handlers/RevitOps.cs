using System.Globalization;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMcp.Handlers;

/// <summary>An error with a code the MCP server and the client can branch on (<c>not_found</c>, <c>writes_disabled</c>, …).</summary>
public sealed class RevitOpException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// Every op in docs/protocol.md, implemented against the Revit API. One entry point
/// (<see cref="Run"/>) so the bridge has exactly one place where a string from the network becomes a Revit
/// call, and read ops are separate from the one write op so the write gate is obvious.
/// </summary>
public static partial class RevitOps
{
    /// <summary>The ops that change the model. Kept as a list in one place: the bridge refuses these before dispatch when writes are off.</summary>
    private static readonly HashSet<string> Writes = new(StringComparer.Ordinal) { "parameter.set" };

    public static bool IsWrite(string op) => Writes.Contains(op);

    public static object Run(UIApplication app, McpSettings settings, string op, JsonElement args) => op switch
    {
        "status" => Status(app, settings),
        "model.overview" => Overview(app, args),
        "levels.list" => Levels(app),
        "categories.list" => Categories(app, args),
        "elements.query" => QueryElements(app, args),
        "element.details" => ElementDetails(app, args),
        "views.list" => Views(app, args),
        "sheets.list" => Sheets(app, args),
        "families.list" => Families(app, args),
        "warnings.list" => Warnings(app, args),
        "schedules.list" => Schedules(app),
        "schedule.read" => ReadSchedule(app, args),
        "selection.get" => Selection(app),
        "view.export_image" => ExportViewImage(app, args),
        "scene.info" => SceneInfo(app, args),
        "scene.render" => RenderScene(app, args),
        "parameter.set" => SetParameter(app, args),
        _ => throw new RevitOpException("unknown_op", $"Unknown operation '{op}'. See docs/protocol.md."),
    };

    // ── Shared plumbing ────────────────────────────────────────────────────────────────────────────────

    private static Document Document(UIApplication app) =>
        app.ActiveUIDocument?.Document
        ?? throw new RevitOpException("no_document", "No document is open in Revit. Open a model (or a family) and try again.");

    private static string? Text(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.String
            ? value.GetString()
            : null;

    private static string Required(JsonElement args, string name) =>
        Text(args, name) is { Length: > 0 } value ? value : throw new RevitOpException("bad_request", $"'{name}' is required.");

    private static bool Flag(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True;

    private static int Number(JsonElement args, string name, int fallback, int min, int max)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number)
            return fallback;
        return Compat.Clamp(value.GetInt32(), min, max);
    }

    private static long ElementIdArg(JsonElement args, string name)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number)
            throw new RevitOpException("bad_request", $"'{name}' must be a numeric Revit element id.");
        return value.GetInt64();
    }

    private static Element Find(Document doc, long id) =>
        doc.GetElement(new ElementId(id)) ?? throw new RevitOpException("not_found", $"No element with id {id} in '{doc.Title}'. query_elements returns the ids that exist.");

    /// <summary>A parameter's value as a person reads it: Revit's own display string where it has one.</summary>
    private static string? DisplayValue(Parameter parameter)
    {
        if (!parameter.HasValue) return null;
        try
        {
            var asString = parameter.AsValueString();
            if (!string.IsNullOrEmpty(asString)) return asString;
        }
        catch
        {
            // Some parameters throw on AsValueString; fall through to the typed value.
        }
        return parameter.StorageType switch
        {
            StorageType.String => parameter.AsString(),
            StorageType.Integer => parameter.AsInteger().ToString(CultureInfo.InvariantCulture),
            StorageType.Double => parameter.AsDouble().ToString("0.####", CultureInfo.InvariantCulture),
            StorageType.ElementId => parameter.AsElementId()?.Value.ToString(CultureInfo.InvariantCulture),
            _ => null,
        };
    }

    /// <summary>The instance parameters that carry a value or a name, keyed by name. Revit's own order, not a sorted one.</summary>
    private static Dictionary<string, string?> InstanceParameters(Element element)
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var parameter in element.Parameters.Cast<Parameter>())
        {
            var name = parameter.Definition?.Name;
            if (string.IsNullOrEmpty(name)) continue;
            if (!values.ContainsKey(name)) values[name] = DisplayValue(parameter);
        }
        return values;
    }

    private static string? LevelName(Document doc, Element element)
    {
        var id = element.LevelId;
        if (id == ElementId.InvalidElementId)
            id = element.get_Parameter(BuiltInParameter.LEVEL_PARAM)?.AsElementId() ?? ElementId.InvalidElementId;
        return id != ElementId.InvalidElementId ? doc.GetElement(id)?.Name : null;
    }

    private static string? WorksetName(Document doc, Element element)
    {
        if (!doc.IsWorkshared) return null;
        try { return doc.GetWorksetTable().GetWorkset(element.WorksetId)?.Name; }
        catch { return null; }
    }

    /// <summary>Length in the document's own units, so a client never has to know about Revit's internal feet.</summary>
    private static double? Length(Document doc, double internalFeet)
    {
        try { return Math.Round(UnitUtils.ConvertFromInternalUnits(internalFeet, doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId()), 2); }
        catch { return Math.Round(internalFeet, 4); }
    }

    private static object? BoundingBox(Document doc, Element element)
    {
        var box = element.get_BoundingBox(null);
        if (box is null) return null;
        return new
        {
            min = new[] { Length(doc, box.Min.X), Length(doc, box.Min.Y), Length(doc, box.Min.Z) },
            max = new[] { Length(doc, box.Max.X), Length(doc, box.Max.Y), Length(doc, box.Max.Z) },
        };
    }

    private static object Row(Document doc, Element element) => new
    {
        id = element.Id.Value,
        category = element.Category?.Name,
        family = element is FamilyInstance instance ? instance.Symbol?.Family?.Name : null,
        type = element.Name,
        level = LevelName(doc, element),
        mark = element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString(),
    };
}
