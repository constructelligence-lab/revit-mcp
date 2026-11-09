// Camera planning, kept out of the add-in on purpose. The add-in is told an explicit eye and target and
// does exactly that; everything that decides *where a good picture is taken from* lives here, in plain
// JavaScript that runs in CI against the sample model. Coordinates are Revit's, in the document's own
// length unit (scene_info says which), so a client can read a bound and place a camera without converting.

export const PRESETS = [
  'exterior_ne', 'exterior_nw', 'exterior_se', 'exterior_sw',
  'aerial_ne', 'aerial_nw', 'aerial_se', 'aerial_sw',
  'front', 'back', 'left', 'right', 'top', 'interior',
];

export const MOODS = {
  day: { sun: { month: 6, day: 21, hour: 13 }, background: 'clear_sky' },
  morning: { sun: { month: 6, day: 21, hour: 8.5 }, background: 'clear_sky' },
  golden_hour: { sun: { month: 6, day: 21, hour: 19, intensity: 85 }, background: 'few_clouds' },
  overcast: { sun: { month: 6, day: 21, hour: 12, intensity: 25, shadow_intensity: 20 }, background: 'cloudy' },
  winter: { sun: { month: 12, day: 21, hour: 14 }, background: 'few_clouds' },
};

/** How many of the document's length units make a metre, from the unit id Revit reports. */
export function unitsPerMetre(unitId = '') {
  const id = String(unitId).toLowerCase();
  if (id.includes('millimeter')) return 1000;
  if (id.includes('centimeter')) return 100;
  if (id.includes('meter')) return 1;
  if (id.includes('feet') || id.includes('foot')) return 3.280839895; // before inch: 'feetFractionalInches' is feet
  if (id.includes('inch')) return 39.37007874;
  return 1;
}

const round = n => Math.round(n * 100) / 100;
const point = (x, y, z) => [round(x), round(y), round(z)];

const CORNERS = { ne: [1, 1], nw: [-1, 1], se: [1, -1], sw: [-1, -1] };
const SIDES = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] };

function boundsOf(scene) {
  const b = scene?.bounds;
  if (!b?.min || !b?.max) throw Object.assign(new Error('The model reports no bounds (it holds no model elements), so there is nothing to point a camera at.'), { code: 'no_bounds' });
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  return { x0, y0, z0, x1, y1, z1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, dx: x1 - x0, dy: y1 - y0, dz: z1 - z0 };
}

/**
 * Turn a named shot into an explicit camera. Returns { eye, target, perspective, name, sun?, background? }.
 * Nothing here can fail inside Revit: bad input fails here, with a sentence a person can act on.
 */
export function planCamera(scene, input = {}) {
  const preset = input.preset;
  if (!PRESETS.includes(preset)) throw Object.assign(new Error(`Unknown preset '${preset}'. Use one of: ${PRESETS.join(', ')}.`), { code: 'bad_request' });
  const u = unitsPerMetre(scene.units);
  const metre = u;

  if (preset === 'interior') return planInterior(scene, input, u);

  const b = boundsOf(scene);
  const footprint = Math.max(b.dx, b.dy, 1);
  const diag = Math.hypot(b.dx, b.dy, b.dz);
  const lookAt = point(b.cx, b.cy, b.z0 + b.dz * 0.42);

  if (preset in SIDES || preset === 'top') {
    if (preset === 'top') {
      return { name: 'plan-top', eye: point(b.cx, b.cy, b.z1 + diag * 1.4), target: point(b.cx, b.cy, b.z0), perspective: false };
    }
    const [sx, sy] = SIDES[preset];
    const reach = footprint * 1.9 + 8 * metre;
    return {
      name: `elevation-${preset}`,
      eye: point(b.cx + sx * reach, b.cy + sy * reach, b.z0 + Math.min(b.dz * 0.4, 6 * metre) + 1.6 * metre),
      target: lookAt,
      perspective: true,
    };
  }

  const [kind, corner] = preset.split('_');
  const [sx, sy] = CORNERS[corner];
  const aerial = kind === 'aerial';
  const reach = diag * (aerial ? 1.05 : 1.25);
  const height = aerial
    ? b.z1 + diag * 0.75
    : b.z0 + Math.max(b.dz * 0.32, 2.2 * metre);
  // The camera sits on the diagonal so two facades read at once; that is what makes a corner shot look like a building.
  const k = reach / Math.SQRT2;
  return {
    name: `${kind}-${corner}`,
    eye: point(b.cx + sx * k, b.cy + sy * k, height),
    target: lookAt,
    perspective: true,
  };
}

function planInterior(scene, input, u) {
  const rooms = scene.rooms ?? [];
  if (!rooms.length) throw Object.assign(new Error('The model has no placed rooms, so an interior camera has nowhere to stand. Give an explicit eye and target instead.'), { code: 'no_rooms' });
  const want = String(input.room ?? '').toLowerCase().trim();
  const room = want
    ? rooms.find(r => String(r.id) === want || String(r.number ?? '').toLowerCase() === want || String(r.name ?? '').toLowerCase() === want)
      ?? rooms.find(r => String(r.name ?? '').toLowerCase().includes(want))
    : rooms.reduce((best, r) => (r.area_m2 > (best?.area_m2 ?? 0) ? r : best), null);
  if (!room) throw Object.assign(new Error(`No room matches '${input.room}'. scene_info lists the rooms: ${rooms.slice(0, 8).map(r => `${r.number} ${r.name}`).join(', ')}.`), { code: 'not_found' });

  const metre = u;
  const [cx, cy, cz] = room.centre;
  // Rooms report the location point at the room's own level; stand at eye height above the floor.
  const floor = (scene.levels ?? []).find(l => l.name === room.level)?.elevation ?? cz;
  const dirs = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };
  const [dx, dy] = dirs[String(input.look ?? 'north').toLowerCase()] ?? dirs.north;
  // Step back to the opposite wall, roughly: half the room's plan dimension, from its area.
  const half = Math.sqrt(room.area_m2 || 12) / 2 * 0.8 * metre;
  return {
    name: `interior-${String(room.number ?? room.id)}`,
    eye: point(cx - dx * half, cy - dy * half, floor + 1.5 * metre),
    target: point(cx + dx * half, cy + dy * half, floor + 1.3 * metre),
    perspective: true,
    room: { id: room.id, name: room.name, number: room.number },
  };
}

/** The arguments scene.render takes, from a client's input (a preset, or an explicit eye and target) plus the model. */
export function buildRenderArgs(scene, input = {}) {
  const base = {};
  let planned = null;
  if (input.preset) {
    planned = planCamera(scene, input);
    base.eye = planned.eye;
    base.target = planned.target;
    base.perspective = input.perspective ?? planned.perspective;
    base.name = planned.name;
  } else {
    if (!input.eye || !input.target) throw Object.assign(new Error('Give either a preset (' + PRESETS.join(', ') + ') or both eye and target as [x, y, z].'), { code: 'bad_request' });
    base.eye = input.eye;
    base.target = input.target;
    if (input.perspective !== undefined) base.perspective = input.perspective;
    base.name = input.name ?? 'render';
  }

  const mood = input.mood ? MOODS[input.mood] : null;
  if (input.mood && !mood) throw Object.assign(new Error(`Unknown mood '${input.mood}'. Use one of: ${Object.keys(MOODS).join(', ')}.`), { code: 'bad_request' });

  const sun = { ...(mood?.sun ?? {}), ...(input.sun ?? {}) };
  if (Object.keys(sun).length) base.sun = sun;
  const background = input.background ?? mood?.background;
  if (background) base.background = background;
  for (const key of ['style', 'width', 'format', 'outlines', 'hide_categories', 'section_box']) {
    if (input[key] !== undefined) base[key] = input[key];
  }
  if (input.name && planned) base.name = input.name;
  return { args: base, planned };
}

/**
 * Where the sun is, from latitude, longitude, date and local SOLAR time. Standard declination/hour-angle
 * maths, good to a degree or two, which is plenty for a picture and honest about what it is: it ignores
 * time zones, daylight saving and the equation of time, so `hour` means "hours by the sun, noon at 12".
 * Azimuth is compass degrees clockwise from north; elevation is degrees above the horizon.
 */
export function sunPosition(latitude, month, day, hour) {
  const rad = Math.PI / 180;
  const dayOfYear = Math.round((Date.UTC(2001, month - 1, day) - Date.UTC(2001, 0, 0)) / 86400000);
  const declination = 23.44 * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365) * rad;
  const hourAngle = 15 * (hour - 12) * rad;
  const phi = latitude * rad;
  const sinEl = Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const cosEl = Math.cos(elevation) || 1e-9;
  const sinAz = -Math.cos(declination) * Math.sin(hourAngle) / cosEl;
  const cosAz = (Math.sin(declination) - sinEl * Math.sin(phi)) / (cosEl * Math.cos(phi) || 1e-9);
  const azimuth = (Math.atan2(sinAz, cosAz) / rad + 360) % 360;
  return { elevation: Math.round(elevation / rad * 100) / 100, azimuth: Math.round(azimuth * 100) / 100 };
}
