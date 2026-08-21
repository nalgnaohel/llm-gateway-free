#!/usr/bin/env node
// Auto-install the coding CLIs the client agent knows how to drive
// (packages/client/src/cli/adapters.ts), if missing. Safe to re-run: each
// adapter is probed first and left alone if already present.
//
//   node scripts/install-clis.mjs
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { BUILTIN_ADAPTERS } from "../packages/client/src/cli/adapters.ts";

// Adapter id -> npm package that provides its `bin`. The bin name and the
// npm package name differ for opencode, so this can't be derived from the
// adapter alone.
const NPM_PACKAGES = {
  claude: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
};

function probe(adapter) {
  const res = spawnSync(adapter.bin, adapter.versionArgs, {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return res.status === 0;
}

function installOne(adapter) {
  const pkg = NPM_PACKAGES[adapter.id];
  if (!pkg) return "unknown";

  console.log(`installing ${adapter.displayName} (npm install -g ${pkg})...`);
  const res = spawnSync("npm", ["install", "-g", `${pkg}@latest`], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (res.error || res.status !== 0) {
    console.error(`\nfailed to install ${adapter.displayName}.`);
    console.error("  this is usually a permissions issue with npm's global prefix.");
    console.error('  try: npm config set prefix "$HOME/.npm-global" (add it to PATH), then re-run.');
    return "failed";
  }
  return probe(adapter) ? "ok" : "failed";
}

export async function installClis() {
  const results = {};
  for (const adapter of BUILTIN_ADAPTERS) {
    if (probe(adapter)) {
      console.log(`✓ ${adapter.displayName} already installed`);
      results[adapter.id] = "already-installed";
      continue;
    }
    results[adapter.id] = installOne(adapter);
  }
  return results;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const results = await installClis();
  console.log(JSON.stringify(results, null, 2));
  const failed = Object.values(results).some((s) => s === "failed");
  if (failed) process.exitCode = 1;
}
