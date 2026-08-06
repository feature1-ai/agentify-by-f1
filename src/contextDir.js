import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONTEXT_DIR = path.join(__dirname, '../resources/contexts');

/**
 * Single source of truth for locating the OpenAPI spec directory.
 * CONTEXT_DIR may be absolute or relative to the process working directory;
 * unset falls back to <app root>/resources/contexts.
 */
export function resolveContextDir() {
  const value = process.env.CONTEXT_DIR;
  if (!value) return DEFAULT_CONTEXT_DIR;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export default resolveContextDir;
