import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function denied(message: string): Error {
  return Object.assign(new Error(message), { code: 'WORKSPACE_PATH_DENIED' });
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !(isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`));
}

/** Secrets never flow to models: `.env` and `.env.*` (except the documented template) are off limits. */
export function isSecretFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
}

/**
 * Resolves a workspace path, following links, and rejects anything outside the
 * root, secret files, and (for writes) `.git/` or explicitly protected directories.
 * Targets that do not exist yet are checked through their nearest existing parent.
 */
export async function resolveWorkspacePath(workspaceRoot: string, requested = '.', { write = false, protectedDirs = [] }: { write?: boolean; protectedDirs?: string[] } = {}): Promise<string> {
  const root = await realpath(resolve(workspaceRoot));
  const candidate = resolve(root, requested);
  if (!inside(root, candidate)) throw denied('workspace path escapes the configured root');
  let existing = candidate;
  let missing = '';
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT' || !write) throw error;
      missing = missing ? `${basename(existing)}${sep}${missing}` : basename(existing);
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  const resolved = missing ? resolve(existing, missing) : existing;
  if (!inside(root, resolved)) throw denied('workspace link escapes the configured root');
  if (isSecretFile(resolved)) throw denied('secret files (.env) are not accessible to agents');
  if (write) {
    const segments = relative(root, resolved).split(sep).map((segment) => segment.toLowerCase());
    if (segments.includes('.git')) throw denied('writing inside .git is not allowed');
    for (const directory of protectedDirs) {
      const protectedPath = await realpath(directory).catch(() => resolve(directory));
      if (inside(protectedPath, resolved)) throw denied('writing inside Orbit data is not allowed');
    }
    if (missing === '' && (await stat(resolved)).isDirectory()) throw denied('target is a directory');
  }
  return resolved;
}
