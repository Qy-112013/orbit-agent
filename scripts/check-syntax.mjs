import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const src = join(root, 'src');

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

const files = [...(await collect(src)), join(root, 'public', 'app.js')];
for (const file of files) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--check', file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`syntax check failed: ${file}`)));
  });
}
console.log(`Syntax OK: ${files.length} files`);
