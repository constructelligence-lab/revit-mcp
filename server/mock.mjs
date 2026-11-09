// The sample model: an in-process stand-in for the add-in, with the same two methods (`health`, `call`).
//
// It exists for two reasons. First, so the server can be run, demonstrated, taught and tested on any
// machine — including the macOS and Linux ones the Revit add-in cannot run on. Second, because the tool
// contract is easier to keep honest against a fixture than against a live model: every result here has
// the shape docs/protocol.md documents, and the tests assert on it.
//
// It is a *fixture*, not a Revit simulation: no geometry engine, no transactions, no worksharing. Anything
// it answers about the real API is a claim about this file, nothing more. Results carry `mock: true` so a
// client can never mistake them for a live model.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError } from './bridge.mjs';

// A 1x1 PNG: the mock writes a real, decodable image file so the image path through the server is tested end to end.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const LEVELS = [
  { name: 'L1', elevation: 0 },
  { name: 'L2', elevation: 3600 },
  { name: 'L3', elevation: 7200 },
];

const CATEGORY_TYPES = {
  Walls: [['Basic Wall', 'Generic - 200mm'], ['Basic Wall', 'Generic - 100mm'], ['Basic Wall', 'Exterior - Brick on Block']],
  Doors: [['Single-Flush', '0915 x 2134mm'], ['Double-Flush', '1830 x 2134mm']],
  Windows: [['Fixed', '0915 x 1220mm'], ['Casement', '0600 x 900mm']],
  Rooms: [['Room', 'Office'], ['Room', 'Corridor'], ['Room', 'Store']],
  Furniture: [['Desk', '1500 x 750mm'], ['Chair', 'Task']],
};

const COUNTS = { Walls: 42, Doors: 18, Windows: 24, Rooms: 36, Furniture: 12 };
const ROOM_NAMES = ['Office', 'Corridor', 'Store', 'Meeting', 'WC'];

const WARNINGS = [
  ['Warning', 'Room is not enclosed.', [100031, 100032]],
  ['Warning', "Elements have duplicate 'Mark' values.", [100003, 100019]],
  ['Warning', 'Wall and room separation lines overlap.', [100007]],
  ['Warning', 'Doors are less than 15 cm from a wall.', [100050, 100051]],
  ['Warning', 'Stairs have an invalid sketch.', []],
];

const VIEWS = [
  ['L1 - Floor Plan', 'FloorPlan', 'L1', 'A-101'],
  ['L2 - Floor Plan', 'FloorPlan', 'L2', 'A-102'],
  ['L3 - Floor Plan', 'FloorPlan', 'L3', 'A-103'],
  ['South Elevation', 'Elevation', null, 'A-201'],
  ['Section A', 'Section', null, 'A-301'],
  ['{3D}', 'ThreeD', null, null],
  ['Door Schedule', 'Schedule', null, 'A-601'],
  ['Room Schedule', 'Schedule', null, 'A-602'],
  ['Wall Takeoff', 'Schedule', null, null],
];

const SHEETS = [
  ['A-101', 'Ground Floor Plan', ['L1 - Floor Plan']],
  ['A-102', 'Second Floor Plan', ['L2 - Floor Plan']],
  ['A-103', 'Third Floor Plan', ['L3 - Floor Plan']],
  ['A-201', 'Elevations', ['South Elevation']],
  ['A-301', 'Sections', ['Section A']],
  ['A-601', 'Door Schedule', ['Door Schedule', 'Room Schedule']],
];

const SCHEDULE_ROWS = {
  'Door Schedule': {
    columns: ['Family and Type', 'Level', 'Mark', 'Fire Rating', 'Width', 'Height'],
    rows: [
      ['Single-Flush: 0915 x 2134mm', 'L1', 'D-101', '60 min', 915, 2134],
      ['Double-Flush: 1830 x 2134mm', 'L1', 'D-102', '90 min', 1830, 2134],
      ['Single-Flush: 0915 x 2134mm', 'L2', 'D-201', '60 min', 915, 2134],
    ],
  },
  'Room Schedule': {
    columns: ['Number', 'Name', 'Level', 'Area', 'Perimeter'],
    rows: [
      ['L1-101', 'Office', 'L1', 24.6, 21.4],
      ['L1-102', 'Corridor', 'L1', 12.1, 15.8],
      ['L2-201', 'Office', 'L2', 24.6, 21.4],
    ],
  },
  'Wall Takeoff': {
    columns: ['Type', 'Length', 'Area'],
    rows: [
      ['Generic - 200mm', 148.2, 355.7],
      ['Generic - 100mm', 62.4, 149.8],
      ['Exterior - Brick on Block', 96.5, 463.2],
    ],
  },
};

/** Deterministic sample elements: ids are stable between calls, which is what a client needs to reason. */
function buildElements() {
  const elements = [];
  let id = 100000;
  for (const [category, types] of Object.entries(CATEGORY_TYPES)) {
    const count = COUNTS[category];
    for (let i = 0; i < count; i++) {
      const [family, type] = types[i % types.length];
      const level = LEVELS[i % LEVELS.length].name;
      id += 1;
      const params = { Mark: `${category[0]}-${100 + i}`, Comments: i % 5 === 0 ? 'Check on site' : '' };
      if (category === 'Walls' || category === 'Doors') params['Fire Rating'] = type.includes('Double') ? '90 min' : '60 min';
      if (category === 'Rooms') {
        params.Number = `${level}-${100 + i}`;
        params.Name = ROOM_NAMES[i % ROOM_NAMES.length];
        params.Area = Number((8 + (i % 7) * 2.4).toFixed(1));
      }
      elements.push({
        id, category, family, type, level,
        name: category === 'Rooms' ? `Room: ${params.Name}` : `${family}: ${type}`,
        parameters: params,
        workset: 'Workset1',
        bbox: { min: [0, 0, LEVELS.find(l => l.name === level).elevation], max: [5200, 3400, LEVELS.find(l => l.name === level).elevation + 2400], units: 'millimeters' },
      });
    }
  }
  return elements;
}

export class MockRevit {
  #elements = buildElements();
  #writesAllowed;
  #renders = 0;
  #createdSchedules = [];
  #documents = { version: '2025.2', document: 'Sample Tower.rvt', path: 'C:\\Projects\\Sample Tower.rvt', workshared: true };

  constructor({ writesAllowed = true } = {}) {
    this.#writesAllowed = writesAllowed;
  }

  /** Turn writes off at the fixture too, so "read-only" is testable from both ends. */
  set writesAllowed(value) {
    this.#writesAllowed = Boolean(value);
  }

  async health() {
    return {
      bridge: { version: '0.1.0', mock: true, pid: process.pid, writesAllowed: this.#writesAllowed },
      revit: { version: this.#documents.version, document: this.#documents.document, path: this.#documents.path,
        units: 'millimeters', workshared: this.#documents.workshared, activeView: 'L2 - Floor Plan', modified: true },
    };
  }

  async call(op, args = {}) {
    if (op === 'parameter.set' && !this.#writesAllowed) {
      throw new BridgeError('The add-in will not write: it was started read-only.', { code: 'writes_disabled' });
    }
    const handler = this[op];
    if (typeof handler !== 'function' || op.startsWith('#')) {
      throw new BridgeError(`Unknown operation '${op}'. The add-in implements the ops in docs/protocol.md.`, { code: 'unknown_op' });
    }
    return { mock: true, ...handler.call(this, args) };
  }

  // ── The ops, one method per entry in docs/protocol.md ──────────────────────────────────────────────

  /** @returns every level with the element count beside it. */
  status() {
    return {
      revit: { version: this.#documents.version, document: this.#documents.document, path: this.#documents.path,
        units: 'millimeters', workshared: this.#documents.workshared, activeView: 'L2 - Floor Plan' },
      writesAllowed: this.#writesAllowed,
      levels: LEVELS.length,
    };
  }

  'model.overview'(args = {}) {
    const categories = Object.entries(COUNTS).map(([name, count]) => ({ name, instances: count }));
    return {
      document: this.#documents.document,
      revit_version: this.#documents.version,
      units: 'millimeters',
      levels: LEVELS.length,
      views: VIEWS.length,
      sheets: SHEETS.length,
      schedules: Object.keys(SCHEDULE_ROWS).length,
      warnings: WARNINGS.length,
      categories: categories.slice(0, args.category_limit ?? 20).sort((a, b) => b.instances - a.instances),
      elements: this.#elements.length,
    };
  }

  'levels.list'() {
    return {
      levels: LEVELS.map(level => ({
        name: level.name,
        elevation: level.elevation,
        elements: this.#elements.filter(e => e.level === level.name).length,
      })),
    };
  }

  'categories.list'(args = {}) {
    return {
      categories: Object.entries(COUNTS).map(([name, instances]) => ({ name, instances })).slice(0, args.limit ?? 50),
    };
  }

  'elements.query'(args = {}) {
    if (!args.category) throw new BridgeError("'category' is required — list_categories shows what this model has.", { code: 'bad_request' });
    const wanted = String(args.category).toLowerCase();
    let rows = this.#elements.filter(e => e.category.toLowerCase() === wanted);
    if (args.level) rows = rows.filter(e => e.level.toLowerCase() === String(args.level).toLowerCase());
    if (args.family) rows = rows.filter(e => e.family.toLowerCase() === String(args.family).toLowerCase());
    if (args.type) rows = rows.filter(e => e.type.toLowerCase() === String(args.type).toLowerCase());
    if (args.parameter) {
      const key = String(args.parameter);
      const needle = String(args.value ?? '').toLowerCase();
      rows = rows.filter(e => String(e.parameters[key] ?? '').toLowerCase().includes(needle));
    }
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    return {
      category: args.category,
      total: rows.length,
      offset,
      rows: rows.slice(offset, offset + limit).map(e => ({ id: e.id, category: e.category, family: e.family, type: e.type, level: e.level, mark: e.parameters.Mark ?? null })),
    };
  }

  'element.details'(args = {}) {
    const element = this.#find(args.element_id);
    return { element: { ...element, instances_of_type: this.#elements.filter(e => e.family === element.family && e.type === element.type).length } };
  }

  'views.list'(args = {}) {
    let rows = VIEWS.map(([name, type, level, sheet]) => ({ name, type, level, sheet }));
    if (args.type) rows = rows.filter(v => v.type.toLowerCase() === String(args.type).toLowerCase());
    return { views: rows.slice(0, args.limit ?? 50), total: rows.length };
  }

  'sheets.list'(args = {}) {
    return { sheets: SHEETS.map(([number, name, views]) => ({ number, name, views })).slice(0, args.limit ?? 50) };
  }

  'families.list'(args = {}) {
    const families = new Map();
    for (const element of this.#elements) {
      const key = `${element.family}`;
      const entry = families.get(key) ?? { name: element.family, types: new Set(), instances: 0 };
      entry.types.add(element.type);
      entry.instances += 1;
      families.set(key, entry);
    }
    return { families: [...families.values()].map(f => ({ name: f.name, types: f.types.size, instances: f.instances })).slice(0, args.limit ?? 50) };
  }

  'warnings.list'(args = {}) {
    return { warnings: WARNINGS.map(([severity, description, ids]) => ({ severity, description, element_ids: ids })).slice(0, args.limit ?? 50), total: WARNINGS.length };
  }

  'schedules.list'() {
    return { schedules: Object.keys(SCHEDULE_ROWS).map(name => ({ name, rows: SCHEDULE_ROWS[name].rows.length, columns: SCHEDULE_ROWS[name].columns })) };
  }

  'schedule.read'(args = {}) {
    const schedule = SCHEDULE_ROWS[args.schedule];
    if (!schedule) throw new BridgeError(`No schedule named '${args.schedule}'. list_schedules shows the ${Object.keys(SCHEDULE_ROWS).length} this model has.`, { code: 'not_found' });
    const limit = args.limit ?? 50;
    return { name: args.schedule, columns: schedule.columns, rows: schedule.rows.slice(0, limit), total: schedule.rows.length };
  }

  'selection.get'() {
    // What a user would plausibly have selected: a wall and the door in it.
    const wall = this.#elements.find(e => e.category === 'Walls');
    const door = this.#elements.find(e => e.category === 'Doors');
    return { elements: [wall, door].map(e => ({ id: e.id, category: e.category, name: e.name, level: e.level })) };
  }

  'view.export_image'(args = {}) {
    const view = args.view ?? 'L2 - Floor Plan';
    if (!VIEWS.some(([name]) => name === view)) throw new BridgeError(`No view named '${view}'. list_views shows what this model has.`, { code: 'not_found' });
    const width = args.width ?? 1600;
    return { view, path: `/tmp/revit-mcp-mock/${view.replace(/[^\w.-]+/g, '-')}-${width}.png`, width, height: Math.round(width * 0.62), mocked: true };
  }

  'scene.info'() {
    return {
      mock: true,
      units: 'autodesk.unit.unit:millimeters-1.0.1',
      elements_scanned: 132,
      bounds: { min: [0, 0, 0], max: [30000, 20000, 10800] },
      true_north_degrees: 0,
      site: { latitude: 53.34981, longitude: -6.26031, place: 'Dublin, Ireland' },
      levels: LEVELS,
      rooms: [
        { id: 100201, name: 'Office', number: '101', level: 'L1', centre: [6000, 5000, 0], area_m2: 42.5 },
        { id: 100202, name: 'Meeting', number: '102', level: 'L1', centre: [18000, 5000, 0], area_m2: 24 },
        { id: 100203, name: 'Office', number: '201', level: 'L2', centre: [6000, 5000, 3600], area_m2: 42.5 },
      ],
      existing_3d_views: [{ name: '{3D}', perspective: false }],
      materials: 61,
      note: "Coordinates are Revit's internal coordinates in the document's length unit. Place cameras from these, not from guesses.",
    };
  }

  'scene.render'(args = {}) {
    if (!Array.isArray(args.eye) || !Array.isArray(args.target)) throw new BridgeError("'eye' and 'target' are required: [x, y, z].", { code: 'bad_request' });
    if (args.eye.every((v, i) => v === args.target[i])) throw new BridgeError("'eye' and 'target' are the same point; move the camera away from what it looks at.", { code: 'bad_request' });
    const style = args.style ?? 'realistic';
    if (!['wireframe', 'hidden', 'shaded', 'consistent_colors', 'realistic', 'rendering'].includes(style)) {
      throw new BridgeError(`Unknown style '${style}'.`, { code: 'bad_request' });
    }
    const folder = join(tmpdir(), 'revit-mcp-mock');
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${String(args.name ?? 'render').replace(/[^\w.-]+/g, '-')}-${this.#renders++}.png`);
    writeFileSync(path, TINY_PNG);
    return {
      mock: true, path, exists: true, width: args.width ?? 1920, style, perspective: args.perspective !== false,
      eye: args.eye, target: args.target, sun: args.sun ?? null, background: args.background ?? null,
      hide_categories: args.hide_categories ?? [], model_changed: false, notes: [],
      note: 'Mock render: a 1x1 placeholder image. The real add-in exports the camera view from Revit and rolls the view back.',
    };
  }

  'rooms.list'(args = {}) {
    const rooms = [
      { id: 100201, number: '101', name: 'Office', level: 'L1', department: 'Admin', area_m2: 42.5, perimeter: 26800, volume_m3: 153, centre: [6000, 5000], size: [8500, 5000] },
      { id: 100202, number: '102', name: 'Meeting', level: 'L1', department: 'Admin', area_m2: 24, perimeter: 19600, volume_m3: 86.4, centre: [18000, 5000], size: [6000, 4000] },
      { id: 100203, number: '201', name: 'Office', level: 'L2', department: 'Admin', area_m2: 42.5, perimeter: 26800, volume_m3: 153, centre: [6000, 5000], size: [8500, 5000] },
    ].filter(r => !args.level || r.level === args.level);
    const rows = rooms.slice(0, args.limit ?? 50).map(({ centre, size, ...room }) => ({
      ...room,
      boundaries: args.boundaries ? [[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy], i, all) => {
        const next = all[(i + 1) % 4];
        return { from: [centre[0] + sx * size[0] / 2, centre[1] + sy * size[1] / 2, 0], to: [centre[0] + next[0] * size[0] / 2, centre[1] + next[1] * size[1] / 2, 0] };
      })] : null,
    }));
    return { mock: true, total: rooms.length, total_area_m2: rooms.reduce((a, r) => a + r.area_m2, 0), rows, truncated: rooms.length > rows.length };
  }

  'structure.list'(args = {}) {
    const data = {
      grids: [['A', [0, 0, 0], [0, 20000, 0]], ['B', [10000, 0, 0], [10000, 20000, 0]], ['1', [-1000, 0, 0], [31000, 0, 0]]].map(([name, from, to], i) => ({ id: 300 + i, name, curved: false, from, to })),
      links: [{ id: 400, type: 'revit', name: 'Structure.rvt : 1', loaded: true, document: 'Structure.rvt', origin: [0, 0, 0] }, { id: 401, type: 'cad_link', name: 'Site.dwg', view_specific: false }],
      phases: [{ id: 1, sequence: 1, name: 'Existing' }, { id: 2, sequence: 2, name: 'New Construction' }],
      design_options: [{ id: 500, name: 'Option 1 - Atrium', primary: true }, { id: 501, name: 'Option 2 - Courtyard', primary: false }],
      worksets: [{ id: 1, name: 'Shared Levels and Grids', owner: 'cian', open: true, editable: true, visible_by_default: true }, { id: 2, name: 'Architecture', owner: 'alex', open: true, editable: false, visible_by_default: true }],
      revisions: [{ id: 600, sequence: 1, number: '1', date: '2026-09-01', description: 'Issued for tender', issued: true, issued_by: 'CG', issued_to: 'Tenderers' }, { id: 601, sequence: 2, number: '2', date: '2026-10-12', description: 'Addendum 1', issued: false, issued_by: '', issued_to: '' }],
    };
    if (!(args.kind in data)) throw new BridgeError(`Unknown kind '${args.kind}'. Use grids, links, phases, design_options, worksets or revisions.`, { code: 'bad_request' });
    return { mock: true, kind: args.kind, rows: data[args.kind].slice(0, args.limit ?? 100) };
  }

  'materials.list'(args = {}) {
    const all = [['Brick, Common', 'Masonry', '#A5503C', 0], ['Concrete - Cast in Place', 'Concrete', '#8C8C8C', 0], ['Glass, Clear', 'Glass', '#BFD9E6', 70], ['Timber - Oak', 'Wood', '#9C7A4B', 0]]
      .filter(([name]) => !args.name || name.toLowerCase().includes(String(args.name).toLowerCase()))
      .map(([name, cls, colour, transparency], i) => ({ id: 700 + i, name, class: cls, colour, transparency, shininess: 30, has_appearance: true }));
    return { mock: true, total: all.length, rows: all.slice(0, args.limit ?? 100), truncated: false };
  }

  'wall.layers'(args = {}) {
    const element = this.#find(args.element_id);
    if (element.category !== 'Walls') throw new BridgeError(`Element ${element.id} (${element.category}) has no layered build-up. Walls, floors, roofs and ceilings do.`, { code: 'not_found' });
    const layers = [['Finish1', 'Brick, Common', 102.5], ['Substrate', 'Air', 50], ['Structure', 'Concrete Block', 100], ['Finish2', 'Gypsum Plaster', 13]].map(([fn, material, thickness], i) => ({ index: i + 1, function: fn, material, thickness }));
    return { mock: true, element_id: element.id, type: element.name, category: 'Walls', total_thickness: layers.reduce((a, l) => a + l.thickness, 0), layers };
  }

  'geometry.quantities'(args = {}) {
    if (!(args.category in CATEGORY_TYPES)) throw new BridgeError(`No model category called '${args.category}'. categories.list shows the ones this model uses.`, { code: 'not_found' });
    const rows = CATEGORY_TYPES[args.category].map(([family, type], i) => ({ type: `${family}: ${type}`, count: 10 + i * 4, area_m2: 120 - i * 30, volume_m3: 24 - i * 6, length: 80000 - i * 20000 }));
    return { mock: true, category: args.category, level: args.level ?? null, scanned: 42, truncated: false, totals: { count: rows.reduce((a, r) => a + r.count, 0), area_m2: rows.reduce((a, r) => a + r.area_m2, 0), volume_m3: rows.reduce((a, r) => a + r.volume_m3, 0) }, rows };
  }

  'clash.check'(args = {}) {
    for (const key of ['category_a', 'category_b']) {
      if (!(args[key] in CATEGORY_TYPES)) throw new BridgeError(`No model category called '${args[key]}'. categories.list shows the ones this model uses.`, { code: 'not_found' });
    }
    const clashes = [{ a: { id: 100003, name: 'Generic - 200mm', level: 'L1' }, b: { id: 100050, name: '0915 x 2134mm', level: 'L1' } }].slice(0, args.limit ?? 50);
    return { mock: true, category_a: args.category_a, category_b: args.category_b, elements_checked: 42, clashes_found: clashes.length, clashes, truncated: false, note: 'Geometric intersection only. Intersecting is not the same as a defect.' };
  }

  #exportTo(kind, files, extra = {}) {
    const folder = join(tmpdir(), 'revit-mcp-mock', 'exports', `${kind}-${this.#renders++}`);
    mkdirSync(folder, { recursive: true });
    const written = Object.entries(files).map(([name, data]) => { const path = join(folder, name); writeFileSync(path, data); return { path, bytes: Buffer.byteLength(data) }; });
    return { mock: true, format: kind, folder, files: written, model_changed: false, extra, note: 'Mock export: placeholder files.' };
  }

  'export.pdf'(args = {}) { return this.#exportTo('pdf', { [`${args.name ?? 'Sample Tower'}.pdf`]: '%PDF-1.4\n% mock\n' }, { sheets: (args.sheets ?? SHEETS.map(s => s[0])).length, combined: !args.separate }); }
  'export.dwg'(args = {}) { return this.#exportTo('dwg', { [`${args.name ?? 'Sample Tower'}.dwg`]: 'AC1032 mock' }, { sheets: (args.sheets ?? SHEETS.map(s => s[0])).length }); }
  'export.ifc'(args = {}) { return this.#exportTo('ifc', { [`${args.name ?? 'Sample Tower'}.ifc`]: 'ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n' }, { version: 'IFC4' }); }

  'export.gltf'(args = {}) {
    // A real, valid glTF: one box (30 x 20 x 10.8 m), so a real Blender could render the mock end to end.
    const [w, d, h] = [30, 20, 10.8];
    const corners = [[0, 0, 0], [w, 0, 0], [w, 0, -d], [0, 0, -d], [0, h, 0], [w, h, 0], [w, h, -d], [0, h, -d]];
    const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const positions = Buffer.alloc(corners.length * 12);
    corners.flat().forEach((v, i) => positions.writeFloatLE(v, i * 4));
    const indices = Buffer.alloc(faces.length * 12);
    faces.flat().forEach((v, i) => indices.writeUInt32LE(v, i * 4));
    const name = String(args.name ?? 'scene').replace(/[^\w.-]+/g, '-');
    const gltf = JSON.stringify({
      asset: { version: '2.0', generator: 'revit-mcp mock' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] }],
      materials: [{ name: 'Brick, Common', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.65, 0.31, 0.24, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, -d], max: [w, h, 0] }, { bufferView: 1, componentType: 5125, count: 36, type: 'SCALAR' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 }, { buffer: 0, byteOffset: positions.length, byteLength: indices.length, target: 34963 }],
      buffers: [{ uri: `${name}.bin`, byteLength: positions.length + indices.length }],
    });
    const result = this.#exportTo('gltf', { [`${name}.gltf`]: gltf, [`${name}.bin`]: Buffer.concat([positions, indices]) }, { triangles: 12, materials: 1, metres_y_up: true, notes: [], hidden: args.hide_categories ?? [] });
    result.extra.gltf = result.files.find(f => f.path.endsWith('.gltf')).path;
    return result;
  }

  'schedule.create'(args = {}) {
    if (!(args.category in CATEGORY_TYPES)) throw new BridgeError(`No model category called '${args.category}'. categories.list shows the ones this model uses.`, { code: 'not_found' });
    const available = ['Mark', 'Type', 'Family', 'Level', 'Count', 'Fire Rating', 'Width', 'Height', 'Comments'];
    const fields = (args.fields ?? []).map(f => available.find(a => a.toLowerCase() === String(f).toLowerCase())).filter(Boolean);
    const notFound = (args.fields ?? []).filter(f => !available.some(a => a.toLowerCase() === String(f).toLowerCase()));
    if (!fields.length) throw new BridgeError(`None of the requested fields exist on ${args.category}. Some that do: ${available.join(', ')}.`, { code: 'no_fields' });
    const name = args.name ?? `${args.category} Schedule`;
    const preview = { name, category: args.category, fields, not_found: notFound, available_fields: available };
    if (args.apply !== true) return { mock: true, applied: false, preview, note: 'Preview only. Nothing was created — call again with apply: true to add this schedule.' };
    this.#createdSchedules.push(name);
    return { mock: true, applied: true, schedule_id: 900 + this.#createdSchedules.length, preview, note: 'Created in one transaction; a single Ctrl+Z in Revit removes it.' };
  }

  'parameter.set'(args = {}) {
    const element = this.#find(args.element_id);
    if (!args.parameter) throw new BridgeError("'parameter' is required.", { code: 'bad_request' });
    if (!(args.parameter in element.parameters)) {
      throw new BridgeError(`'${args.parameter}' is not an instance parameter on element ${element.id} (${Object.keys(element.parameters).join(', ')}).`, { code: 'not_found' });
    }
    const oldValue = String(element.parameters[args.parameter] ?? '');
    const newValue = String(args.value ?? '');
    const applied = args.apply === true;
    if (applied) element.parameters[args.parameter] = newValue;
    return {
      element_id: element.id,
      parameter: args.parameter,
      old_value: oldValue,
      new_value: newValue,
      applied,
      note: applied ? 'Applied in one transaction; a single Ctrl+Z in Revit undoes it.' : 'Preview only — call again with apply: true to make the change.',
    };
  }

  #find(id) {
    const element = this.#elements.find(e => e.id === Number(id));
    if (!element) throw new BridgeError(`No element with id ${id} in this model. query_elements returns the ids that exist.`, { code: 'not_found' });
    return element;
  }
}
