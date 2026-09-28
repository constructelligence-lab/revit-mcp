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
import { BridgeError } from './bridge.mjs';

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
