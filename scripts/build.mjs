#!/usr/bin/env node
/**
 * Build, then make every declared `bin` executable.
 *
 * `tsc` emits 0644 regardless of the shebang, so a package with a `bin` produces
 * a file nobody can execute. That matters here specifically because the Claude
 * and Gemini profiles invoke `strata-ctx` by absolute path
 * (`integrations/src/hook-builder.ts`), which needs the executable bit and not
 * merely a `node <path>` invocation.
 *
 * This lives in a script rather than an npm `postbuild` because the gate does
 * not go through `npm run build`: `check` calls `tsc --build` directly via
 * `typecheck`, and an npm lifecycle hook only fires for its own script name.
 * A `postbuild` hook therefore passes CI while leaving every clean clone broken,
 * which is worse than having no hook at all.
 *
 * The bins are read from the manifests rather than hardcoded, so a second
 * package gaining a `bin` is covered without editing this file.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tsc = spawnSync('tsc', ['--build'], { cwd: root, stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const missing = [];
const chmodded = [];

for (const entry of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(root, 'packages', entry.name, 'package.json');
  if (!existsSync(manifestPath)) continue;

  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!bin) continue;

  // A string `bin` is the package's own entry point; the object form is a map
  // of command name to path and every value in it is an entry point.
  const targets = typeof bin === 'string' ? [bin] : Object.values(bin);

  for (const target of targets) {
    const file = path.join(root, 'packages', entry.name, target);
    // A missing bin is a real failure: the build claims success while shipping
    // nothing executable. Failing here is what keeps the gate honest.
    if (!existsSync(file)) {
      missing.push(path.relative(root, file));
      continue;
    }
    chmodSync(file, 0o755);
    chmodded.push(path.relative(root, file));
  }
}

if (missing.length > 0) {
  console.error(`build: declared bin(s) absent after tsc: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`build: executable ${chmodded.length} bin(s): ${chmodded.join(', ')}`);
