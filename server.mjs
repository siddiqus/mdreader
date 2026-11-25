import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Marked } from 'marked';
import hljs from 'highlight.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(process.env.MDR_ROOT || path.join(HERE, '..', 'repos'));
const PORT = Number(process.env.MDR_PORT || 7780);
const HOST = process.env.MDR_HOST || '127.0.0.1';
const REINDEX_MS = 10 * 60 * 1000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.pnpm-store', '.worktrees', '.baton', '.venv', 'venv', '.tox',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.next', '.nuxt', '.cache', '.turbo',
  'dist', 'build', 'coverage', '.gradle', '.idea', 'bower_components', '.yarn',
]);
const MD_EXT = new Set(['.md', '.markdown', '.mdx']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
};

const isMd = p => MD_EXT.has(path.extname(p).toLowerCase());
const skipDir = (name, parentRel) =>
  SKIP_DIRS.has(name) || (name === 'worktrees' && path.basename(parentRel) === '.claude');

export const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const encPath = rel => rel.split('/').map(encodeURIComponent).join('/');

export function safeResolve(root, rel) {
  const abs = path.resolve(root, '.' + path.sep + (rel || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  let real;
  try { real = fs.realpathSync(abs); } catch { return null; }
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  return abs;
}

// ---------- filename index ----------
let index = [];
let indexedAt = 0;
let indexing = null;
let mdDirs = new Set();

/** Every folder (relative path) that has a markdown file somewhere below it. */
export function foldersWithMarkdown(list) {
  const set = new Set();
  for (const f of list) {
    if (!f.md) continue;
    let i = f.p.lastIndexOf('/');
    while (i > 0) {
      const d = f.p.slice(0, i);
      if (set.has(d)) break;
      set.add(d);
      i = d.lastIndexOf('/');
    }
  }
  return set;
}

async function walk(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let dir;
    try { dir = await fsp.opendir(path.join(root, rel)); } catch { continue; }
    for await (const d of dir) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!skipDir(d.name, rel)) stack.push(childRel);
      } else if (d.isFile()) {
        out.push({ p: childRel, lower: childRel.toLowerCase(), base: d.name.toLowerCase(), md: isMd(d.name) });
      }
    }
  }
  return out;
}

function reindex() {
  if (!indexing) {
    const t = Date.now();
    indexing = walk(ROOT).then(list => {
      index = list;
      mdDirs = foldersWithMarkdown(list);
      indexedAt = Date.now();
      console.log(`indexed ${list.length} files in ${Date.now() - t}ms`);
    }).catch(err => console.error('index failed', err)).finally(() => { indexing = null; });
  }
  return indexing;
}

function subsequenceSpan(hay, needle) {
  let i = 0;
  let start = -1;
  for (let j = 0; j < hay.length; j++) {
    if (hay[j] !== needle[i]) continue;
    if (start < 0) start = j;
    if (++i === needle.length) return j - start + 1;
  }
  return -1;
}

export function search(list, query, { mdOnly = true, limit = 100 } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const hits = [];
  for (const f of list) {
    if (mdOnly && !f.md) continue;
    let gaps = 0;
    let fuzzy = false;
    for (const t of terms) {
      if (f.lower.includes(t)) continue;
      const span = subsequenceSpan(f.base, t);
      if (span < 0) { gaps = -1; break; }
      fuzzy = true;
      gaps += span - t.length;
    }
    if (gaps < 0) continue;
    let score = fuzzy ? -30 - gaps : 0;
    const stem = f.base.replace(/\.[^.]+$/, '');
    if (stem === q || f.base === q) score += 100;
    else if (f.base.startsWith(q)) score += 60;
    else if (f.base.includes(q)) score += 40;
    score += terms.filter(t => f.base.includes(t)).length * 10;
    score -= f.p.split('/').length * 2 + f.p.length / 50;
    hits.push({ f, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map(h => h.f.p);
}

// ---------- markdown ----------
const HIGHLIGHT_MAX_CHARS = 300_000;

export function highlight(text, lang) {
  if (lang && text.length <= HIGHLIGHT_MAX_CHARS && hljs.getLanguage(lang)) {
    const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    return `<code class="hljs language-${esc(lang)}">${html}</code>`;
  }
  return `<code>${esc(text)}</code>`;
}

const slug = s => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

export function renderMarkdown(src, fileRel) {
  const dir = path.posix.dirname(fileRel);
  const rewrite = (href, kind) => {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return href;
    const [p, frag] = href.split('#');
    const target = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, decodeURIComponent(p)));
    if (target.startsWith('..')) return href;
    if (kind === 'image') return `/raw/${encPath(target)}`;
    return `/view/${encPath(target)}${frag ? '#' + frag : ''}`;
  };
  const seen = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(t) {
      if (t.type === 'link') t.href = rewrite(t.href, 'link');
      if (t.type === 'image') t.href = rewrite(t.href, 'image');
    },
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        let id = slug(html) || 'section';
        const n = seen.get(id) || 0;
        seen.set(id, n + 1);
        if (n) id += `-${n}`;
        return `<h${depth} id="${esc(id)}"><a class="anchor" href="#${esc(id)}">#</a>${html}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const l = (lang || '').trim().split(/\s+/)[0].toLowerCase();
        if (l === 'mermaid') return `<pre class="mermaid">${esc(text)}</pre>\n`;
        return `<pre>${highlight(text, l)}</pre>\n`;
      },
      blockquote({ tokens }) {
        const body = this.parser.parse(tokens);
        const m = body.match(/^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i);
        if (!m) return `<blockquote>\n${body}</blockquote>\n`;
        const kind = m[1].toLowerCase();
        const rest = `<p>${body.slice(m[0].length)}`.replace(/^<p>\s*<\/p>\n?/, '');
        return `<div class="alert alert-${kind}"><p class="alert-title">${kind[0].toUpperCase()}${kind.slice(1)}</p>${rest}</div>\n`;
      },
      table({ header, rows }) {
        const heads = header.map(c => this.parser.parseInline(c.tokens));
        const labels = heads.map(h => esc(h.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').trim()));
        const align = c => (c.align ? ` style="text-align:${c.align}"` : '');
        const th = header.map((c, i) => `<th${align(c)}>${heads[i]}</th>`).join('');
        const trs = rows.map(r => `<tr>${r.map((c, i) =>
          `<td data-label="${labels[i] || ''}"${align(c)}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('\n');
        return `<div class="tbl"><button type="button" class="tbl-toggle" aria-label="Switch table layout">⇄</button>`
          + `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>\n`;
      },
    },
  });
  return marked.parse(src);
}

// ---------- pages ----------
function crumbs(rel) {
  const parts = rel ? rel.split('/') : [];
  let acc = '';
  const links = [`<a href="/browse/">${esc(path.basename(ROOT))}</a>`];
  parts.forEach((part, i) => {
    acc = acc ? `${acc}/${part}` : part;
    links.push(i === parts.length - 1 ? `<span>${esc(part)}</span>` : `<a href="/browse/${encPath(acc)}">${esc(part)}</a>`);
  });
  return `<nav class="crumbs">${links.join('<i>/</i>')}</nav>`;
}

const reqCtx = new AsyncLocalStorage();
const FS_NAMES = { s: 'Small', m: 'Medium', l: 'Large' };

function page({ title, body, readable = false }) {
  const { sideClosed, fs = 'm' } = reqCtx.getStore() || {};
  return `<!doctype html><html lang="en" class="fs-${fs}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/static/icon-192.png">
<link rel="apple-touch-icon" href="/static/icon-192.png">
<title>${esc(title)}</title><link rel="stylesheet" href="/static/style.css"><link rel="stylesheet" href="/vendor/hljs.css"></head>
<body class="${sideClosed ? 'side-closed' : 'side-open'}"><header class="top"><div class="bar">
<div class="bar-side"><button type="button" class="side-toggle" aria-label="Toggle file tree" aria-controls="side">☰</button>
<a class="home" href="/browse/" aria-label="Home">⌂</a></div>
<div class="bar-main"><a class="find" href="/search" role="button" aria-keyshortcuts="Meta+K Control+K"><span class="find-ic" aria-hidden="true">⌕</span><span class="find-tx">Search files…</span><kbd class="find-kbd">⌘K</kbd></a>${readable ? '<button type="button" class="read-btn" aria-label="Reading mode" title="Reading mode (R)" aria-keyshortcuts="R"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 6.5C10 5 7 4.5 3 5v13c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5Zm0 0V19.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span class="read-tx">Read</span></button>' : ''}</div>
</div></header>
<div class="layout"><aside class="side" id="side" aria-label="File tree">
<div class="side-tools"><span class="side-title">${esc(path.basename(ROOT))}</span>
<button type="button" data-act="md" class="t-md" aria-pressed="true" title="Markdown only">.md</button>
<button type="button" data-act="fs" class="t-fs" title="Text size: ${FS_NAMES[fs]} (click to change)" aria-label="Text size: ${FS_NAMES[fs]}"><span class="a1">A</span><span class="a2">A</span><small>${fs.toUpperCase()}</small></button>
<button type="button" data-act="reveal" title="Reveal current file">◎</button>
<button type="button" data-act="collapse" title="Collapse all">⊟</button>
<button type="button" data-act="close" class="t-close" title="Close" aria-label="Close file tree">✕</button></div>
<nav class="tree" role="tree"></nav></aside>
<main>${body}</main></div><div class="side-scrim"></div>
<script src="/static/app.js" defer></script>${readable ? '<script src="/static/reader.js" defer></script>' : ''}</body></html>`;
}

const ago = ms => {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return new Date(ms).toISOString().slice(0, 10);
};

export async function listDir(root, rel, abs, { mtimes = false } = {}) {
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const dirs = [];
  const files = [];
  await Promise.all(entries.map(async e => {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      const target = safeResolve(root, childRel);
      if (!target) return;
      try { isDir = (await fsp.stat(target)).isDirectory(); } catch { return; }
    }
    if (isDir) {
      if (!skipDir(e.name, rel)) dirs.push({ name: e.name, rel: childRel });
    } else {
      let mtime = 0;
      if (mtimes) try { mtime = (await fsp.stat(path.join(abs, e.name))).mtimeMs; } catch {}
      files.push({ name: e.name, rel: childRel, mtime, md: isMd(e.name) });
    }
  }));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  dirs.sort(byName);
  files.sort((a, b) => (b.md - a.md) || byName(a, b));
  return { dirs, files };
}

async function browsePage(rel, abs) {
  const { dirs, files } = await listDir(ROOT, rel, abs, { mtimes: true });
  const readme = files.find(f => /^readme\.md$/i.test(f.name));
  const rows = [
    ...dirs.map(d => `<li><a class="row dir" href="/browse/${encPath(d.rel)}"><span class="ic">▸</span><span class="nm">${esc(d.name)}</span></a></li>`),
    ...files.map(f => `<li><a class="row ${f.md ? 'md' : 'file'}" href="/view/${encPath(f.rel)}"><span class="ic">${f.md ? '¶' : '·'}</span><span class="nm">${esc(f.name)}</span><span class="tm">${f.mtime ? ago(f.mtime) : ''}</span></a></li>`),
  ];
  let readmeHtml = '';
  if (readme) {
    try {
      const src = await fsp.readFile(path.join(abs, readme.name), 'utf8');
      readmeHtml = `<article class="md readme"><div class="readme-h">${esc(readme.name)}</div>${renderMarkdown(src, readme.rel)}</article>`;
    } catch {}
  }
  return page({
    title: rel || path.basename(ROOT),
    body: `${crumbs(rel)}<ul class="list">${rows.join('') || '<li class="empty">Empty folder</li>'}</ul>${readmeHtml}`,
  });
}

async function viewPage(rel, abs) {
  const st = await fsp.stat(abs);
  const head = `${crumbs(rel)}<div class="meta">${(st.size / 1024).toFixed(1)} KB · modified ${ago(st.mtimeMs)}${isMd(rel) ? ` · <a href="/view/${encPath(rel)}?src=1">source</a>` : ''}</div>`;
  if (st.size > MAX_TEXT_BYTES) {
    return page({ title: rel, body: `${head}<p class="note">Too large to display. <a href="/raw/${encPath(rel)}">Open raw</a></p>` });
  }
  const buf = await fsp.readFile(abs);
  const ext = path.extname(rel).toLowerCase();
  if (MIME[ext]?.startsWith('image/')) {
    return page({ title: rel, body: `${head}<p><img class="preview" src="/raw/${encPath(rel)}" alt="${esc(path.basename(rel))}"></p>` });
  }
  if (buf.subarray(0, 8000).includes(0)) {
    return page({ title: rel, body: `${head}<p class="note">Binary file. <a href="/raw/${encPath(rel)}">Open raw</a></p>` });
  }
  return { rel, head, text: buf.toString('utf8') };
}

// ---------- server ----------
const CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'none'";

const acceptsGzip = res => /\bgzip\b/.test(String(res.req?.headers['accept-encoding'] ?? ''));

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  const headers = { 'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra };
  if (body && body.length > 1024 && /^(text\/|application\/(manifest\+)?json)/.test(type) && acceptsGzip(res)) {
    body = zlib.gzipSync(body);
    Object.assign(headers, { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  }
  res.writeHead(status, headers);
  res.end(body);
}

let hljsCss = null;
function highlightCss() {
  if (!hljsCss) {
    const styles = path.join(HERE, 'node_modules', 'highlight.js', 'styles');
    const light = fs.readFileSync(path.join(styles, 'github.min.css'), 'utf8');
    const dark = fs.readFileSync(path.join(styles, 'github-dark.min.css'), 'utf8');
    hljsCss = `@media (prefers-color-scheme: light){${light}}\n@media (prefers-color-scheme: dark){${dark}}\n`
      + '.hljs{background:transparent!important;padding:0!important}\n';
  }
  return hljsCss;
}

let mermaidGz = null;
const VENDOR_CACHE = { 'Cache-Control': 'public, max-age=604800' };

const notFound = res => send(res, 404, page({ title: 'Not found', body: '<p class="note">Not found.</p>' }));

function searchResults(q, mdOnly) {
  const hits = search(index, q, { mdOnly });
  if (!hits.length) return `<p class="note">No ${mdOnly ? 'markdown ' : ''}files match “${esc(q)}”.${indexing && !index.length ? ' Indexing…' : ''}</p>`;
  return `<ul class="list results">${hits.map(p => {
    const i = p.lastIndexOf('/');
    return `<li><a class="row ${isMd(p) ? 'md' : 'file'}" href="/view/${encPath(p)}"><span class="ic">${isMd(p) ? '¶' : '·'}</span><span class="nm">${esc(p.slice(i + 1))}<small>${esc(i > 0 ? p.slice(0, i) : '')}</small></span></a></li>`;
  }).join('')}</ul>`;
}

export function handle(req, res) {
  const sideClosed = /(?:^|;\s*)mdr-side=0(?:;|$)/.test(req.headers.cookie || '');
  const fs = (req.headers.cookie || '').match(/(?:^|;\s*)mdr-fs=([sml])(?:;|$)/)?.[1] || 'm';
  return reqCtx.run({ sideClosed, fs }, () => dispatch(req, res));
}

const MAX_TREE_DIRS = 500;

async function dispatch(req, res) {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;
  try {
    if (route === '/' ) return send(res, 302, '', 'text/plain', { Location: '/browse/' });
    if (route === '/manifest.webmanifest' || route === '/sw.js') {
      const file = path.join(HERE, 'public', route.slice(1));
      const type = route === '/sw.js' ? MIME['.js'] : 'application/manifest+json';
      return send(res, 200, await fsp.readFile(file), type, { 'Cache-Control': 'no-cache' });
    }
    if (route === '/vendor/hljs.css') return send(res, 200, highlightCss(), MIME['.css'], VENDOR_CACHE);
    if (route === '/vendor/mermaid.min.js') {
      mermaidGz ??= zlib.gzipSync(await fsp.readFile(path.join(HERE, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')));
      if (acceptsGzip(res)) {
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ...VENDOR_CACHE });
        return res.end(mermaidGz);
      }
      return send(res, 200, zlib.gunzipSync(mermaidGz), MIME['.js'], VENDOR_CACHE);
    }
    if (route.startsWith('/static/')) {
      const name = path.basename(route);
      const file = path.join(HERE, 'public', name);
      if (!fs.existsSync(file)) return notFound(res);
      return send(res, 200, await fsp.readFile(file), MIME[path.extname(name)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
    }
    if (route === '/search') {
      const q = url.searchParams.get('q') || '';
      const mdOnly = url.searchParams.getAll('md')[0] !== '0';
      if (!index.length) await reindex();
      if (url.searchParams.get('json')) {
        const results = q.trim() ? search(index, q, { mdOnly, limit: 200 }) : [];
        return send(res, 200, JSON.stringify({ results, indexed: index.length }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
      }
      const form = `<form class="search-page" action="/search" method="get" role="search">
<input type="search" name="q" value="${esc(q)}" placeholder="Search file names…" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus>
<label class="mdonly"><input type="checkbox" name="md" value="1"${mdOnly ? ' checked' : ''}>.md only</label><input type="hidden" name="md" value="0"></form>`;
      return send(res, 200, page({ title: q ? `Search: ${q}` : 'Search', body: `${form}${q.trim() ? `<div class="meta">Index: ${index.length} files, ${indexedAt ? ago(indexedAt) : '…'} ago · <a href="/reindex">refresh</a></div>${searchResults(q, mdOnly)}` : ''}` }));
    }
    if (route === '/tree') {
      const listings = {};
      await Promise.all(url.searchParams.getAll('d').slice(0, MAX_TREE_DIRS).map(async raw => {
        const rel = raw.replace(/^\/+|\/+$/g, '');
        const abs = safeResolve(ROOT, rel);
        if (!abs) return;
        try {
          const { dirs, files } = await listDir(ROOT, rel, abs);
          listings[rel] = { d: dirs.map(d => [d.name, mdDirs.has(d.rel) ? 1 : 0]), f: files.map(f => [f.name, f.md ? 1 : 0]) };
        } catch {}
      }));
      return send(res, 200, JSON.stringify({ ready: indexedAt > 0, listings }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    if (route === '/reindex') {
      await reindex();
      return send(res, 302, '', 'text/plain', { Location: req.headers.referer && new URL(req.headers.referer).pathname === '/search' ? req.headers.referer : '/browse/' });
    }
    const m = route.match(/^\/(browse|view|raw)\/?(.*)$/);
    if (!m) return notFound(res);
    const rel = decodeURIComponent(m[2]).replace(/\/+$/, '');
    const abs = safeResolve(ROOT, rel);
    if (!abs) return notFound(res);
    const st = await fsp.stat(abs);
    if (m[1] === 'browse' || st.isDirectory()) {
      if (!st.isDirectory()) return send(res, 302, '', 'text/plain', { Location: `/view/${encPath(rel)}` });
      return send(res, 200, await browsePage(rel, abs));
    }
    if (m[1] === 'raw') {
      const type = MIME[path.extname(rel).toLowerCase()] || 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff', 'Content-Length': st.size });
      return fs.createReadStream(abs).pipe(res);
    }
    const v = await viewPage(rel, abs);
    if (typeof v === 'string') return send(res, 200, v);
    const asSource = !isMd(rel) || url.searchParams.get('src');
    const body = asSource
      ? `${v.head}<pre class="src">${highlight(v.text, isMd(rel) ? 'markdown' : (path.extname(rel).slice(1) || path.basename(rel)).toLowerCase())}</pre>`
      : `${v.head}<article class="md">${renderMarkdown(v.text, rel)}</article>`;
    return send(res, 200, page({ title: path.basename(rel), body, readable: !asSource }));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return notFound(res);
    console.error(req.url, err);
    return send(res, 500, page({ title: 'Error', body: `<p class="note">Error: ${esc(err.message)}</p>` }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  http.createServer(handle).listen(PORT, HOST, () => {
    console.log(`mdreader serving ${ROOT} on http://${HOST}:${PORT}`);
    reindex();
    setInterval(reindex, REINDEX_MS).unref();
  });
}
