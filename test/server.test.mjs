import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeResolve, renderMarkdown, search, highlight, foldersWithMarkdown, listDir } from '../server.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-')));
fs.mkdirSync(path.join(root, 'docs'));
fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# a');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-out-'));
fs.symlinkSync(outside, path.join(root, 'escape'));

test('safeResolve stays inside root', () => {
  assert.equal(safeResolve(root, 'docs/a.md'), path.join(root, 'docs', 'a.md'));
  assert.equal(safeResolve(root, ''), root);
  assert.equal(safeResolve(root, '../etc/passwd'), null);
  assert.equal(safeResolve(root, 'docs/../../x'), null);
  assert.equal(safeResolve(root, '/etc/passwd'), null);
  assert.equal(safeResolve(root, 'escape'), null);
});

test('renderMarkdown rewrites relative links and images, leaves absolute ones', () => {
  const html = renderMarkdown(
    '[x](../other/b.md#sec) [y](https://e.com) [z](#local) ![i](img/p.png) [up](../../../out.md)',
    'docs/sub/a.md',
  );
  assert.match(html, /href="\/view\/docs\/other\/b\.md#sec"/);
  assert.match(html, /href="https:\/\/e\.com"/);
  assert.match(html, /href="#local"/);
  assert.match(html, /src="\/raw\/docs\/sub\/img\/p\.png"/);
  assert.match(html, /href="\.\.\/\.\.\/\.\.\/out\.md"/);
});

test('renderMarkdown gives headings unique ids', () => {
  const html = renderMarkdown('# Hello World\n\n# Hello World', 'a.md');
  assert.match(html, /id="hello-world"/);
  assert.match(html, /id="hello-world-1"/);
});

test('search ranks basename matches first and honours mdOnly', () => {
  const list = ['x/plan/notes.md', 'deep/a/b/plan.md', 'plan.ts'].map(p => ({
    p, lower: p.toLowerCase(), base: path.basename(p).toLowerCase(), md: p.endsWith('.md'),
  }));
  assert.deepEqual(search(list, 'plan'), ['deep/a/b/plan.md', 'x/plan/notes.md']);
  assert.deepEqual(search(list, 'plan', { mdOnly: false })[0], 'plan.ts');
  assert.deepEqual(search(list, 'plan notes'), ['x/plan/notes.md']);
});

test('renderMarkdown labels table cells with their column header', () => {
  const html = renderMarkdown('| # | **Decision** |\n|---|---|\n| A | pin `x` |', 'a.md');
  assert.match(html, /<td data-label="#">A<\/td>/);
  assert.match(html, /<td data-label="Decision">pin <code>x<\/code><\/td>/);
  assert.match(html, /class="tbl-toggle"/);
});

test('renderMarkdown tags numeric and long-text table columns', () => {
  const long = 'x'.repeat(41);
  const html = renderMarkdown(`| n | p | ms | id | s |\n|---|---|---|---|---|\n| 4,694,280 | 11.15% | 178/278 | a1b2 | \`GET /v3/a\` |\n| — | 2.3x | 90/120 | 7 | ${long} |`, 'a.md');
  assert.match(html, /<th class="num">n<\/th><th class="num">p<\/th><th class="num">ms<\/th><th>id<\/th><th class="wide">s<\/th>/);
  assert.match(html, /<td data-label="n" class="num">—<\/td>/);
  assert.match(html, /<code>GET \/<wbr>v3\/<wbr>a<\/code>/);
});

test('fenced code is syntax highlighted; unknown languages stay escaped', () => {
  const html = renderMarkdown('```ts\nconst a: number = 1;\n```\n\n```nope\n<b>x</b>\n```', 'a.md');
  assert.match(html, /<code class="hljs language-ts"><span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/);
  assert.equal(highlight('x'.repeat(300_001), 'js').startsWith('<code>'), true);
});

test('mermaid fences become escaped pre.mermaid blocks', () => {
  const html = renderMarkdown('```mermaid\ngraph TD; A-->B<script>\n```', 'a.md');
  assert.match(html, /<pre class="mermaid">graph TD; A--&gt;B&lt;script&gt;<\/pre>/);
});

test('GitHub alerts render as callouts; plain quotes stay quotes', () => {
  const html = renderMarkdown('> [!WARNING]\n> Mind the **gap**\n\n> just a quote', 'a.md');
  assert.match(html, /<div class="alert alert-warning"><p class="alert-title">Warning<\/p><p>Mind the <strong>gap<\/strong><\/p>/);
  assert.match(html, /<blockquote>\n<p>just a quote<\/p>/);
});

test('search falls back to fuzzy file-name matching, ranked below exact hits', () => {
  const list = ['_docs/REVIEW.md', 'notes/preview.md', 'other.md'].map(p => ({
    p, lower: p.toLowerCase(), base: path.basename(p).toLowerCase(), md: true,
  }));
  assert.deepEqual(search(list, 'rvwmd'), ['_docs/REVIEW.md', 'notes/preview.md']);
  assert.deepEqual(search(list, 'review'), ['_docs/REVIEW.md', 'notes/preview.md']);
  assert.deepEqual(search(list, 'prvw'), ['notes/preview.md']);
  assert.deepEqual(search(list, 'zzz'), []);
});

test('foldersWithMarkdown marks every ancestor of a markdown file, and only those', () => {
  const list = ['a/b/c/notes.md', 'a/x/code.ts', 'top.md', 'z/y/readme.markdown'].map(p => ({ p, md: /\.(md|markdown)$/.test(p) }));
  assert.deepEqual([...foldersWithMarkdown(list)].sort(), ['a', 'a/b', 'a/b/c', 'z', 'z/y']);
});

test('listDir sorts folders, puts markdown first, and skips build dirs and escaping symlinks', async () => {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-ls-')));
  for (const d of ['src', 'Docs', 'node_modules']) fs.mkdirSync(path.join(r, d));
  for (const f of ['z.ts', 'b.md', 'A.md']) fs.writeFileSync(path.join(r, f), '');
  fs.symlinkSync(outside, path.join(r, 'out'));
  const { dirs, files } = await listDir(r, '', r);
  assert.deepEqual(dirs.map(d => d.name), ['Docs', 'src']);
  assert.deepEqual(files.map(f => f.name), ['A.md', 'b.md', 'z.ts']);
});
