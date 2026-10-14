// Runs the Blender model builder headless and writes client/public/models/assets.glb.
// Usage: npm run models            (optional: BLENDER_PATH=/path/to/blender, PREVIEW=1)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const candidates = [
  process.env.BLENDER_PATH,
  'blender',
  'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 4.2/blender.exe',
  '/Applications/Blender.app/Contents/MacOS/Blender',
  '/usr/bin/blender',
  '/snap/bin/blender',
].filter(Boolean);

const blender = candidates.find((c) => c === 'blender' ? spawnSync(c, ['--version']).status === 0 : existsSync(c));
if (!blender) {
  console.error('Blender not found. Install Blender 4.2+ or set BLENDER_PATH. (The repo already ships a prebuilt assets.glb.)');
  process.exit(1);
}
const out = path.resolve('client/public/models/assets.glb');
const args = ['--background', '--factory-startup', '--python', 'tools/blender/build_models.py', '--', out];
if (process.env.PREVIEW) args.push(path.resolve('tools/blender/preview.png'));
console.log(`Using ${blender}`);
const r = spawnSync(blender, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
