// The prompt menu: the workflows this bridge is actually for, written out.
//
// A tool list tells a client what it *can* call; prompts tell it what people *do* with a Revit model at
// 8am — and they carry the house rules with them (say what you read, preview before you write, a warning
// is a prompt to look and not a defect finding). A client that has these does not have to invent a method.
import { z } from 'zod';

export const PROMPTS = [
  {
    name: 'model_health_check',
    title: 'Model health check',
    description: 'Read the model the way a BIM manager would on a Monday: sizes, warnings, what is on each level, what stands out.',
    args: {
      level: z.string().optional().describe('Limit the review to one level, e.g. "L2"'),
    },
    build: ({ level }) => `${level ? `Review the ${level} level of` : 'Review'} the open Revit model and report its health.

1. revit_status — which document, which user's session, whether writes are on. Say the document name in your answer.
2. model_overview — sizes and the biggest categories.
3. model_warnings — read them all; group them by what they mean for coordination, not by Revit's wording.
4. list_levels${level ? ` and query_elements for ${level}` : ''} — anything missing or oddly populated.

Answer as: what this model is, the five things most worth a person's attention, and what you did not look at.
Every number you quote must come from a tool call in this conversation. A warning is Revit's, not a defect finding — say so where it matters.`,
  },
  {
    name: 'quantities_from_schedules',
    title: 'Quantities from schedules',
    description: 'Take-off numbers for an estimate, read from the schedules the model computes, with the caveats a quantity surveyor would want.',
    args: {
      trade: z.string().optional().describe('Trade or package to focus on, e.g. "doors" or "walls"'),
    },
    build: ({ trade }) => `Take off quantities${trade ? ` for ${trade}` : ''} from the open model.

1. list_schedules — say which schedules exist before using them.
2. read_schedule for each one that carries the quantities.
3. Where a schedule is missing, query_elements + element_details can count and classify instead — say which method you used.
4. Say the units, and whether the model's schedule includes every level or one.

Present a table: item, quantity, source (schedule name or element count), and anything that would change the number (unplaced types, design options, worksets). Do not present a total you cannot trace to a schedule or a count.`,
  },
  {
    name: 'sheet_qa',
    title: 'Sheet set QA',
    description: 'Check what was issued: sheets, their views, revisions, and anything printed that should not have been.',
    args: {},
    build: () => `Review the drawing set the model would issue.

1. sheets.list — every sheet with its number, name and placed views.
2. views.list — views that exist but are on no sheet (those are usually the interesting ones).
3. Where a sheet carries a revision parameter, say it.

Report gaps (a view that looks issued but is unplaced, sheets with no views, an empty title block field), and keep it to what the model says. Whether a drawing is *right* is not something this can answer.`,
  },
  {
    name: 'parameter_audit',
    title: 'Parameter audit (and a previewed fix)',
    description: 'Find empty Marks and other unpopulated identity data, then preview the fix one element at a time — nothing is written without a yes.',
    args: {
      category: z.string().optional().describe('Category to audit, default "Doors"'),
      parameter: z.string().optional().describe('Parameter to check, default "Mark"'),
    },
    build: ({ category = 'Doors', parameter = 'Mark' }) => `Audit the ${parameter} parameter on ${category} in the open model.

1. query_elements with category=${category}, then element_details on a few — establish whether the parameter is empty, missing, or just not shown.
2. List every element where it is empty, with id and type.
3. Propose a marking scheme that fits what is already there (read the neighbouring values first; do not invent a scheme that clashes).
4. If the user wants it applied: set_parameter once per element with apply: true. Before each one, say what will change, and stop if the answer is anything but a clear yes. Never batch a write without confirmation, and never touch a type parameter.

Say how many elements you checked and how many you changed.`,
  },
  {
    name: 'presentation_renders',
    title: 'Presentation renders',
    description: 'A client-ready set of pictures of the open model: plan the shots, render them, look at each one, fix what is wrong and pick the best.',
    args: {
      audience: z.string().optional().describe('Who the pictures are for, e.g. "planning committee" or "client board"'),
      mood: z.enum(['day', 'morning', 'golden_hour', 'overcast', 'winter']).optional().describe('Light and sky (default golden_hour)'),
    },
    build: ({ audience, mood }) => `Make a presentation set of pictures of the open Revit model${audience ? ` for ${audience}` : ''}.

1. scene_info — read the bounds, site and rooms. Say what building this is before you shoot it.
2. render_gallery with ${mood ?? 'golden_hour'} light and outlines on — the four exterior corners first. LOOK at each image. Say honestly which are strong and which are not (camera inside a neighbour, a facade hidden, a flat horizon).
3. Fix what is weak with render_scene: another preset, or an explicit eye and target from the bounds; hide categories that clutter (Furniture, Planting, Site) when the building is the subject; try aerial_* for context.
4. Add two or three interiors (preset interior, naming the rooms that matter) and one top view if a plan reads well.
5. Finish with the best five or six: for each, the file path, the camera and the one-line story it tells.

Rules: these are Revit's own visual styles, not ray-traced renders — do not describe them as photorealistic. Nothing in the model changes, and you must not say it does. If an image is poor, say so and re-shoot rather than presenting it.`,
  },

];

export const PROMPT_BY_NAME = new Map(PROMPTS.map(prompt => [prompt.name, prompt]));
