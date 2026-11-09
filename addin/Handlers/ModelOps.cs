using System.Globalization;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;

namespace RevitMcp.Handlers;

/// <summary>
/// More of the model, read-only: rooms with boundaries, project structure (grids, links, phases, design
/// options, worksets, revisions), materials, wall layers, geometric quantities and clash checks. Nothing here
/// opens a transaction. Quantities are Revit's own computed area/volume parameters, converted to SI, never
/// recomputed from geometry here, so they match what the model's schedules say.
/// </summary>
public static partial class RevitOps
{
    private const double SquareFeetPerSquareMetre = FeetPerMetre * FeetPerMetre;
    private const double CubicFeetPerCubicMetre = FeetPerMetre * FeetPerMetre * FeetPerMetre;

    // ── rooms ──────────────────────────────────────────────────────────────────────────────────────────

    public static object Rooms(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var level = Text(args, "level");
        var limit = Number(args, "limit", 50, 1, 500);
        var boundaries = Flag(args, "boundaries");
        var rows = new List<object>();
        var total = 0;
        double area = 0;

        foreach (var element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType())
        {
            if (element is not Room room || room.Area <= 0) continue;
            var levelName = LevelName(doc, room);
            if (level is { Length: > 0 } && !string.Equals(levelName, level, StringComparison.OrdinalIgnoreCase)) continue;
            total++;
            area += room.Area;
            if (rows.Count >= limit) continue;

            object? loops = null;
            if (boundaries)
            {
                var list = new List<object>();
                try
                {
                    foreach (var loop in room.GetBoundarySegments(new SpatialElementBoundaryOptions()) ?? new List<IList<BoundarySegment>>())
                        list.Add(loop.Select(segment => segment.GetCurve()).Select(curve => new { from = Point(doc, curve.GetEndPoint(0)), to = Point(doc, curve.GetEndPoint(1)) }).ToList());
                }
                catch { /* an unenclosed room has no boundary; report it as none */ }
                loops = list;
            }

            rows.Add(new
            {
                id = room.Id.Value,
                number = room.Number,
                name = room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(),
                level = levelName,
                department = room.get_Parameter(BuiltInParameter.ROOM_DEPARTMENT)?.AsString(),
                area_m2 = Math.Round(room.Area / SquareFeetPerSquareMetre, 2),
                perimeter = Length(doc, room.Perimeter),
                volume_m3 = room.Volume > 0 ? Math.Round(room.Volume / CubicFeetPerCubicMetre, 2) : (double?)null,
                boundaries = loops,
            });
        }

        return new { total, total_area_m2 = Math.Round(area / SquareFeetPerSquareMetre, 1), rows, truncated = total > rows.Count };
    }

    // ── project structure ──────────────────────────────────────────────────────────────────────────────

    public static object Structure(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var kind = (Required(args, "kind")).ToLowerInvariant();
        var limit = Number(args, "limit", 100, 1, 500);

        switch (kind)
        {
            case "grids":
                return new
                {
                    kind,
                    rows = new FilteredElementCollector(doc).OfClass(typeof(Grid)).Cast<Grid>().Take(limit).Select(grid => new
                    {
                        id = grid.Id.Value,
                        name = grid.Name,
                        curved = grid.IsCurved,
                        from = Point(doc, grid.Curve.GetEndPoint(0)),
                        to = Point(doc, grid.Curve.GetEndPoint(1)),
                    }).OrderBy(g => g.name, StringComparer.OrdinalIgnoreCase).ToList(),
                };

            case "links":
                var revit = new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>().Select(link =>
                {
                    var linked = link.GetLinkDocument();
                    return (object)new { id = link.Id.Value, type = "revit", name = link.Name, loaded = linked is not null, document = linked?.Title, origin = Point(doc, link.GetTotalTransform().Origin) };
                });
                var cad = new FilteredElementCollector(doc).OfClass(typeof(ImportInstance)).Cast<ImportInstance>().Select(import =>
                    (object)new { id = import.Id.Value, type = import.IsLinked ? "cad_link" : "cad_import", name = import.Name, view_specific = import.ViewSpecific });
                return new { kind, rows = revit.Concat(cad).Take(limit).ToList() };

            case "phases":
                return new { kind, rows = doc.Phases.Cast<Phase>().Select((phase, index) => new { id = phase.Id.Value, sequence = index + 1, name = phase.Name }).ToList() };

            case "design_options":
                return new
                {
                    kind,
                    rows = new FilteredElementCollector(doc).OfClass(typeof(DesignOption)).Cast<DesignOption>().Select(option => new { id = option.Id.Value, name = option.Name, primary = option.IsPrimary }).ToList(),
                };

            case "worksets":
                if (!doc.IsWorkshared) return new { kind, workshared = false, rows = new List<object>() };
                return new
                {
                    kind,
                    workshared = true,
                    rows = new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).Cast<Workset>().Select(workset => new
                    {
                        name = workset.Name,
                        owner = workset.Owner,
                        open = workset.IsOpen,
                        editable = workset.IsEditable,
                        visible_by_default = workset.IsVisibleByDefault,
                    }).ToList(),
                };

            case "revisions":
                return new
                {
                    kind,
                    rows = Revision.GetAllRevisionIds(doc).Select(id => doc.GetElement(id)).OfType<Revision>().Select(revision => new
                    {
                        id = revision.Id.Value,
                        sequence = revision.SequenceNumber,
                        number = revision.RevisionNumber,
                        date = revision.RevisionDate,
                        description = revision.Description,
                        issued = revision.Issued,
                        issued_by = revision.IssuedBy,
                        issued_to = revision.IssuedTo,
                    }).ToList(),
                };

            default:
                throw new RevitOpException("bad_request", $"Unknown kind '{kind}'. Use grids, links, phases, design_options, worksets or revisions.");
        }
    }

    // ── materials ──────────────────────────────────────────────────────────────────────────────────────

    public static object Materials(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var match = Text(args, "name");
        var limit = Number(args, "limit", 100, 1, 500);
        var rows = new List<object>();
        var total = 0;
        foreach (var material in new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().OrderBy(m => m.Name, StringComparer.OrdinalIgnoreCase))
        {
            if (match is { Length: > 0 } && material.Name.IndexOf(match, StringComparison.OrdinalIgnoreCase) < 0) continue;
            total++;
            if (rows.Count >= limit) continue;
            var colour = material.Color;
            rows.Add(new
            {
                id = material.Id.Value,
                name = material.Name,
                @class = material.MaterialClass,
                colour = colour is { IsValid: true } ? $"#{colour.Red:X2}{colour.Green:X2}{colour.Blue:X2}" : null,
                transparency = material.Transparency,
                shininess = material.Shininess,
                has_appearance = material.AppearanceAssetId != ElementId.InvalidElementId,
            });
        }
        return new { total, rows, truncated = total > rows.Count };
    }

    // ── wall layers ────────────────────────────────────────────────────────────────────────────────────

    public static object WallLayers(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var element = Find(doc, ElementIdArg(args, "element_id"));
        var type = element is Wall wall ? wall.WallType as ElementType : doc.GetElement(element.GetTypeId()) as ElementType;
        var structure = type switch
        {
            WallType wallType => wallType.GetCompoundStructure(),
            FloorType floorType => floorType.GetCompoundStructure(),
            RoofType roofType => roofType.GetCompoundStructure(),
            CeilingType ceilingType => ceilingType.GetCompoundStructure(),
            _ => null,
        };
        if (structure is null)
            throw new RevitOpException("not_found", $"Element {element.Id.Value} ({element.Category?.Name}) has no layered build-up. Walls, floors, roofs and ceilings do.");

        var layers = structure.GetLayers().Select((layer, index) => new
        {
            index = index + 1,
            function = layer.Function.ToString(),
            material = layer.MaterialId == ElementId.InvalidElementId ? null : doc.GetElement(layer.MaterialId)?.Name,
            thickness = Length(doc, layer.Width),
        }).ToList();

        return new
        {
            element_id = element.Id.Value,
            type = type?.Name,
            category = element.Category?.Name,
            total_thickness = Length(doc, structure.GetWidth()),
            layers,
            note = "Layers run exterior to interior for walls, top to bottom for floors and roofs. Thickness is in the document's length unit.",
        };
    }

    // ── geometric quantities ───────────────────────────────────────────────────────────────────────────

    public static object GeometryQuantities(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var category = BuiltIn(doc, Required(args, "category"));
        var level = Text(args, "level");
        var cap = 20000;
        var groups = new Dictionary<string, (int Count, double Area, double Volume, double Length)>(StringComparer.OrdinalIgnoreCase);
        var scanned = 0;

        foreach (var element in new FilteredElementCollector(doc).OfCategory(category).WhereElementIsNotElementType())
        {
            if (++scanned > cap) break;
            if (level is { Length: > 0 } && !string.Equals(LevelName(doc, element), level, StringComparison.OrdinalIgnoreCase)) continue;
            var key = element.Name is { Length: > 0 } name ? $"{(element is FamilyInstance fi ? fi.Symbol?.Family?.Name + ": " : "")}{name}" : "(unnamed)";
            double area = element.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED)?.AsDouble() ?? 0;
            double volume = element.get_Parameter(BuiltInParameter.HOST_VOLUME_COMPUTED)?.AsDouble() ?? 0;
            double length = element.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH)?.AsDouble() ?? 0;
            groups.TryGetValue(key, out var current);
            groups[key] = (current.Count + 1, current.Area + area, current.Volume + volume, current.Length + length);
        }

        var rows = groups.OrderByDescending(pair => pair.Value.Volume).ThenByDescending(pair => pair.Value.Count).Select(pair => new
        {
            type = pair.Key,
            count = pair.Value.Count,
            area_m2 = Math.Round(pair.Value.Area / SquareFeetPerSquareMetre, 2),
            volume_m3 = Math.Round(pair.Value.Volume / CubicFeetPerCubicMetre, 3),
            length = Length(doc, pair.Value.Length),
        }).ToList();

        return new
        {
            category = category.ToString().Replace("OST_", ""),
            level,
            scanned,
            truncated = scanned > cap,
            totals = new
            {
                count = rows.Sum(r => r.count),
                area_m2 = Math.Round(rows.Sum(r => r.area_m2), 2),
                volume_m3 = Math.Round(rows.Sum(r => r.volume_m3), 3),
            },
            rows,
            note = "Area and volume are Revit's own computed parameters (zero where Revit does not compute them for that category). Net of openings as Revit reports it; not a substitute for a take-off on a schedule.",
        };
    }

    // ── clash check ────────────────────────────────────────────────────────────────────────────────────

    public static object CheckClashes(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var a = BuiltIn(doc, Required(args, "category_a"));
        var b = BuiltIn(doc, Required(args, "category_b"));
        var limit = Number(args, "limit", 50, 1, 300);
        var level = Text(args, "level");
        var clashes = new List<object>();
        var checkedCount = 0;
        var total = 0;
        var started = DateTime.UtcNow;

        foreach (var first in new FilteredElementCollector(doc).OfCategory(a).WhereElementIsNotElementType())
        {
            if (level is { Length: > 0 } && !string.Equals(LevelName(doc, first), level, StringComparison.OrdinalIgnoreCase)) continue;
            if (++checkedCount > 3000 || DateTime.UtcNow - started > TimeSpan.FromSeconds(20)) break;
            if (first.get_BoundingBox(null) is null) continue;

            ICollection<ElementId> hits;
            try
            {
                hits = new FilteredElementCollector(doc).OfCategory(b).WhereElementIsNotElementType()
                    .WherePasses(new ElementIntersectsElementFilter(first)).ToElementIds();
            }
            catch { continue; }

            foreach (var id in hits)
            {
                if (id == first.Id) continue;
                total++;
                if (clashes.Count < limit)
                {
                    var second = doc.GetElement(id);
                    clashes.Add(new
                    {
                        a = new { id = first.Id.Value, name = first.Name, level = LevelName(doc, first) },
                        b = new { id = id.Value, name = second?.Name, level = second is null ? null : LevelName(doc, second) },
                    });
                }
            }
        }

        return new
        {
            category_a = a.ToString().Replace("OST_", ""),
            category_b = b.ToString().Replace("OST_", ""),
            elements_checked = Math.Min(checkedCount, 3000),
            clashes_found = total,
            clashes,
            truncated = total > clashes.Count || checkedCount > 3000,
            note = "Geometric intersection as Revit's ElementIntersectsElementFilter reports it, between two categories in this document only (not links). Intersecting is not the same as a defect: a door in a wall intersects it by design.",
        };
    }

    private static BuiltInCategory BuiltIn(Document doc, string name)
    {
        foreach (Category category in doc.Settings.Categories)
            if (string.Equals(category.Name, name, StringComparison.OrdinalIgnoreCase) && category.CategoryType == CategoryType.Model)
                return (BuiltInCategory)category.Id.Value;
        throw new RevitOpException("not_found", $"No model category called '{name}'. categories.list shows the ones this model uses.");
    }
}
