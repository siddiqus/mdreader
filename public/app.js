if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

if (document.querySelector('pre.mermaid')) {
  const s = document.createElement('script');
  s.src = '/vendor/mermaid.min.js';
  s.onload = () => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
    window.mermaid.run({ querySelector: 'pre.mermaid' });
  };
  document.head.appendChild(s);
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.tbl-toggle');
  if (btn) btn.parentElement.classList.toggle('grid');
});

// ---------- recently viewed ----------
const RECENT_KEY = 'mdr-recent';
const RECENT_MAX = 50;
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
if (location.pathname.startsWith('/view/') && !location.search) {
  const p = decodeURIComponent(location.pathname.slice(6));
  const list = loadRecent().filter(r => r.p !== p);
  list.unshift({ p, t: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch {}
}

// ---------- command palette (⌘K / Ctrl+K / "/") ----------
(() => {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const kbd = document.querySelector('.find-kbd');
  if (kbd && !isMac) kbd.textContent = 'Ctrl K';
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  const isMd = p => /\.(md|markdown|mdx)$/i.test(p);
  const ago = ms => {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  };

  const dlg = document.createElement('dialog');
  dlg.className = 'pal';
  dlg.innerHTML = `<div class="pal-box">
<div class="pal-head"><span class="find-ic" aria-hidden="true">⌕</span>
<input type="search" placeholder="Search files…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" aria-label="Search files">
<button type="button" class="pal-md" aria-pressed="true" title="Markdown only (Tab)">.md</button>
<button type="button" class="pal-close" aria-label="Close">Esc</button></div>
<ul class="pal-list" role="listbox"></ul>
<div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Tab</kbd> .md only</span><span><kbd>Esc</kbd> close</span></div>
</div>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector('input');
  const mdBtn = dlg.querySelector('.pal-md');
  const list = dlg.querySelector('.pal-list');

  let mdOnly = localStorage.getItem('mdr-mdonly') !== '0';
  let items = [];
  let sel = 0;
  let seq = 0;
  let timer;

  const setMd = v => {
    mdOnly = v;
    mdBtn.setAttribute('aria-pressed', String(v));
    try { localStorage.setItem('mdr-mdonly', v ? '1' : '0'); } catch {}
  };
  setMd(mdOnly);

  function render(label) {
    if (!items.length) {
      list.innerHTML = `<li class="pal-empty">${label}</li>`;
      return;
    }
    list.innerHTML = (label ? `<li class="pal-label">${label}</li>` : '') + items.map((it, i) => {
      const k = it.p.lastIndexOf('/');
      return `<li role="option" aria-selected="${i === sel}" data-i="${i}"><a href="/view/${enc(it.p)}" class="${isMd(it.p) ? 'md' : 'file'}">
<span class="ic">${isMd(it.p) ? '¶' : '·'}</span><span class="nm">${esc(it.p.slice(k + 1))}<small>${esc(k > 0 ? it.p.slice(0, k) : '')}</small></span>${it.t ? `<span class="tm">${ago(it.t)}</span>` : ''}</a></li>`;
    }).join('');
  }

  function move(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    list.querySelectorAll('[role=option]').forEach(li => li.setAttribute('aria-selected', String(+li.dataset.i === sel)));
    list.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  async function update() {
    const q = input.value.trim();
    const id = ++seq;
    const recent = loadRecent();
    sel = 0;
    if (!q) {
      items = recent.filter(r => !mdOnly || isMd(r.p));
      return render(items.length ? 'Recently viewed' : 'Type to search file names.');
    }
    let data;
    try {
      const res = await fetch(`/search?${new URLSearchParams({ q, md: mdOnly ? '1' : '0', json: '1' })}`);
      data = await res.json();
    } catch {
      data = { results: [] };
    }
    if (id !== seq) return;
    // Recently viewed matches first (most recent on top), then the rest by relevance.
    const seen = new Map(recent.map(r => [r.p, r.t]));
    const hits = data.results.map(p => ({ p, t: seen.get(p) }));
    items = [...hits.filter(h => h.t).sort((a, b) => b.t - a.t), ...hits.filter(h => !h.t)];
    render(items.length ? '' : `No ${mdOnly ? 'markdown ' : ''}files match “${esc(q)}”.`);
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 120); };

  function open() {
    if (dlg.open) { input.select(); return; }
    dlg.showModal();
    input.value = '';
    update();
    input.focus();
  }
  function go(newTab) {
    const it = items[sel];
    if (!it) return;
    const href = `/view/${enc(it.p)}`;
    if (!newTab) sessionStorage.setItem('mdr-reveal', it.p);
    if (newTab) window.open(href, '_blank'); else location.href = href;
  }

  input.addEventListener('input', schedule);
  mdBtn.addEventListener('click', () => { setMd(!mdOnly); update(); input.focus(); });
  dlg.querySelector('.pal-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  list.addEventListener('click', e => {
    const li = e.target.closest('[role=option]');
    if (li && items[+li.dataset.i]) sessionStorage.setItem('mdr-reveal', items[+li.dataset.i].p);
  });
  list.addEventListener('mousemove', e => {
    const li = e.target.closest('[role=option]');
    if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; move(0); }
  });
  input.addEventListener('keydown', e => {
    const ctrlN = e.ctrlKey && e.key === 'n';
    const ctrlP = e.ctrlKey && e.key === 'p';
    if (e.key === 'ArrowDown' || ctrlN) { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp' || ctrlP) { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); go(e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape') { e.preventDefault(); dlg.close(); }
    else if (e.key === 'Tab') { e.preventDefault(); setMd(!mdOnly); update(); }
  });

  document.querySelector('.find')?.addEventListener('click', e => { e.preventDefault(); open(); });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (e.key === '/' && !typing && !dlg.open) { e.preventDefault(); open(); }
  });
})();

// ---------- sidebar file tree ----------
(() => {
  const side = document.getElementById('side');
  const tree = side?.querySelector('.tree');
  if (!tree) return;
  const body = document.body;
  const top = document.querySelector('.top');
  const setTopH = () => document.documentElement.style.setProperty('--top-h', `${top.offsetHeight}px`);
  setTopH(); addEventListener('resize', setTopH);
  const wide = matchMedia('(min-width: 1000px)');
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const parentsOf = p => { const out = []; let i = p.lastIndexOf('/'); while (i > 0) { p = p.slice(0, i); out.push(p); i = p.lastIndexOf('/'); } return out; };

  // Current location: a file (/view/) or a folder (/browse/).
  const m = location.pathname.match(/^\/(view|browse)\/(.*)$/);
  const current = m ? decodeURIComponent(m[2]).replace(/\/+$/, '') : null;
  const currentIsDir = m?.[1] === 'browse';

  const OPEN_KEY = 'mdr-open';
  const CACHE_KEY = 'mdr-tree-cache';
  const MD_KEY = 'mdr-tree-md';
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const open = new Set(load(OPEN_KEY, []));
  let mdOnly = localStorage.getItem(MD_KEY) !== '0';
  let ready = true; // index built on the server; until then don't hide folders in .md mode
  let cache = {};
  try { cache = JSON.parse(sessionStorage.getItem(CACHE_KEY)) || {}; } catch {}
  const saveOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch {} };
  const saveCache = () => { try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {} };

  // Opening a page always reveals it in the tree.
  if (current) {
    for (const d of parentsOf(current)) open.add(d);
    if (currentIsDir && current) open.add(current);
    saveOpen();
  }

  async function fetchDirs(dirs) {
    dirs = [...new Set(dirs)];
    for (let i = 0; i < dirs.length; i += 400) {
      const qs = new URLSearchParams();
      dirs.slice(i, i + 400).forEach(d => qs.append('d', d));
      try {
        const res = await fetch(`/tree?${qs}`);
        const data = await res.json();
        ready = data.ready;
        Object.assign(cache, data.listings);
      } catch { /* offline: keep cached listings */ }
    }
    saveCache();
  }

  function rows(dir, depth, out) {
    const l = cache[dir];
    if (!l) { if (open.has(dir) || dir === '') out.push(`<div class="t-note" style="--d:${depth}">Loading…</div>`); return; }
    for (const [name, hasMd] of l.d) {
      if (mdOnly && ready && !hasMd) continue;
      const p = dir ? `${dir}/${name}` : name;
      const isOpen = open.has(p);
      const cur = currentIsDir && p === current;
      out.push(`<div class="t-row t-dir${cur ? ' cur' : ''}" role="treeitem" tabindex="0" aria-expanded="${isOpen}" data-p="${esc(p)}" style="--d:${depth}"><span class="chev">${isOpen ? '▾' : '▸'}</span><span class="nm">${esc(name)}</span><a class="t-go" href="/browse/${enc(p)}" title="Open folder" aria-label="Open folder ${esc(name)}">›</a></div>`);
      if (isOpen) rows(p, depth + 1, out);
    }
    let shown = 0;
    for (const [name, md] of l.f) {
      if (mdOnly && !md) continue;
      shown++;
      const p = dir ? `${dir}/${name}` : name;
      const cur = !currentIsDir && p === current;
      out.push(`<a class="t-row t-file${md ? ' md' : ''}${cur ? ' cur' : ''}" role="treeitem" href="/view/${enc(p)}" data-p="${esc(p)}" style="--d:${depth}"${cur ? ' aria-current="page"' : ''}><span class="chev">${md ? '¶' : '·'}</span><span class="nm">${esc(name)}</span></a>`);
    }
    if (!l.d.length && !shown) out.push(`<div class="t-note" style="--d:${depth}">${mdOnly && l.f.length ? 'No markdown files' : 'Empty'}</div>`);
  }

  function render() {
    const out = [];
    rows('', 0, out);
    tree.innerHTML = out.join('');
    side.querySelector('[data-act=md]').setAttribute('aria-pressed', String(mdOnly));
  }

  const missing = () => ['', ...open].filter(d => !cache[d]);
  async function refreshOpen() {
    const dirs = ['', ...open];
    const before = dirs.map(d => JSON.stringify(cache[d] ?? null));
    for (const d of dirs) delete cache[d];
    await fetchDirs(dirs); // revalidate everything visible
    const changed = dirs.some((d, i) => JSON.stringify(cache[d] ?? null) !== before[i]);
    // drop folders that no longer exist
    for (const d of [...open]) if (!cache[d]) open.delete(d);
    saveOpen();
    if (changed) { const y = tree.scrollTop; render(); tree.scrollTop = y; }
  }

  function reveal(how) {
    const el = tree.querySelector('.cur');
    if (!el) return;
    // scroll only the tree; scrollIntoView would also scroll the page
    const t = tree.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (how === 'center') tree.scrollTop += r.top - t.top - (t.height - r.height) / 2;
    else if (r.top < t.top) tree.scrollTop += r.top - t.top;
    else if (r.bottom > t.bottom) tree.scrollTop += r.bottom - t.bottom;
    if (how === 'center') { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  // ----- first paint from session cache, then revalidate -----
  const SCROLL_KEY = 'mdr-tree-scroll';
  const fromPalette = sessionStorage.getItem('mdr-reveal');
  sessionStorage.removeItem('mdr-reveal');
  render();
  tree.scrollTop = +sessionStorage.getItem(SCROLL_KEY) || 0;
  const settle = () => reveal(fromPalette && fromPalette === current ? 'center' : 'nearest');
  if (missing().length) fetchDirs(missing()).then(() => { render(); tree.scrollTop = +sessionStorage.getItem(SCROLL_KEY) || 0; settle(); refreshOpen(); });
  else { settle(); refreshOpen(); }
  addEventListener('pagehide', () => sessionStorage.setItem(SCROLL_KEY, String(tree.scrollTop)));

  // ----- interactions -----
  async function toggle(p) {
    if (open.has(p)) { open.delete(p); saveOpen(); render(); return; }
    open.add(p); saveOpen();
    if (!cache[p]) { render(); await fetchDirs([p]); }
    render();
  }
  tree.addEventListener('click', e => {
    const row = e.target.closest('.t-dir');
    if (!row || e.target.closest('.t-go')) return;
    toggle(row.dataset.p);
  });
  tree.addEventListener('keydown', e => {
    const row = e.target.closest('.t-dir');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(row.dataset.p); }
  });

  side.querySelector('.side-tools').addEventListener('click', async e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'collapse') { open.clear(); saveOpen(); render(); tree.scrollTop = 0; }
    if (act === 'expand') {
      // open every folder currently visible, one level deeper
      const visible = [...tree.querySelectorAll('.t-dir[aria-expanded=false]')].map(r => r.dataset.p);
      visible.forEach(p => open.add(p)); saveOpen();
      render(); await fetchDirs(visible.filter(p => !cache[p])); render();
    }
    if (act === 'reveal' && current) {
      for (const d of parentsOf(current)) open.add(d);
      saveOpen(); await fetchDirs(missing()); render(); reveal('center');
    }
    if (act === 'close') body.classList.remove('drawer-open');
    if (act === 'fs') {
      // S → M → L → S; the server reads the cookie so the next page renders at this size directly
      const sizes = ['s', 'm', 'l'];
      const names = { s: 'Small', m: 'Medium', l: 'Large' };
      const html = document.documentElement;
      const cur = sizes.find(z => html.classList.contains(`fs-${z}`)) || 'm';
      const next = sizes[(sizes.indexOf(cur) + 1) % 3];
      html.classList.replace(`fs-${cur}`, `fs-${next}`) || html.classList.add(`fs-${next}`);
      document.cookie = `mdr-fs=${next}; path=/; max-age=31536000; samesite=lax`;
      const b = e.target.closest('button');
      b.querySelector('small').textContent = next.toUpperCase();
      b.title = `Text size: ${names[next]} (click to change)`;
      b.setAttribute('aria-label', `Text size: ${names[next]}`);
      setTopH();
    }
    if (act === 'md') {
      mdOnly = !mdOnly;
      try { localStorage.setItem(MD_KEY, mdOnly ? '1' : '0'); } catch {}
      render(); reveal('nearest');
    }
  });

  // ----- show / hide: docked on wide screens (remembered), drawer on narrow ones -----
  const setDocked = v => {
    body.classList.toggle('side-open', v);
    body.classList.toggle('side-closed', !v);
    document.cookie = `mdr-side=${v ? 1 : 0}; path=/; max-age=31536000; samesite=lax`;
  };
  const setDrawer = v => { body.classList.toggle('drawer-open', v); if (v) reveal('center'); };
  document.querySelector('.side-toggle').addEventListener('click', () => {
    if (wide.matches) setDocked(!body.classList.contains('side-open'));
    else setDrawer(!body.classList.contains('drawer-open'));
  });
  document.querySelector('.side-scrim').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && body.classList.contains('drawer-open')) setDrawer(false);
    // ⌘B / Ctrl+B toggles the tree, like an editor sidebar
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
      e.preventDefault(); document.querySelector('.side-toggle').click();
    }
  });
})();
