'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
require('./release-check.cjs').clearEvidence(root);
const checks = [
  ['--check', 'main.js'],
  ['--test', 'test-behavior.cjs', 'file-explorer-test.cjs', 'paste-behavior-test.cjs', 'title-limits.test.cjs', 'network-lifecycle.test.cjs', 'scripts/release-check.test.cjs'],
  ['cm-state-regression.cjs'],
];

for (const args of checks) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.signal) console.error(`Check terminated by ${result.signal}`);
    process.exit(result.status || 1);
  }
}
