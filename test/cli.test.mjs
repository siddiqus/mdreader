import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start } from '../server.mjs';

const BIN = fileURLToPath(new URL('../bin/mdr.mjs', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-cli-')));
fs.writeFileSync(path.join(root, 'note.md'), '# Hello CLI');

const occupy = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => resolve(s));
});

test('start moves to the next port when the default is taken', async t => {
  const blocker = await occupy();
  const taken = blocker.address().port;
  const { server, url } = await start({ root, port: taken });
  t.after(() => { server.close(); blocker.close(); });
  assert.equal(url, `http://127.0.0.1:${taken + 1}`);
  const html = await (await fetch(`${url}/view/note.md`)).text();
  assert.match(html, /Hello CLI/);
});

test('start with strictPort fails instead of moving', async t => {
  const blocker = await occupy();
  t.after(() => blocker.close());
  const started = start({ root, port: blocker.address().port, strictPort: true });
  started.then(({ server }) => server.close(), () => {});
  await assert.rejects(started, { code: 'EADDRINUSE' });
});

function runCli(args) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const urlLine = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { const m = out.match(/http:\/\/\S+/); if (m) resolve(m[0]); });
    child.on('exit', () => reject(new Error(out)));
  });
  urlLine.catch(() => {});
  return { child, exited, urlLine, output: () => out };
}

test('mdr <file> serves its folder and prints the file URL', async t => {
  const { child, urlLine } = runCli([path.join(root, 'note.md'), '--no-open', '--port', '0']);
  t.after(() => child.kill());
  const url = await urlLine;
  assert.match(url, /\/view\/note\.md$/);
  assert.match(await (await fetch(url)).text(), /Hello CLI/);
});

test('mdr rejects a missing path', async () => {
  const { exited, output } = runCli([path.join(root, 'nope'), '--no-open']);
  assert.equal(await exited, 1);
  assert.match(output(), /no such file or folder/);
});
