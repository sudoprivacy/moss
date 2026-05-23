#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function normalizeVersion(value) {
  return value.replace(/^refs\/tags\//, '').replace(/^v/, '').trim();
}

const rawVersion = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
const version = normalizeVersion(rawVersion);

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Expected a semver tag or version, got: ${rawVersion || '(empty)'}`);
  process.exit(1);
}

const targets = [
  resolve('ui', 'package.json'),
  resolve('ui', 'package-lock.json'),
];

for (const target of targets) {
  if (!existsSync(target)) continue;

  const parsed = JSON.parse(readFileSync(target, 'utf8'));
  parsed.version = version;

  if (target.endsWith('package-lock.json') && parsed.packages?.['']) {
    parsed.packages[''].version = version;
  }

  writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(`Synced ${target} -> ${version}`);
}
