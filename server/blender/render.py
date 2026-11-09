# Runs INSIDE Blender (headless):  blender -b --factory-startup --python render.py -- job.json
#
# Imports the glTF the Revit add-in exported, lights it with a physical sky and a sun placed from the
# model's real latitude and the date, puts a camera where the job says, and renders with Cycles.
# Coordinates: the glTF importer turns glTF's Y-up back into Blender's Z-up, so the scene is in Revit's own
# orientation, in metres, and the job's camera is in those same coordinates.
#
# Prints one line, "REVITMCP_RESULT {json}", that the Node side reads. Anything that can fail for reasons
# that differ between Blender versions (compositor nodes, GPU setup) is wrapped, reported in "notes", and
# never stops the render: a plainer picture is better than none.
import json
import math
import os
import sys

import bpy
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
notes = []


def note(message):
    notes.append(message)
    print("revit-mcp:", message)


# ── scene ───────────────────────────────────────────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=job["gltf"])
scene = bpy.context.scene

# Glass: materials the add-in exported with alpha become real transmissive glass, which is what makes
# facades read as a building rather than a cardboard model.
for material in bpy.data.materials:
    if not material.use_nodes:
        continue
    bsdf = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        continue
    alpha = bsdf.inputs["Alpha"].default_value
    if alpha < 0.95:
        try:
            bsdf.inputs["Transmission Weight"].default_value = 1.0 - alpha
            bsdf.inputs["Alpha"].default_value = 1.0
            bsdf.inputs["Roughness"].default_value = 0.04
            bsdf.inputs["IOR"].default_value = 1.45
        except KeyError:
            note("glass setup skipped: this Blender names the Principled inputs differently")

# Bounds of everything imported, for the ground and for framing a turntable.
corners = []
for obj in scene.objects:
    if obj.type == "MESH":
        corners.extend(obj.matrix_world @ Vector(c) for c in obj.bound_box)
if not corners:
    raise SystemExit("the glTF contained no geometry")
low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
centre = (low + high) / 2

# ── ground ──────────────────────────────────────────────────────────────────────────────────────────────
if job.get("ground", "grass") != "none":
    size = max(high.x - low.x, high.y - low.y, 20.0) * 12
    bpy.ops.mesh.primitive_plane_add(size=size, location=(centre.x, centre.y, low.z - 0.02))
    ground = bpy.context.active_object
    ground.name = "revit-mcp ground"
    material = bpy.data.materials.new("ground")
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    colours = {"grass": (0.13, 0.22, 0.07, 1), "concrete": (0.45, 0.45, 0.43, 1), "sand": (0.55, 0.47, 0.32, 1)}
    bsdf.inputs["Base Color"].default_value = colours.get(job["ground"], colours["grass"])
    bsdf.inputs["Roughness"].default_value = 0.95
    ground.data.materials.append(material)

# ── sky and sun ─────────────────────────────────────────────────────────────────────────────────────────
sun = job["sun"]
elevation = math.radians(sun["elevation"])
azimuth = math.radians(sun["azimuth"])  # compass degrees clockwise from north; +Y is north, +X is east
world = bpy.data.worlds.new("revit-mcp sky")
scene.world = world
world.use_nodes = True
tree = world.node_tree
tree.nodes.clear()
output = tree.nodes.new("ShaderNodeOutputWorld")
background = tree.nodes.new("ShaderNodeBackground")
try:
    sky = tree.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA" if "NISHITA" in [i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items] else "HOSEK_WILKIE"
    if sky.sky_type == "NISHITA":
        sky.sun_elevation = max(elevation, math.radians(0.5))
        # Nishita's sun_rotation turns the sky about Z. Zero puts the sun on the -Y side of the scene;
        # a compass azimuth of 180 (south) is -Y in Revit coordinates, so rotation = azimuth - 180.
        sky.sun_rotation = azimuth - math.pi
        sky.sun_disc = False  # the Sun lamp below makes the shadows; the disc would double the sun
        sky.air_density = 1.0
        sky.dust_density = 3.0 if job.get("overcast") else 1.2
    tree.links.new(sky.outputs["Color"], background.inputs["Color"])
except Exception as error:  # noqa: BLE001
    background.inputs["Color"].default_value = (0.55, 0.7, 0.95, 1)
    note(f"physical sky unavailable, used a flat sky colour ({error})")
background.inputs["Strength"].default_value = 0.25 if job.get("overcast") else 1.0
tree.links.new(background.outputs["Background"], output.inputs["Surface"])

light = bpy.data.lights.new("revit-mcp sun", "SUN")
light.energy = sun["strength"] * (0.15 if job.get("overcast") else 1.0)
light.angle = math.radians(2.0 if job.get("overcast") else 0.6)
toward_sun = Vector((math.sin(azimuth) * math.cos(elevation), math.cos(azimuth) * math.cos(elevation), math.sin(max(elevation, 0.01))))
sun_object = bpy.data.objects.new("revit-mcp sun", light)
# A Sun lamp shines down its own -Z, so its +Z must point at the sun.
sun_object.rotation_euler = toward_sun.to_track_quat("Z", "Y").to_euler()
scene.collection.objects.link(sun_object)

# ── camera ──────────────────────────────────────────────────────────────────────────────────────────────
camera_data = bpy.data.cameras.new("revit-mcp camera")
camera_data.lens = job["camera"].get("lens_mm", 28)
camera_data.clip_end = 5000
camera = bpy.data.objects.new("revit-mcp camera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera


def aim(eye, target):
    camera.location = eye
    camera.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()


aim(job["camera"]["eye"], job["camera"]["target"])

# ── render settings ─────────────────────────────────────────────────────────────────────────────────────
scene.render.engine = "CYCLES"
scene.render.resolution_x = job["width"]
scene.render.resolution_y = job["height"]
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.cycles.samples = job["samples"]
scene.cycles.seed = job.get("seed", 1)
scene.cycles.use_denoising = bool(job.get("denoise", True))
try:
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
except Exception:  # noqa: BLE001
    pass
scene.cycles.device = "CPU"
if job.get("gpu"):
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type != "CPU"]
                if gpus:
                    for device in prefs.devices:
                        device.use = True
                    scene.cycles.device = "GPU"
                    note(f"rendering on GPU ({kind})")
                    break
            except Exception:  # noqa: BLE001
                continue
        if scene.cycles.device != "GPU":
            note("no GPU found for Cycles; rendered on CPU")
    except Exception as error:  # noqa: BLE001
        note(f"GPU setup failed, rendered on CPU ({error})")

# Colour: AgX (or Filmic on older Blender) keeps bright facades from clipping to white.
for transform in ("AgX", "Filmic"):
    try:
        scene.view_settings.view_transform = transform
        break
    except TypeError:
        continue
try:
    scene.view_settings.look = "AgX - Medium High Contrast" if scene.view_settings.view_transform == "AgX" else "Medium High Contrast"
except TypeError:
    pass
scene.view_settings.exposure = job.get("exposure", 0)

# Finishing: a soft bloom on bright glass and a gentle vignette, in the compositor. Optional polish.
if job.get("bloom") or job.get("vignette"):
    try:
        scene.use_nodes = True
        nodes = scene.node_tree.nodes
        links = scene.node_tree.links
        nodes.clear()
        source = nodes.new("CompositorNodeRLayers")
        last = source.outputs["Image"]
        if job.get("bloom"):
            glare = nodes.new("CompositorNodeGlare")
            glare.glare_type = "FOG_GLOW"
            glare.threshold = 1.0
            links.new(last, glare.inputs["Image"])
            last = glare.outputs["Image"]
        if job.get("vignette"):
            mask = nodes.new("CompositorNodeEllipseMask")
            mask.width, mask.height = 0.92, 0.92
            blur = nodes.new("CompositorNodeBlur")
            blur.size_x = blur.size_y = int(job["width"] * 0.12)
            links.new(mask.outputs["Mask"], blur.inputs["Image"])
            mix = nodes.new("CompositorNodeMixRGB")
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 0.35
            # Blend 35% toward (image x blurred mask): 1 in the middle, falling off at the edges, so only the corners darken.
            links.new(last, mix.inputs[1])
            links.new(blur.outputs["Image"], mix.inputs[2])
            last = mix.outputs["Image"]
        composite = nodes.new("CompositorNodeComposite")
        links.new(last, composite.inputs["Image"])
    except Exception as error:  # noqa: BLE001
        scene.use_nodes = False
        note(f"finishing (bloom/vignette) skipped on this Blender version ({error})")

# ── render ──────────────────────────────────────────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(os.path.abspath(job["output"])), exist_ok=True)
result = {"notes": notes, "bounds_min": list(low), "bounds_max": list(high), "device": scene.cycles.device}

turntable = job.get("turntable")
if turntable:
    frames_dir = os.path.abspath(job["output"])
    os.makedirs(frames_dir, exist_ok=True)
    count = int(turntable.get("frames", 72))
    eye = Vector(job["camera"]["eye"])
    target = Vector(job["camera"]["target"])
    radius = math.hypot(eye.x - target.x, eye.y - target.y)
    start = math.atan2(eye.y - target.y, eye.x - target.x)
    paths = []
    for index in range(count):
        angle = start + 2 * math.pi * index / count
        aim(Vector((target.x + radius * math.cos(angle), target.y + radius * math.sin(angle), eye.z)), target)
        scene.render.filepath = os.path.join(frames_dir, "frame_%04d.png" % (index + 1))
        bpy.ops.render.render(write_still=True)
        paths.append(scene.render.filepath)
    result.update({"frames_dir": frames_dir, "frames": len(paths), "first": paths[0], "middle": paths[len(paths) // 2]})
else:
    scene.render.filepath = os.path.abspath(job["output"])
    bpy.ops.render.render(write_still=True)
    result["path"] = scene.render.filepath

print("REVITMCP_RESULT " + json.dumps(result))
