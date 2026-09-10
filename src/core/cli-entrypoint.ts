import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** Bundlers give every imported module the entry module's import.meta.url.
 * Require the intended command name as well, so imported CLIs stay inert. */
export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined, command: string): boolean {
  if (!argvPath || ![".ts", ".js", ".mjs"].some(extension => basename(argvPath) === command + extension)) return false;
  // Node canonicalizes the entry file (e.g. macOS /var -> /private/var).
  return moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
}
