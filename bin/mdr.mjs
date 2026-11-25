#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { start, DEFAULT_PORT } from '../server.mjs';

const USAGE = `Usage: mdr [folder-or-file] [options]

Serves a folder of markdown as a browsable site and opens it in your browser.
Pass a file to open it directly (its folder becomes the root).

Options:
  -p, --port <n>   port (default ${DEFAULT_PORT}, next free one if taken)
  -H, --host <h>   interface to bind (default 127.0.0.1)
      --no-open    don't open a browser
  -h, --help       show this help
  -v, --version    show version`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (err) {
  console.error(`mdr: ${err.message}\n\n${USAGE}`);
  process.exit(2);
}
const { values, positionals } = args;

if (values.help) { console.log(USAGE); process.exit(0); }
if (values.version) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
if (positionals.length > 1) { console.error(`mdr: expected one path\n\n${USAGE}`); process.exit(2); }

const target = path.resolve(positionals[0] ?? '.');
let stat;
try { stat = fs.statSync(target); } catch {
  console.error(`mdr: no such file or folder: ${target}`);
  process.exit(1);
}
const port = values.port ? Number(values.port) : undefined;
if (values.port && !(Number.isInteger(port) && port >= 0 && port < 65536)) {
  console.error(`mdr: invalid port: ${values.port}`);
  process.exit(2);
}

let started;
try {
  started = await start({
    root: stat.isDirectory() ? target : path.dirname(target),
    port,
    host: values.host,
    strictPort: port !== undefined,
  });
} catch (err) {
  console.error(`mdr: ${err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message}`);
  process.exit(1);
}

const page = stat.isDirectory()
  ? `${started.url}/browse/`
  : `${started.url}/view/${encodeURIComponent(path.basename(target))}`;
console.log(`mdreader serving ${started.root}\n  ${page}\n(Ctrl+C to stop)`);

if (!values['no-open']) {
  const [cmd, ...cmdArgs] = process.platform === 'darwin' ? ['open', page]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', page]
    : ['xdg-open', page];
  spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true })
    .on('error', () => console.log('Could not open a browser; visit the URL above.'))
    .unref();
}
