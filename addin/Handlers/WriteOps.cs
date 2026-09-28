using System.Globalization;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMcp.Handlers;

/// <summary>
/// The one write op. It is deliberately narrow, in this order of reasons: one element, one instance
/// parameter, previewed unless the caller asks for it, applied inside a single transaction, and never a type
/// parameter — changing a type in Revit silently changes every instance of it, which is not a change an
/// assistant should be able to make by accident. Everything this does not do (create, delete, move, save,
/// sync, change types) is a decision for a human in Revit, not for a client over a socket.
/// </summary>
public static partial class RevitOps
{
    public static object SetParameter(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var id = ElementIdArg(args, "element_id");
        var element = Find(doc, id);
        var name = Required(args, "parameter");
        var text = Text(args, "value") ?? throw new RevitOpException("bad_request", "'value' is required (an empty string is allowed, to clear a text parameter).");
        var apply = Flag(args, "apply");

        Parameter? parameter = null;
        foreach (Parameter candidate in element.Parameters)
        {
            if (string.Equals(candidate.Definition?.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                parameter = candidate;
                break;
            }
        }

        if (parameter is null)
        {
            var onType = doc.GetElement(element.GetTypeId()) is { } typeElement
                         && typeElement.Parameters.Cast<Parameter>().Any(p => string.Equals(p.Definition?.Name, name, StringComparison.OrdinalIgnoreCase));
            throw new RevitOpException("not_found", onType
                ? $"'{name}' is a type parameter on '{element.Name}'. Changing it would change every instance of that type, so this bridge does not: change it in Revit."
                : $"'{name}' is not an instance parameter on element {id}. It has: {string.Join(", ", InstanceParameters(element).Keys.Take(14))}.");
        }

        if (parameter.IsReadOnly)
            throw new RevitOpException("read_only_parameter", $"'{name}' is read-only in Revit (calculated, or controlled by the system), so it cannot be set.");

        var oldValue = DisplayValue(parameter);
        var storage = parameter.StorageType.ToString();

        if (!apply)
        {
            return new
            {
                element_id = id,
                element = element.Name,
                parameter = name,
                storage,
                old_value = oldValue,
                new_value = text,
                applied = false,
                note = "Preview only. Nothing changed — call again with apply: true to make this change.",
            };
        }

        using var transaction = new Transaction(doc, $"revit-mcp: {name} on {id}");
        transaction.Start();
        try
        {
            var accepted = parameter.StorageType switch
            {
                StorageType.String => parameter.Set(text),
                StorageType.Integer => parameter.Set(ParseWhole(name, text)),
                StorageType.Double => parameter.Set(ParseMeasured(doc, parameter, name, text)),
                StorageType.ElementId => SetElementId(doc, parameter, name, text),
                _ => throw new RevitOpException("unsupported_storage", $"{storage} parameters are not set by this bridge (v0.1 sets text, numbers and element references)."),
            };
            if (!accepted)
                throw new RevitOpException("revit_refused", $"Revit refused '{text}' for '{name}' — the parameter has rules (a list of allowed values, a range, or a formula). Set it in Revit to see why.");
            transaction.Commit();
        }
        catch
        {
            if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack();
            throw;
        }

        return new
        {
            element_id = id,
            element = element.Name,
            parameter = name,
            storage,
            old_value = oldValue,
            new_value = DisplayValue(parameter),
            applied = true,
            transaction = transaction.GetName(),
            note = "Applied in one Revit transaction. A single Ctrl+Z in Revit undoes it.",
        };
    }

    private static int ParseWhole(string name, string text) =>
        int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)
            ? value
            : throw new RevitOpException("bad_value", $"'{name}' takes a whole number; '{text}' is not one.");

    /// <summary>
    /// A length is given in the document's own unit (mm in a metric model) and converted to Revit's internal
    /// feet, because a client that asked for "3000" means the 3000 it can see in Revit, not 3000 feet.
    /// </summary>
    private static double ParseMeasured(Document doc, Parameter parameter, string name, string text)
    {
        if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
            throw new RevitOpException("bad_value", $"'{name}' takes a number; '{text}' is not one.");

        try
        {
            if (parameter.Definition?.GetDataType() == SpecTypeId.Length)
                return UnitUtils.ConvertToInternalUnits(value, doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId());
        }
        catch
        {
            // A parameter whose data type is unknown falls through as a raw number, which is what Revit stores.
        }
        return value;
    }

    private static bool SetElementId(Document doc, Parameter parameter, string name, string text)
    {
        if (!long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id))
            throw new RevitOpException("bad_value", $"'{name}' takes an element id (a number); '{text}' is not one. This bridge does not look elements up by name yet.");
        if (doc.GetElement(new ElementId(id)) is null)
            throw new RevitOpException("not_found", $"There is no element with id {id} in this document, so '{name}' cannot point at it.");
        return parameter.Set(new ElementId(id));
    }
}
