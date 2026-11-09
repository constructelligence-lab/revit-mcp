using System.Globalization;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMcp.Handlers;

/// <summary>
/// Files out of Revit: PDF / DWG / IFC / glTF, and the one new write, <c>schedule.create</c>.
/// Exports write files under %TEMP%\revit-mcp\exports and never change the model: anything that needs a
/// temporary view or transaction runs inside a <see cref="TransactionGroup"/> that is rolled back.
/// </summary>
public static partial class RevitOps
{
    private static string ExportFolder(string kind)
    {
        var folder = Path.Combine(Path.GetTempPath(), "revit-mcp", "exports", kind + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
        System.IO.Directory.CreateDirectory(folder);
        return folder;
    }

    private static List<string> FilesIn(string folder) =>
        System.IO.Directory.GetFiles(folder).Select(file => new FileInfo(file)).OrderBy(f => f.Name).Select(f => f.FullName).ToList();

    private static object ExportReport(string format, string folder, object? extra = null) => new
    {
        format,
        folder,
        files = FilesIn(folder).Select(path => new { path, bytes = new FileInfo(path).Length }).ToList(),
        model_changed = false,
        extra,
        note = "Written on the machine running Revit, under %TEMP%\\revit-mcp\\exports. Nothing in the model changed.",
    };

    /// <summary>Sheets by number (or all sheets), or views by name, as the ids an export wants.</summary>
    private static List<ElementId> ExportViews(Document doc, JsonElement args, bool sheetsByDefault)
    {
        var ids = new List<ElementId>();
        var wanted = new List<string>();
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("sheets", out var sheets) && sheets.ValueKind == JsonValueKind.Array)
            wanted.AddRange(sheets.EnumerateArray().Where(s => s.ValueKind == JsonValueKind.String).Select(s => s.GetString()!));
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("views", out var views) && views.ValueKind == JsonValueKind.Array)
            wanted.AddRange(views.EnumerateArray().Where(s => s.ValueKind == JsonValueKind.String).Select(s => s.GetString()!));

        var all = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().Where(s => !s.IsPlaceholder).Cast<View>()
            .Concat(new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate && v is not ViewSheet && v.CanBePrinted))
            .ToList();

        if (wanted.Count == 0)
        {
            if (!sheetsByDefault) throw new RevitOpException("bad_request", "Name what to export: 'sheets' (sheet numbers) or 'views' (view names).");
            return all.OfType<ViewSheet>().Select(s => s.Id).ToList();
        }

        foreach (var name in wanted)
        {
            var match = all.FirstOrDefault(v => v is ViewSheet sheet
                    ? string.Equals(sheet.SheetNumber, name, StringComparison.OrdinalIgnoreCase) || string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase)
                    : string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase))
                ?? throw new RevitOpException("not_found", $"No sheet or view '{name}'. list_sheets and list_views show what exists.");
            ids.Add(match.Id);
        }
        return ids;
    }

    public static object ExportPdf(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var ids = ExportViews(doc, args, sheetsByDefault: true);
        if (ids.Count > 60) throw new RevitOpException("too_many", $"{ids.Count} sheets is a lot for one call; name the sheets you want.");
        var folder = ExportFolder("pdf");
        var options = new PDFExportOptions { FileName = Sanitise(Text(args, "name") ?? doc.Title), Combine = !Flag(args, "separate") };
        doc.Export(folder, ids, options);
        return ExportReport("pdf", folder, new { sheets = ids.Count, combined = options.Combine });
    }

    public static object ExportDwg(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var ids = ExportViews(doc, args, sheetsByDefault: true);
        if (ids.Count > 60) throw new RevitOpException("too_many", $"{ids.Count} sheets is a lot for one call; name the sheets you want.");
        var folder = ExportFolder("dwg");
        doc.Export(folder, Sanitise(Text(args, "name") ?? doc.Title), ids, new DWGExportOptions());
        return ExportReport("dwg", folder, new { sheets = ids.Count });
    }

    public static object ExportIfc(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var folder = ExportFolder("ifc");
        var options = new IFCExportOptions { FileVersion = IFCVersion.IFC4 };
        // IFC export opens its own bookkeeping in the document on some releases; the group is rolled back regardless.
        using var group = new TransactionGroup(doc, "revit-mcp ifc export");
        group.Start();
        try
        {
            using var transaction = new Transaction(doc, "revit-mcp ifc export step");
            transaction.Start();
            if (!doc.Export(folder, Sanitise(Text(args, "name") ?? doc.Title), options))
                throw new RevitOpException("revit_refused", "Revit's IFC exporter reported failure. Check the IFC export setup in Revit (File > Export > IFC) for the same model.");
            transaction.RollBack();
        }
        finally
        {
            if (group.GetStatus() == TransactionStatus.Started) group.RollBack();
        }
        return ExportReport("ifc", folder, new { version = "IFC4" });
    }

    // ── glTF ───────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The 3D model as glTF 2.0 (a .gltf and a .bin), with Revit's materials as PBR colours, in metres and
    /// Y-up as the format wants. This is the hand-off to Blender, Unreal, Twinmotion or anything that
    /// ray-traces: Revit's API cannot start its own ray tracer, so the geometry leaves and the picture is made elsewhere.
    /// </summary>
    public static object ExportGltf(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var folder = ExportFolder("gltf");
        var stem = Sanitise(Text(args, "name") ?? doc.Title);
        var notes = new List<string>();
        GltfContext? context = null;

        using var group = new TransactionGroup(doc, "revit-mcp gltf export");
        group.Start();
        try
        {
            View3D view;
            using (var transaction = new Transaction(doc, "revit-mcp gltf view"))
            {
                transaction.Start();
                var type = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                    .FirstOrDefault(t => t.ViewFamily == ViewFamily.ThreeDimensional)
                    ?? throw new RevitOpException("no_3d_type", "This document has no 3D view type, so it cannot be exported.");
                view = View3D.CreateIsometric(doc, type.Id);
                view.Name = $"revit-mcp-{Guid.NewGuid().ToString("N").Substring(0, 8)}";
                view.DisplayStyle = DisplayStyle.Realistic;
                HideCategories(doc, view, args, notes);
                ApplySectionBox(doc, view, args, notes);
                transaction.Commit();
            }

            context = new GltfContext(doc);
            var exporter = new CustomExporter(doc, context) { IncludeGeometricObjects = false, ShouldStopOnError = false };
            exporter.Export(view);
        }
        finally
        {
            if (group.GetStatus() == TransactionStatus.Started) group.RollBack();
        }

        if (context is null || context.TriangleCount == 0)
            throw new RevitOpException("empty_scene", "Revit exported no geometry. Is the model empty, or everything hidden by 'hide_categories' or 'section_box'?");

        var gltf = Path.Combine(folder, stem + ".gltf");
        context.Write(gltf, stem + ".bin");
        notes.Add("Links were not exported (their geometry is in another document). Rooms, grids and other non-solid elements are not geometry.");
        return ExportReport("gltf", folder, new { triangles = context.TriangleCount, materials = context.MaterialCount, gltf, metres_y_up = true, notes });
    }

    private sealed class GltfContext(Document doc) : IExportContext
    {
        private sealed class Primitive
        {
            public List<float> Positions { get; } = new();
            public List<uint> Indices { get; } = new();
            public string Name { get; set; } = "";
            public float[] Colour { get; set; } = new[] { 0.8f, 0.8f, 0.8f, 1f };
            public double Roughness { get; set; } = 0.7;
        }

        private readonly Dictionary<string, Primitive> _primitives = new();
        private readonly Stack<Transform> _transforms = new();
        private Primitive? _current;
        private int _materialCounter;

        public int TriangleCount { get; private set; }
        public int MaterialCount => _primitives.Count;

        public bool Start() { _transforms.Push(Transform.Identity); return true; }
        public void Finish() { }
        public bool IsCanceled() => false;
        public RenderNodeAction OnViewBegin(ViewNode node) => RenderNodeAction.Proceed;
        public void OnViewEnd(ElementId elementId) { }
        public RenderNodeAction OnElementBegin(ElementId elementId) => RenderNodeAction.Proceed;
        public void OnElementEnd(ElementId elementId) { }
        public RenderNodeAction OnInstanceBegin(InstanceNode node) { _transforms.Push(_transforms.Peek().Multiply(node.GetTransform())); return RenderNodeAction.Proceed; }
        public void OnInstanceEnd(InstanceNode node) { _transforms.Pop(); }
        public RenderNodeAction OnLinkBegin(LinkNode node) => RenderNodeAction.Skip;
        public void OnLinkEnd(LinkNode node) { }
        public RenderNodeAction OnFaceBegin(FaceNode node) => RenderNodeAction.Proceed;
        public void OnFaceEnd(FaceNode node) { }
        public void OnRPC(RPCNode node) { }
        public void OnLight(LightNode node) { }

        public void OnMaterial(MaterialNode node)
        {
            var colour = node.Color;
            var rgb = colour is { IsValid: true } ? new[] { colour.Red / 255f, colour.Green / 255f, colour.Blue / 255f } : new[] { 0.8f, 0.8f, 0.8f };
            var alpha = (float)(1.0 - Math.Max(0, Math.Min(1, node.Transparency)));
            var materialName = node.MaterialId != ElementId.InvalidElementId ? doc.GetElement(node.MaterialId)?.Name : null;
            var key = $"{materialName}|{rgb[0]:0.00}|{rgb[1]:0.00}|{rgb[2]:0.00}|{alpha:0.00}|{node.Glossiness}";
            if (!_primitives.TryGetValue(key, out var primitive))
            {
                primitive = new Primitive
                {
                    Name = materialName ?? $"material-{++_materialCounter}",
                    Colour = new[] { rgb[0], rgb[1], rgb[2], alpha },
                    Roughness = Math.Round(1.0 - Math.Max(0, Math.Min(100, node.Glossiness)) / 100.0 * 0.85, 2),
                };
                _primitives[key] = primitive;
            }
            _current = primitive;
        }

        public void OnPolymesh(PolymeshTopology mesh)
        {
            var primitive = _current ??= DefaultPrimitive();
            var transform = _transforms.Peek();
            var offset = (uint)(primitive.Positions.Count / 3);
            foreach (var point in mesh.GetPoints())
            {
                var p = transform.OfPoint(point);
                // Revit: Z up, feet. glTF: Y up, metres. (x, y, z) -> (x, z, -y).
                primitive.Positions.Add((float)(p.X / FeetPerMetre));
                primitive.Positions.Add((float)(p.Z / FeetPerMetre));
                primitive.Positions.Add((float)(-p.Y / FeetPerMetre));
            }
            foreach (var facet in mesh.GetFacets())
            {
                // The Y/Z swap flips handedness, so reverse the winding to keep faces pointing out.
                primitive.Indices.Add(offset + (uint)facet.V1);
                primitive.Indices.Add(offset + (uint)facet.V3);
                primitive.Indices.Add(offset + (uint)facet.V2);
                TriangleCount++;
            }
        }

        private Primitive DefaultPrimitive()
        {
            const string key = "default";
            if (!_primitives.TryGetValue(key, out var primitive))
                _primitives[key] = primitive = new Primitive { Name = "default", Colour = new[] { 0.8f, 0.8f, 0.8f, 1f } };
            return primitive;
        }

        public void Write(string gltfPath, string binName)
        {
            var binPath = Path.Combine(Path.GetDirectoryName(gltfPath)!, binName);
            var bufferViews = new List<object>();
            var accessors = new List<object>();
            var materials = new List<object>();
            var primitives = new List<object>();
            long offset = 0;

            using (var bin = new FileStream(binPath, FileMode.Create, FileAccess.Write))
            using (var writer = new BinaryWriter(bin))
            {
                foreach (var primitive in _primitives.Values.Where(p => p.Indices.Count > 0))
                {
                    float[] min = { float.MaxValue, float.MaxValue, float.MaxValue }, max = { float.MinValue, float.MinValue, float.MinValue };
                    for (var i = 0; i < primitive.Positions.Count; i += 3)
                        for (var axis = 0; axis < 3; axis++)
                        {
                            min[axis] = Math.Min(min[axis], primitive.Positions[i + axis]);
                            max[axis] = Math.Max(max[axis], primitive.Positions[i + axis]);
                        }

                    var positionBytes = primitive.Positions.Count * 4L;
                    foreach (var value in primitive.Positions) writer.Write(value);
                    var indexBytes = primitive.Indices.Count * 4L;
                    foreach (var value in primitive.Indices) writer.Write(value);

                    var positionView = bufferViews.Count;
                    bufferViews.Add(new { buffer = 0, byteOffset = offset, byteLength = positionBytes, target = 34962 });
                    var indexView = bufferViews.Count;
                    bufferViews.Add(new { buffer = 0, byteOffset = offset + positionBytes, byteLength = indexBytes, target = 34963 });
                    offset += positionBytes + indexBytes;

                    var positionAccessor = accessors.Count;
                    accessors.Add(new { bufferView = positionView, componentType = 5126, count = primitive.Positions.Count / 3, type = "VEC3", min, max });
                    var indexAccessor = accessors.Count;
                    accessors.Add(new { bufferView = indexView, componentType = 5125, count = primitive.Indices.Count, type = "SCALAR" });

                    var materialIndex = materials.Count;
                    materials.Add(new
                    {
                        name = primitive.Name,
                        doubleSided = true,
                        alphaMode = primitive.Colour[3] < 0.999f ? "BLEND" : "OPAQUE",
                        pbrMetallicRoughness = new { baseColorFactor = primitive.Colour, metallicFactor = 0.0, roughnessFactor = primitive.Roughness },
                    });
                    primitives.Add(new { attributes = new { POSITION = positionAccessor }, indices = indexAccessor, material = materialIndex, mode = 4 });
                }
            }

            var document = new
            {
                asset = new { version = "2.0", generator = "revit-mcp" },
                scene = 0,
                scenes = new[] { new { nodes = new[] { 0 } } },
                nodes = new[] { new { name = doc.Title, mesh = 0 } },
                meshes = new[] { new { name = doc.Title, primitives } },
                materials,
                accessors,
                bufferViews,
                buffers = new[] { new { uri = binName, byteLength = offset } },
            };
            File.WriteAllText(gltfPath, JsonSerializer.Serialize(document, new JsonSerializerOptions { WriteIndented = false }), new UTF8Encoding(false));
        }
    }

    // ── schedule.create (a write) ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A new schedule of a category with the named fields. It adds a view to the model, so it is a write:
    /// previewed unless <c>apply</c> is true, one transaction, one Ctrl+Z. The preview lists which of the
    /// requested fields exist, so the assistant fixes names before anything is created.
    /// </summary>
    public static object CreateSchedule(UIApplication app, JsonElement args)
    {
        var doc = Document(app);
        var category = BuiltIn(doc, Required(args, "category"));
        var fieldNames = args.TryGetProperty("fields", out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().Where(f => f.ValueKind == JsonValueKind.String).Select(f => f.GetString()!).ToList()
            : throw new RevitOpException("bad_request", "'fields' is required: the parameter names to use as columns, e.g. [\"Type\", \"Level\", \"Count\"].");
        if (fieldNames.Count == 0) throw new RevitOpException("bad_request", "'fields' is empty.");
        var apply = Flag(args, "apply");
        var categoryId = new ElementId((long)category);
        if (!ViewSchedule.IsValidCategoryForSchedule(categoryId))
            throw new RevitOpException("bad_request", $"Revit cannot make a schedule of '{category.ToString().Replace("OST_", "")}'.");
        var name = Text(args, "name") ?? ViewSchedule.GetDefaultNameForSchedule(doc, categoryId);
        if (new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Any(v => string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase)))
            throw new RevitOpException("name_taken", $"A schedule called '{name}' already exists. Pick another name.");

        // Fields are discovered on a throw-away schedule inside a group that is always rolled back, so a preview
        // costs nothing and an apply reuses the same code path.
        using var group = new TransactionGroup(doc, "revit-mcp create schedule");
        group.Start();
        try
        {
            using var transaction = new Transaction(doc, $"revit-mcp: schedule {name}");
            transaction.Start();
            var schedule = ViewSchedule.CreateSchedule(doc, categoryId);
            schedule.Name = name;
            var definition = schedule.Definition;
            var available = definition.GetSchedulableFields().ToList();
            var added = new List<string>();
            var missing = new List<string>();
            foreach (var wanted in fieldNames)
            {
                var field = available.FirstOrDefault(f => string.Equals(f.GetName(doc), wanted, StringComparison.OrdinalIgnoreCase));
                if (field is null) { missing.Add(wanted); continue; }
                definition.AddField(field);
                added.Add(field.GetName(doc));
            }

            var sortBy = Text(args, "sort_by");
            if (sortBy is { Length: > 0 })
            {
                var sortField = definition.GetFieldOrder().Select(id => definition.GetField(id)).FirstOrDefault(f => string.Equals(f.GetName(), sortBy, StringComparison.OrdinalIgnoreCase));
                if (sortField is null) missing.Add($"sort_by:{sortBy}");
                else definition.AddSortGroupField(new ScheduleSortGroupField(sortField.FieldId, ScheduleSortOrder.Ascending));
            }

            if (added.Count == 0)
                throw new RevitOpException("no_fields", $"None of the requested fields exist on {category.ToString().Replace("OST_", "")}. Some that do: {string.Join(", ", available.Take(20).Select(f => f.GetName(doc)))}.");

            var preview = new
            {
                name,
                category = category.ToString().Replace("OST_", ""),
                fields = added,
                not_found = missing,
                available_fields = available.Select(f => f.GetName(doc)).Distinct().Take(60).ToList(),
            };

            if (!apply)
            {
                transaction.RollBack();
                return new { applied = false, preview, note = "Preview only. Nothing was created — call again with apply: true to add this schedule." };
            }

            transaction.Commit();
            group.Assimilate();
            return new { applied = true, schedule_id = schedule.Id.Value, preview, note = "Created in one transaction; a single Ctrl+Z in Revit removes it." };
        }
        finally
        {
            if (group.GetStatus() == TransactionStatus.Started) group.RollBack();
        }
    }
}
