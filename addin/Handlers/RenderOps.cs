using System.Globalization;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMcp.Handlers;

/// <summary>
/// Pictures. <c>scene.info</c> is a plain read: where the building is, how big, where the rooms are, so a
/// client can place a camera on purpose. <c>scene.render</c> builds a throw-away 3D camera view, dresses it
/// (visual style, sun, hidden categories, section box), exports it to an image and then ROLLS BACK a
/// <see cref="TransactionGroup"/>: the view, the sun settings and every override vanish, nothing lands on
/// the undo stack and the model on disk is untouched. That is why it is not behind the write gate: the only
/// lasting effect is a file in %TEMP%. Camera maths (presets, framing) lives in the MCP server, so this file
/// only ever receives an explicit eye and target.
/// </summary>
public static partial class RevitOps
{
    private const double FeetPerMetre = 3.280839895013123;

    // ── scene.info ─────────────────────────────────────────────────────────────────────────────────────

    public static object SceneInfo(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var unitId = LengthUnit(doc);

        // The union of every model element's bounding box is "the building". Annotation and view-specific
        // elements are excluded by the model-category filter; the scan is capped so a huge model answers.
        XYZ? min = null, max = null;
        var scanned = 0;
        foreach (var element in new FilteredElementCollector(doc).WhereElementIsNotElementType())
        {
            if (element.Category is null || element.Category.CategoryType != CategoryType.Model) continue;
            if (element is RevitLinkInstance) continue;
            var box = element.get_BoundingBox(null);
            if (box is null) continue;
            if (++scanned > 60000) break;
            min = min is null ? box.Min : new XYZ(Math.Min(min.X, box.Min.X), Math.Min(min.Y, box.Min.Y), Math.Min(min.Z, box.Min.Z));
            max = max is null ? box.Max : new XYZ(Math.Max(max.X, box.Max.X), Math.Max(max.Y, box.Max.Y), Math.Max(max.Z, box.Max.Z));
        }

        double? northDegrees = null;
        object? site = null;
        try
        {
            var position = doc.ActiveProjectLocation?.GetProjectPosition(XYZ.Zero);
            if (position is not null) northDegrees = Math.Round(position.Angle * 180.0 / Math.PI, 2);
            var location = doc.SiteLocation;
            site = new
            {
                latitude = Math.Round(location.Latitude * 180.0 / Math.PI, 5),
                longitude = Math.Round(location.Longitude * 180.0 / Math.PI, 5),
                place = location.PlaceName,
            };
        }
        catch
        {
            // A model with no site location is fine: sun studies then need an explicit date and the user's own latitude.
        }

        var rooms = new List<object>();
        var roomLimit = Number(args, "room_limit", 40, 1, 200);
        foreach (var element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType())
        {
            if (element is not Autodesk.Revit.DB.Architecture.Room { Location: LocationPoint point } room || room.Area <= 0) continue;
            rooms.Add(new
            {
                id = room.Id.Value,
                name = room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(),
                number = room.Number,
                level = LevelName(doc, room),
                centre = Point(doc, point.Point),
                area_m2 = Math.Round(room.Area / (FeetPerMetre * FeetPerMetre), 1),
            });
            if (rooms.Count >= roomLimit) break;
        }

        var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
            .OrderBy(level => level.Elevation)
            .Select(level => new { name = level.Name, elevation = Length(doc, level.Elevation) })
            .ToList();

        var threeD = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>()
            .Where(view => !view.IsTemplate)
            .Select(view => new { name = view.Name, perspective = view.IsPerspective })
            .Take(40).ToList();

        return new
        {
            units = unitId.TypeId,
            elements_scanned = scanned,
            bounds = min is null || max is null ? null : new { min = Point(doc, min), max = Point(doc, max) },
            true_north_degrees = northDegrees,
            site,
            levels,
            rooms,
            existing_3d_views = threeD,
            materials = new FilteredElementCollector(doc).OfClass(typeof(Material)).GetElementCount(),
            note = "Coordinates are Revit's internal coordinates in the document's length unit. Place cameras from these, not from guesses.",
        };
    }

    // ── scene.render ───────────────────────────────────────────────────────────────────────────────────

    public static object RenderScene(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var eye = Vector(doc, args, "eye") ?? throw new RevitOpException("bad_request", "'eye' is required: [x, y, z] in the document's length unit. scene_info gives the bounds to place it from.");
        var target = Vector(doc, args, "target") ?? throw new RevitOpException("bad_request", "'target' is required: [x, y, z] the camera looks at.");
        var forward = target - eye;
        if (forward.GetLength() < 1e-6) throw new RevitOpException("bad_request", "'eye' and 'target' are the same point; move the camera away from what it looks at.");
        forward = forward.Normalize();

        var width = Number(args, "width", 1920, 400, 4000);
        var perspective = !(args.TryGetProperty("perspective", out var p) && p.ValueKind == JsonValueKind.False);
        var style = (Text(args, "style") ?? "realistic").ToLowerInvariant();
        var format = string.Equals(Text(args, "format"), "jpg", StringComparison.OrdinalIgnoreCase) ? ImageFileType.JPEGLossless : ImageFileType.PNG;

        var folder = Path.Combine(Path.GetTempPath(), "revit-mcp");
        System.IO.Directory.CreateDirectory(folder);
        var stem = Sanitise(Text(args, "name") ?? "render") + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);

        var notes = new List<string>();
        string? produced = null;

        using var group = new TransactionGroup(doc, "revit-mcp render");
        group.Start();
        try
        {
            View3D view;
            using (var transaction = new Transaction(doc, "revit-mcp render view"))
            {
                transaction.Start();
                var familyType = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                    .FirstOrDefault(type => type.ViewFamily == ViewFamily.ThreeDimensional)
                    ?? throw new RevitOpException("no_3d_type", "This document has no 3D view type, so a camera view cannot be made.");

                view = perspective ? View3D.CreatePerspective(doc, familyType.Id) : View3D.CreateIsometric(doc, familyType.Id);
                view.Name = $"revit-mcp-{Guid.NewGuid().ToString("N").Substring(0, 8)}";

                // Up is world Z unless the camera looks straight down or up, where it needs another reference.
                var up = Math.Abs(forward.Z) > 0.999 ? XYZ.BasisY : XYZ.BasisZ;
                view.SetOrientation(new ViewOrientation3D(eye, up, forward));

                ApplyStyle(view, style, notes);
                ApplySun(view, args, notes);
                ApplyAtmosphere(view, args, notes);
                HideCategories(doc, view, args, notes);
                ApplySectionBox(doc, view, args, notes);
                transaction.Commit();
            }

            var options = new ImageExportOptions
            {
                FilePath = Path.Combine(folder, stem),
                HLRandWFViewsFileType = format,
                ShadowViewsFileType = format,
                ZoomType = ZoomFitType.FitToPage,
                PixelSize = width,
                ExportRange = ExportRange.SetOfViews,
                ImageResolution = ImageResolution.DPI_150,
            };
            options.SetViewsAndSheets(new List<ElementId> { view.Id });
            doc.ExportImage(options);

            produced = Directory.GetFiles(folder, stem + "*")
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
        }
        finally
        {
            // Whatever happened above, the document goes back to exactly what it was.
            if (group.GetStatus() == TransactionStatus.Started) group.RollBack();
        }

        return new
        {
            path = produced,
            exists = produced is not null,
            width,
            style,
            perspective,
            eye = Point(doc, eye),
            target = Point(doc, target),
            model_changed = false,
            notes,
            note = "Written on the machine running Revit, in %TEMP%\\revit-mcp. The camera view it was made from was rolled back: the model, its views and its undo stack are as they were.",
        };
    }

    // ── helpers ────────────────────────────────────────────────────────────────────────────────────────

    private static void ApplyStyle(View3D view, string style, List<string> notes)
    {
        var wanted = style switch
        {
            "wireframe" => DisplayStyle.Wireframe,
            "hidden" or "hidden_line" => DisplayStyle.HLR,
            "shaded" => DisplayStyle.Shading,
            "consistent_colors" or "consistent" => DisplayStyle.FlatColors,
            "realistic" => DisplayStyle.Realistic,
            "rendering" => DisplayStyle.Rendering,
            _ => throw new RevitOpException("bad_request", $"Unknown style '{style}'. Use wireframe, hidden, shaded, consistent_colors, realistic or rendering."),
        };
        try { view.DisplayStyle = wanted; }
        catch (Exception ex)
        {
            notes.Add($"Revit would not set the '{style}' visual style ({ex.GetType().Name}); the view kept its default.");
        }
    }

    /// <summary>Sun and shadows for a still image: month/day/hour in the model's own time zone, shadows on.</summary>
    private static void ApplySun(View3D view, JsonElement args, List<string> notes)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("sun", out var sun) || sun.ValueKind != JsonValueKind.Object) return;
        try
        {
            var month = sun.TryGetProperty("month", out var m) && m.ValueKind == JsonValueKind.Number ? Compat.Clamp(m.GetInt32(), 1, 12) : 6;
            var day = sun.TryGetProperty("day", out var d) && d.ValueKind == JsonValueKind.Number ? Compat.Clamp(d.GetInt32(), 1, 28) : 21;
            var hour = sun.TryGetProperty("hour", out var h) && h.ValueKind == JsonValueKind.Number ? h.GetDouble() : 15.0;
            hour = Math.Max(0, Math.Min(23.99, hour));

            var settings = view.SunAndShadowSettings;
            settings.SunAndShadowType = SunAndShadowType.StillImage;
            settings.StartDateAndTime = new DateTime(DateTime.Now.Year, month, day, (int)hour, (int)((hour - Math.Floor(hour)) * 60), 0, DateTimeKind.Unspecified);

            if (!sun.TryGetProperty("shadows", out var shadows) || shadows.ValueKind != JsonValueKind.False)
            {
                var show = view.get_Parameter(BuiltInParameter.GRAPHIC_DISPLAY_OPTIONS_SHADOWS);
                if (show is { IsReadOnly: false }) show.Set(1);
            }
            if (sun.TryGetProperty("intensity", out var i) && i.ValueKind == JsonValueKind.Number) view.SunlightIntensity = Compat.Clamp(i.GetInt32(), 0, 100);
            if (sun.TryGetProperty("shadow_intensity", out var si) && si.ValueKind == JsonValueKind.Number) view.ShadowIntensity = Compat.Clamp(si.GetInt32(), 0, 100);
        }
        catch (Exception ex)
        {
            notes.Add($"Sun settings were not applied ({ex.GetType().Name}: {ex.Message}). The image uses the view's default lighting.");
        }
    }

    /// <summary>Sky backdrop and crisp outlines: the two cheapest changes that make a Revit still look like a visualisation.</summary>
    private static void ApplyAtmosphere(View3D view, JsonElement args, List<string> notes)
    {
        var background = Text(args, "background")?.ToLowerInvariant();
        if (background is not null)
        {
            try
            {
                var settings = view.GetRenderingSettings();
                settings.BackgroundStyle = background switch
                {
                    "clear_sky" or "sky" => BackgroundStyle.SkyNoClouds,
                    "few_clouds" => BackgroundStyle.SkyFewClouds,
                    "cloudy" => BackgroundStyle.SkyCloudy,
                    "transparent" => BackgroundStyle.Transparent,
                    "white" => BackgroundStyle.Color,
                    _ => throw new RevitOpException("bad_request", $"Unknown background '{background}'. Use clear_sky, few_clouds, cloudy, white or transparent."),
                };
                view.SetRenderingSettings(settings);
            }
            catch (RevitOpException) { throw; }
            catch (Exception ex) { notes.Add($"Background not applied ({ex.GetType().Name}); Revit only honours it in some visual styles."); }
        }

        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("outlines", out var outlines) && outlines.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            try
            {
                var display = view.GetViewDisplayModel();
                display.EnableSilhouettes = outlines.ValueKind == JsonValueKind.True;
                view.SetViewDisplayModel(display);
            }
            catch (Exception ex) { notes.Add($"Outlines not applied ({ex.GetType().Name})."); }
        }
    }

    private static void HideCategories(Document doc, View3D view, JsonElement args, List<string> notes)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("hide_categories", out var list) || list.ValueKind != JsonValueKind.Array) return;
        foreach (var item in list.EnumerateArray())
        {
            var name = item.ValueKind == JsonValueKind.String ? item.GetString() : null;
            if (string.IsNullOrWhiteSpace(name)) continue;
            Category? found = null;
            foreach (Category category in doc.Settings.Categories)
                if (string.Equals(category.Name, name, StringComparison.OrdinalIgnoreCase)) { found = category; break; }
            if (found is null) { notes.Add($"No category called '{name}', so nothing was hidden for it."); continue; }
            try
            {
                if (view.CanCategoryBeHidden(found.Id)) view.SetCategoryHidden(found.Id, true);
                else notes.Add($"'{name}' cannot be hidden in a 3D view.");
            }
            catch (Exception ex) { notes.Add($"Could not hide '{name}' ({ex.GetType().Name})."); }
        }
    }

    /// <summary>A section box from two corners, to cut a floor open or isolate a wing.</summary>
    private static void ApplySectionBox(Document doc, View3D view, JsonElement args, List<string> notes)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("section_box", out var box) || box.ValueKind != JsonValueKind.Object) return;
        var min = Vector(doc, box, "min");
        var max = Vector(doc, box, "max");
        if (min is null || max is null) { notes.Add("section_box needs both 'min' and 'max' ([x, y, z]); it was ignored."); return; }
        try
        {
            view.SetSectionBox(new BoundingBoxXYZ { Min = min, Max = max });
            view.IsSectionBoxActive = true;
        }
        catch (Exception ex) { notes.Add($"Section box not applied ({ex.GetType().Name})."); }
    }

    private static ForgeTypeId LengthUnit(Document doc)
    {
        try { return doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId(); }
        catch { return UnitTypeId.Feet; }
    }

    /// <summary>[x, y, z] in the document's own length unit, as the client saw it in scene_info, to Revit's internal feet.</summary>
    private static XYZ? Vector(Document doc, JsonElement args, string name)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array) return null;
        var parts = value.EnumerateArray().ToList();
        if (parts.Count != 3 || parts.Any(part => part.ValueKind != JsonValueKind.Number))
            throw new RevitOpException("bad_request", $"'{name}' must be three numbers: [x, y, z].");
        var unit = LengthUnit(doc);
        double ToFeet(JsonElement part) => UnitUtils.ConvertToInternalUnits(part.GetDouble(), unit);
        return new XYZ(ToFeet(parts[0]), ToFeet(parts[1]), ToFeet(parts[2]));
    }

    private static double[] Point(Document doc, XYZ point) => new[] { Length(doc, point.X) ?? 0, Length(doc, point.Y) ?? 0, Length(doc, point.Z) ?? 0 };
}
