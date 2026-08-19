/**
 * Restore the executable bit on scripts/*.sh.
 *
 * Git preserves the mode, but copying the tree by other means (an archive, a
 * file-sync tool, a Windows checkout) does not — and then `./scripts/run.sh`
 * fails with "Permission denied". `npm run start` works either way, but people
 * reasonably reach for the script path first, so fix it at install time.
 */
import { chmodSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sh")) continue;
    const file = join(dir, name);
    try {
      // Keep whatever bits are set, just add execute where read is allowed.
      const mode = statSync(file).mode;
      chmodSync(file, mode | 0o111);
    } catch {
      // Read-only checkout or an odd filesystem — `npm run start` still works.
    }
  }
}
