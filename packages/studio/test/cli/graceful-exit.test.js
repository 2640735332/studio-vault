import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('both CLI entrypoints drain pending cleanup and output on success and failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'cleanup.mjs');
  fs.writeFileSync(preload, `process.once('beforeExit', () => {
    setImmediate(() => process.stdout.write('CLEANUP-DRAINED\\n'));
  });`);
  for (const relative of ['../../../cli/bin/studio-cli.js', '../../bin/studio.js']) {
    const bin = fileURLToPath(new URL(relative, import.meta.url));
    for (const args of [['--version'], ['unknown-command-for-exit-test']]) {
      const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, bin, ...args], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
      assert.equal(run.error, undefined);
      assert.equal(run.signal, null);
      assert.equal(run.status === 0, args[0] === '--version', run.stderr);
      assert.match(run.stdout, /CLEANUP-DRAINED/, `${relative} ${args[0]}`);
      assert.doesNotMatch(run.stderr, /Assertion failed|UV_HANDLE_CLOSING/);
    }
  }
});
