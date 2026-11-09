# Rendering

Two ways to get a picture out of an open Revit model, and when to use each.

| | `render_scene` / `render_gallery` | `render_photoreal` / `render_turntable` |
|---|---|---|
| Made by | Revit's own visual styles, sun and shadows | Blender Cycles, a path tracer, on this machine |
| Look | Crisp presentation still | Physically-based: soft shadows, bounce light, real glass |
| Speed | Seconds | Draft about a minute; standard and final longer (GPU helps a lot) |
| Needs | Nothing but the add-in | Blender (free). `BLENDER_PATH` if it is not on the usual path |
| Use it to | Compose shots, iterate, hand out drafts | The pictures you actually send |

The routine that works: compose with `render_scene` (fast), then repeat the chosen shot with
`render_photoreal` at `quality: "draft"`, then `standard` or `final` once the framing is right. The
`presentation_renders` prompt walks an assistant through it.

## Why Blender, and not "Revit's renderer"

Revit's Render command (its ray tracer) is not exposed by the Revit API, so nothing outside Revit can start
it. What the API does allow is exporting the 3D geometry and materials. So the add-in exports a glTF and an
external renderer makes the picture. Nothing leaves the workstation: the glTF goes from Revit's temp folder to
a local Blender process and an image comes back.

## What the pipeline does

1. **Export** (`export.gltf`, in the add-in): a throw-away isometric 3D view is created, the geometry is walked
   with Revit's `CustomExporter`, and the view is rolled back with its transaction group. Output is glTF 2.0 in
   metres, Y-up, with each Revit material as a PBR colour (transparency becomes alpha, glossiness becomes
   roughness). Hide categories or give a section box to export only what the picture needs.
2. **Plan**: the camera comes from a preset or an explicit `eye` and `target` (in the document's unit, the
   same as `scene_info`), converted to metres.
3. **Light**: `sunPosition` ([server/camera.mjs](../server/camera.mjs)) computes elevation and azimuth from the
   model's latitude (`scene_info.site`), the date and a time in **hours by the sun** (12 is solar noon).
   `mood` presets set date, time and sky; an explicit `sun` overrides them.
4. **Render** ([server/blender/render.py](../server/blender/render.py), run inside Blender): imports the
   glTF, turns alpha materials into real glass, adds a ground plane (`grass`, `concrete`, `sand` or `none`),
   a physical sky, a Sun lamp at the computed position, the camera (28 mm lens), Cycles with denoising,
   AgX colour, optional bloom and vignette, then writes a PNG. Turntables render one frame per step of an
   orbit at the shot's height and distance.

## Settings

| Setting | Values |
|---|---|
| `quality` | `draft` (48 samples), `standard` (160, default), `final` (512) |
| `width` | 480 to 3840 px (turntable frames up to 1920); 16:9 |
| `ground` | `grass` (default), `concrete`, `sand`, `none` (use `none` for interiors) |
| `exposure` | −3 to +3 stops |
| `gpu` | Use the GPU if Blender finds one (OptiX, CUDA, HIP, Metal or oneAPI); falls back to CPU and says so |
| `mood` / `sun` | `day`, `morning`, `golden_hour`, `overcast`, `winter`, or `{month, day, hour, intensity}` |

For a turntable: `frames` (8 to 240, default 36), `fps` for the MP4. An MP4 is made only if `ffmpeg` is on
`PATH` (or `FFMPEG_PATH`); otherwise the numbered frames are the result and the response says so.

## Limits, stated plainly

- **Compose in draft first.** A full-quality frame on a laptop CPU is slow, and a turntable is a frame each.
- **Materials are colours, not textures.** The export carries Revit's material colour, transparency and
  glossiness. It does not carry image textures, bump maps or the rendering appearance assets, so brick looks
  like brick-coloured, not brick. Assign real materials in Blender for hero shots, or use the glTF in
  Twinmotion or Unreal, which have their own libraries.
- **Sun time is solar time.** It ignores time zones, daylight saving and the equation of time (a degree or
  two). True north is assumed to be the model's +Y axis; if the project north is rotated, adjust the `hour`
  or the camera, or open the glTF in Blender and rotate the sun there.
- **No people, trees or furniture libraries.** Furniture in the model exports as modelled.
- **Links are skipped** in the export.
- **Not verified in a live session yet.** The add-in compiles against the real Revit API and the server and
  job logic are tested, but the Blender script has not been run by the author against a real export:
  treat the first render on your machine as the real test, and open an issue with Blender's output if it fails.

## Other renderers

`export_model` with `format: "gltf"` gives you the same geometry for Blender (by hand), Unreal, Twinmotion,
three.js and most other tools. Autodesk's own cloud rendering and ACC/Docs hand-off are run from Revit's
interface, not its API, so this project does not automate them.

## Finishing a gallery

Bloom and vignette are applied inside Blender. This project does not add title blocks, captions or logos to
pictures. Do that in your layout tool, or ask for `render_gallery` stills and place them on a sheet.
