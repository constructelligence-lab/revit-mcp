// The hand-off to Blender. Revit's API cannot start its own ray tracer, so the add-in exports the geometry
// (glTF) and Blender's Cycles makes the picture on the same machine. Nothing here talks to a network:
// the model goes from Revit's temp folder to a local Blender process and an image comes back.
//
// What is in this file is deliberately testable without Blender: finding it, building the job description
// (sun from latitude and date, camera in metres, quality presets), and the Python that runs inside it.
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { sunPosition, unitsPerMetre, MOODS } from './camera.mjs';

export const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'blender', 'render.py');

export const QUALITY = {
  draft: { samples: 48, denoise: true, note: 'about a minute on a laptop CPU' },
  standard: { samples: 160, denoise: true, note: 'a few minutes on CPU, seconds on a GPU' },
  final: { samples: 512, denoise: true, note: 'slow on CPU; use a GPU' },
};

/** Where Blender lives: BLENDER_PATH, then PATH, then the places the installers put it. Null when there is none. */
export function findBlender(env = process.env, exists = existsSync) {
  const candidates = [];
  if (env.BLENDER_PATH) candidates.push(env.BLENDER_PATH);
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    candidates.push(join(dir, 'blender'), join(dir, 'blender.exe'));
  }
  candidates.push(
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/bin/blender', '/snap/bin/blender', '/usr/local/bin/blender',
  );
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files']) {
    if (!root) continue;
    for (const version of ['5.0', '4.5', '4.4', '4.3', '4.2', '4.1', '4.0', '3.6']) candidates.push(join(root, 'Blender Foundation', `Blender ${version}`, 'blender.exe'));
  }
  return candidates.find(path => path && exists(path)) ?? null;
}

export const BLENDER_MISSING = 'Blender was not found. Install it (free, blender.org) or set BLENDER_PATH to the blender executable; it renders on this machine, so nothing is uploaded.';

/**
 * The job Blender receives, as plain data: the glTF, the camera in METRES (Revit coordinates, Z up), the sun
 * from the model's real latitude, and the look. Eye and target arrive in the document's own unit.
 */
export function buildJob({ gltf, scene, camera, mood, sun, quality = 'standard', width = 1920, aspect = 16 / 9, ground = 'grass', exposure = 0, vignette = true, bloom = true, gpu = false, output, turntable = null, seed = 1 }) {
  const perMetre = unitsPerMetre(scene?.units);
  const metres = v => v.map(n => Math.round(n / perMetre * 1000) / 1000);
  const q = QUALITY[quality];
  if (!q) throw Object.assign(new Error(`Unknown quality '${quality}'. Use draft, standard or final.`), { code: 'bad_request' });

  const moodSun = MOODS[mood]?.sun ?? {};
  const merged = { month: 6, day: 21, hour: 15, ...moodSun, ...(sun ?? {}) };
  const latitude = scene?.site?.latitude ?? 53;
  const position = sunPosition(latitude, merged.month, merged.day, merged.hour);
  const intensity = (merged.intensity ?? 100) / 100;

  return {
    gltf,
    output,
    width: Math.round(width),
    height: Math.round(width / aspect),
    samples: q.samples,
    denoise: q.denoise,
    seed,
    gpu,
    camera: { eye: metres(camera.eye), target: metres(camera.target), lens_mm: camera.lens_mm ?? 28 },
    sun: { elevation: position.elevation, azimuth: position.azimuth, strength: Math.round(3.2 * intensity * 100) / 100, month: merged.month, day: merged.day, hour: merged.hour, latitude },
    overcast: mood === 'overcast',
    ground,
    exposure,
    vignette,
    bloom,
    turntable,
  };
}

/** Run Blender headless on a job. The spawn function is injectable so tests need no Blender. */
export function runBlender({ exe, job, scriptPath = SCRIPT, workDir = join(tmpdir(), 'revit-mcp'), timeoutMs = 30 * 60 * 1000, spawnImpl = spawn }) {
  mkdirSync(workDir, { recursive: true });
  const jobPath = join(workDir, `blender-job-${Date.now()}.json`);
  writeFileSync(jobPath, JSON.stringify(job, null, 2));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(exe, ['-b', '--factory-startup', '--python', scriptPath, '--', jobPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error(`Blender did not finish in ${Math.round(timeoutMs / 60000)} minutes. Try quality "draft", a smaller width, or a GPU.`), { code: 'timeout' })); }, timeoutMs);
    child.stdout?.on('data', d => { out = (out + d).slice(-8000); });
    child.stderr?.on('data', d => { out = (out + d).slice(-8000); });
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(new Error(`Could not start Blender: ${error.message}`), { code: 'blender_failed' })); });
    child.on('close', code => {
      clearTimeout(timer);
      const marker = out.split('\n').find(line => line.startsWith('REVITMCP_RESULT '));
      if (code === 0 && marker) resolve({ ...JSON.parse(marker.slice('REVITMCP_RESULT '.length)), job: jobPath });
      else reject(Object.assign(new Error(`Blender exited with code ${code}. Last output:\n${out.slice(-1500)}`), { code: 'blender_failed' }));
    });
  });
}

/** An mp4 from a frame sequence, if ffmpeg is installed. Null otherwise: the frames are the deliverable. */
export function encodeMp4({ framesDir, fps = 24, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', spawnImpl = spawn }) {
  const output = join(framesDir, 'turntable.mp4');
  return new Promise(resolve => {
    const child = spawnImpl(ffmpeg, ['-y', '-framerate', String(fps), '-i', join(framesDir, 'frame_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output], { stdio: 'ignore' });
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code === 0 ? output : null));
  });
}
