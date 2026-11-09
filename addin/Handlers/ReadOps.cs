using System.Globalization;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMcp.Handlers;

/// <summary>
/// The read ops: Revit's own data, read live from the document the user has open, with no interpretation
/// added. Counts are counts, names are names, and anything this cannot answer says so rather than guessing
/// (see the <c>scanned</c> and <c>truncated</c> notes on a query over a large model).
/// </summary>
public static partial class RevitOps
{
    /// <summary>What the bridge and Revit are, which document is open, and whether writes will be accepted.</summary>
    public static object Status(UIApplication app, McpSettings settings)
    {
        var doc = app.ActiveUIDocument?.Document;
        return new
        {
            bridge = new
            {
                version = typeof(RevitOps).Assembly.GetName().Version?.ToString(3) ?? "0.2.0",
                pid = Compat.ProcessId,
                writesAllowed = settings.AllowWrites,
                port = settings.Port,
                mock = false,
            },
            revit = doc is null ? null : new
            {
                version = app.Application.VersionNumber,
                document = doc.Title,
                path = doc.PathName,
                units = doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId().TypeId,
                workshared = doc.IsWorkshared,
                activeView = doc.ActiveView?.Name,
                modified = doc.IsModified,
            },
            levels = doc is null ? 0 : new FilteredElementCollector(doc).OfClass(typeof(Level)).GetElementCount(),
        };
    }

    public static object Overview(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var categoryLimit = Number(args, "category_limit", 20, 1, 100);

        var categories = doc.Settings.Categories.Cast<Category>()
            .Where(c => c.CategoryType == CategoryType.Model && c.Parent is null)
            .Select(c => new { name = c.Name, instances = new FilteredElementCollector(doc).OfCategoryId(c.Id).WhereElementIsNotElementType().GetElementCount() })
            .Where(c => c.instances > 0)
            .OrderByDescending(c => c.instances)
            .ToList();

        return new
        {
            document = doc.Title,
            path = doc.PathName,
            revit_version = app.Application.VersionNumber,
            workshared = doc.IsWorkshared,
            levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).GetElementCount(),
            views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Count(v => !v.IsTemplate),
            sheets = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).GetElementCount(),
            schedules = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).GetElementCount(),
            families = new FilteredElementCollector(doc).OfClass(typeof(Family)).GetElementCount(),
            warnings = doc.GetWarnings().Count,
            elements = new FilteredElementCollector(doc).WhereElementIsNotElementType().GetElementCount(),
            categories = categories.Take(categoryLimit),
            categories_total = categories.Count,
            note = "Counts are a live scan of this document, not a saved report; a large model can take a moment.",
        };
    }

    public static object Levels(UIApplication app)
    {
        var doc = Document(app);
        var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
            .OrderBy(l => l.Elevation)
            .Select(l => new
            {
                id = l.Id.Value,
                name = l.Name,
                elevation = Length(doc, l.Elevation),
                elements = new FilteredElementCollector(doc).WhereElementIsNotElementType().WherePasses(new ElementLevelFilter(l.Id)).GetElementCount(),
            });
        return new { levels, units = doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId().TypeId };
    }

    public static object Categories(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var limit = Number(args, "limit", 50, 1, 500);
        var rows = doc.Settings.Categories.Cast<Category>()
            .Where(c => c.CategoryType == CategoryType.Model && c.Parent is null)
            .Select(c => new { name = c.Name, instances = new FilteredElementCollector(doc).OfCategoryId(c.Id).WhereElementIsNotElementType().GetElementCount(), id = c.Id.Value })
            .Where(c => c.instances > 0)
            .OrderByDescending(c => c.instances);
        return new { categories = rows.Take(limit), note = "Model categories with at least one instance. Use the name with query_elements." };
    }

    public static object QueryElements(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var categoryName = Required(args, "category");
        var category = doc.Settings.Categories.Cast<Category>()
            .FirstOrDefault(c => string.Equals(c.Name, categoryName, StringComparison.OrdinalIgnoreCase))
            ?? throw new RevitOpException("unknown_category", $"'{categoryName}' is not a category in this document. categories.list shows the names it has.");

        var limit = Number(args, "limit", 50, 1, 500);
        var offset = Number(args, "offset", 0, 0, 1_000_000);
        var level = Text(args, "level");
        var family = Text(args, "family");
        var type = Text(args, "type");
        var parameter = Text(args, "parameter");
        var value = Text(args, "value") ?? string.Empty;

        var collector = new FilteredElementCollector(doc).OfCategoryId(category.Id).WhereElementIsNotElementType();
        if (level is { Length: > 0 })
        {
            var levelElement = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
                .FirstOrDefault(l => string.Equals(l.Name, level, StringComparison.OrdinalIgnoreCase))
                ?? throw new RevitOpException("not_found", $"No level named '{level}'. list_levels shows the levels in this document.");
            collector = collector.WherePasses(new ElementLevelFilter(levelElement.Id));
        }

        // Family/type/parameter matching happens in memory after the category (and level) narrowing, so a
        // query never walks the whole model. The cap is reported, not hidden.
        const int scanCap = 20_000;
        var scanned = 0;
        var matches = new List<Element>();
        foreach (var element in collector)
        {
            if (++scanned > scanCap) break;
            if (family is { Length: > 0 } && element is FamilyInstance instance
                && !string.Equals(instance.Symbol?.Family?.Name, family, StringComparison.OrdinalIgnoreCase)) continue;
            if (type is { Length: > 0 } && !string.Equals(element.Name, type, StringComparison.OrdinalIgnoreCase)) continue;
            if (parameter is { Length: > 0 })
            {
                var parameterValue = element.Parameters.Cast<Parameter>()
                    .FirstOrDefault(p => string.Equals(p.Definition?.Name, parameter, StringComparison.OrdinalIgnoreCase));
                if (parameterValue is null || !Compat.Contains(DisplayValue(parameterValue) ?? string.Empty, value)) continue;
            }
            matches.Add(element);
        }

        return new
        {
            category = categoryName,
            total_matched = matches.Count,
            offset,
            scanned,
            truncated = scanned > scanCap,
            rows = matches.Skip(offset).Take(limit).Select(e => Row(doc, e)),
        };
    }

    public static object ElementDetails(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var element = Find(doc, ElementIdArg(args, "element_id"));
        var typeElement = doc.GetElement(element.GetTypeId());

        return new
        {
            element = new
            {
                id = element.Id.Value,
                category = element.Category?.Name,
                name = element.Name,
                family = element is FamilyInstance instance ? instance.Symbol?.Family?.Name : null,
                type = typeElement?.Name,
                level = LevelName(doc, element),
                workset = WorksetName(doc, element),
                design_option = doc.GetElement(element.DesignOption?.Id)?.Name,
                host = element is FamilyInstance { Host: { } host } ? new { id = host.Id.Value, category = host.Category?.Name } : null,
                parameters = InstanceParameters(element),
                type_parameters = typeElement is null ? null : InstanceParameters(typeElement),
                bounding_box = BoundingBox(doc, element),
            },
        };
    }

    public static object Views(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var limit = Number(args, "limit", 50, 1, 500);
        var typeFilter = Text(args, "type");

        var onSheet = new Dictionary<long, string>();
        foreach (var sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
            foreach (var viewId in sheet.GetAllPlacedViews())
                onSheet[viewId.Value] = sheet.SheetNumber;

        var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
            .Where(v => !v.IsTemplate)
            .Where(v => typeFilter is not { Length: > 0 } || string.Equals(v.ViewType.ToString(), typeFilter, StringComparison.OrdinalIgnoreCase))
            .Select(v => new
            {
                id = v.Id.Value,
                name = v.Name,
                type = v.ViewType.ToString(),
                level = (v as ViewPlan)?.GenLevel?.Name,
                sheet = onSheet.TryGetValue(v.Id.Value, out var number) ? number : null,
            })
            .ToList();

        return new { total = views.Count, views = views.Take(limit) };
    }

    public static object Sheets(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var limit = Number(args, "limit", 50, 1, 500);
        var sheets = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
            .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
            .Select(s => new
            {
                id = s.Id.Value,
                number = s.SheetNumber,
                name = s.Name,
                views = s.GetAllPlacedViews().Select(id => doc.GetElement(id)?.Name).Where(n => n is not null),
                revision = s.get_Parameter(BuiltInParameter.SHEET_CURRENT_REVISION)?.AsString(),
            })
            .ToList();
        return new { total = sheets.Count, sheets = sheets.Take(limit) };
    }

    public static object Families(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var limit = Number(args, "limit", 50, 1, 500);

        // One pass over the instances, not one pass per family.
        var instances = new Dictionary<long, int>();
        foreach (var instance in new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
        {
            var familyId = instance.Symbol?.Family?.Id.Value ?? 0;
            instances.TryGetValue(familyId, out var count);
            instances[familyId] = count + 1;
        }

        var families = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
            .Select(f => new
            {
                id = f.Id.Value,
                name = f.Name,
                types = f.GetFamilySymbolIds().Count,
                instances = instances.TryGetValue(f.Id.Value, out var placed) ? placed : 0,
            })
            .OrderByDescending(f => f.instances)
            .ToList();
        return new { total = families.Count, families = families.Take(limit) };
    }

    public static object Warnings(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var limit = Number(args, "limit", 50, 1, 500);
        var warnings = doc.GetWarnings().Cast<FailureMessage>()
            .Select(w => new
            {
                severity = w.GetSeverity().ToString(),
                description = w.GetDescriptionText(),
                element_ids = w.GetFailingElements().Select(id => id.Value),
            })
            .ToList();
        return new
        {
            total = warnings.Count,
            warnings = warnings.Take(limit),
            note = "Revit's own warnings, read live. A warning is a prompt to look at the model, not a finding about the building.",
        };
    }

    public static object Schedules(UIApplication app)
    {
        var doc = Document(app);
        var schedules = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
            .Where(s => !s.IsTemplate)
            .Select(s => new { id = s.Id.Value, name = s.Name, rows = BodyRows(s), columns = BodyColumns(s) })
            .ToList();
        return new { schedules };
    }

    public static object ReadSchedule(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var name = Required(args, "schedule");
        var limit = Number(args, "limit", 50, 1, 500);
        var schedule = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
            .FirstOrDefault(s => string.Equals(s.Name, name, StringComparison.OrdinalIgnoreCase) && !s.IsTemplate)
            ?? throw new RevitOpException("not_found", $"No schedule named '{name}'. list_schedules shows the schedules in this document.");

        var table = schedule.GetTableData();
        var body = table.GetSectionData(SectionType.Body);
        var headers = new List<string>();
        // Header rows are the rows before the body starts (FirstRowNumber); the column titles live there.
        for (var column = 0; column < body.NumberOfColumns; column++)
        {
            var title = string.Empty;
            for (var row = 0; row < body.FirstRowNumber && title.Length == 0; row++)
                title = body.GetCellText(row, column);
            headers.Add(title);
        }

        var rows = new List<string[]>();
        for (var row = body.FirstRowNumber; row <= body.LastRowNumber && rows.Count < limit; row++)
        {
            var values = new string[body.NumberOfColumns];
            for (var column = 0; column < body.NumberOfColumns; column++) values[column] = body.GetCellText(row, column);
            rows.Add(values);
        }

        return new
        {
            name = schedule.Name,
            columns = headers,
            rows,
            body_rows = body.NumberOfRows,
            truncated = rows.Count < body.NumberOfRows,
            note = "Revit computes these rows, including its totals rows where the schedule has them.",
        };
    }

    public static object Selection(UIApplication app)
    {
        var uiDoc = app.ActiveUIDocument ?? throw new RevitOpException("no_document", "No document is open in Revit.");
        var doc = uiDoc.Document;
        var ids = uiDoc.Selection.GetElementIds();
        return new
        {
            document = doc.Title,
            count = ids.Count,
            elements = ids.Select(id => doc.GetElement(id)).Where(e => e is not null).Select(e => Row(doc, e!)),
        };
    }

    public static object ExportViewImage(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var viewName = Text(args, "view");
        var width = Number(args, "width", 1600, 200, 4000);

        var view = viewName is { Length: > 0 }
            ? new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
                .FirstOrDefault(v => string.Equals(v.Name, viewName, StringComparison.OrdinalIgnoreCase) && !v.IsTemplate)
                ?? throw new RevitOpException("not_found", $"No view named '{viewName}'. list_views shows the views in this document.")
            : doc.ActiveView;

        var folder = Path.Combine(Path.GetTempPath(), "revit-mcp");
        System.IO.Directory.CreateDirectory(folder);
        var before = new HashSet<string>(Directory.GetFiles(folder, "*.png"), StringComparer.OrdinalIgnoreCase);

        // A specific view needs ExportRange.SetOfViews; Revit names the file itself (ImageExportOptions.GetFileName
        // is the API for that), so the answer is "the file Revit actually wrote", not a guess at a path.
        var options = new ImageExportOptions
        {
            FilePath = Path.Combine(folder, Sanitise(view.Name)),
            HLRandWFViewsFileType = ImageFileType.PNG,
            ShadowViewsFileType = ImageFileType.PNG,
            ZoomType = ZoomFitType.FitToPage,
            PixelSize = width,
            ExportRange = ExportRange.SetOfViews,
        };
        options.SetViewsAndSheets(new List<ElementId> { view.Id });
        doc.ExportImage(options);

        var produced = Directory.GetFiles(folder, "*.png")
            .Where(file => !before.Contains(file))
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();

        return new
        {
            view = view.Name,
            view_type = view.ViewType.ToString(),
            path = produced,
            width,
            exists = produced is not null,
            note = "Written on the machine running Revit, in %TEMP%\\revit-mcp. An MCP client on another machine cannot read this path — the bridge and the client are meant to be the same workstation.",
        };
    }

    private static string Sanitise(string name)
    {
        foreach (var invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '-');
        return name;
    }

    private static int BodyRows(ViewSchedule schedule)
    {
        try { return schedule.GetTableData().GetSectionData(SectionType.Body).NumberOfRows; }
        catch { return 0; }
    }

    private static int BodyColumns(ViewSchedule schedule)
    {
        try { return schedule.GetTableData().GetSectionData(SectionType.Body).NumberOfColumns; }
        catch { return 0; }
    }
}
