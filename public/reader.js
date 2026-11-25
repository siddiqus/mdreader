// Reading mode.
//   Page  (desktop default): a calm reader column with typography controls, progress, and an
//                            optional focus mode that dims everything but the current paragraph.
//   Cards (phone default):   the document cut into screen-sized cards you swipe through. Blocks that
//                            don't fit are split at sentence / list item / table row / code line.
(() => {
  const btn = document.querySelector('.read-btn');
  const article = document.querySelector('main article.md');
  if (!btn || !article) return;

  const PREF_KEY = 'mdr-read-prefs';
  const POS_KEY = 'mdr-read-pos';
  const HINT_KEY = 'mdr-read-hint';
  const WPM = 230;
  const docPath = decodeURIComponent(location.pathname.replace(/^\/view\//, ''));
  const docTitle = document.querySelector('.crumbs span')?.textContent || document.title;

  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const prefs = { size: 0, font: 'serif', theme: 'auto', layout: 'auto', ...read(PREF_KEY, {}) };
  prefs.focus = prefs.focus2 ?? false; // focus mode is opt-in (the old default dimmed too much)
  const savePrefs = () => write(PREF_KEY, { ...prefs, focus: undefined, focus2: prefs.focus });

  const coarse = matchMedia('(pointer: coarse)');
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  const phoneLike = () => innerWidth < 700 || (coarse.matches && innerWidth < 1100);
  const mode = () => (prefs.layout === 'auto' ? (phoneLike() ? 'cards' : 'page') : prefs.layout);
  const countWords = el => (el.textContent.match(/\S+/g) || []).length;
  const isHead = n => n.nodeType === 1 && /^H[1-6]$/.test(n.tagName);
  const minutes = w => (w <= 0 ? 'Done' : `${Math.max(1, Math.round(w / WPM))} min left`);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------- source blocks ----------
  // Clone the rendered article so the page underneath stays intact. Ids move to data-rid so they
  // don't collide (SVG ids stay: Mermaid styles reference them).
  function sourceBlocks() {
    return [...article.children].map((el, i) => {
      const c = el.cloneNode(true);
      c.dataset.bi = i;
      c.querySelectorAll('.anchor').forEach(a => a.remove());
      for (const n of [c, ...c.querySelectorAll('[id]')]) {
        if (n.id && !n.closest('svg')) { n.dataset.rid = n.id; n.removeAttribute('id'); }
      }
      return c;
    });
  }
  const waitImages = root => Promise.race([
    Promise.all([...root.querySelectorAll('img')].map(i => i.decode().catch(() => {}))),
    new Promise(r => setTimeout(r, 1500)),
  ]);

  // ---------- splitting (cards) ----------
  // Each splitter works in place on an element that is already in the measuring card and overflows
  // it: it trims the element down to the largest head that fits and returns the rest (detached),
  // or returns null and leaves the element untouched if no useful split exists.
  const SENTENCE = /[.!?…]["'”’)\]]*\s+/g;
  const WORD = /\s+/g;
  const LINE = /\n/g;
  const BLOCKY = /^(P|UL|OL|PRE|BLOCKQUOTE|DIV|TABLE|H[1-6]|DL|DETAILS)$/;

  function stops(root, re) {
    const out = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = root.textContent.length;
    let seen = 0;
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      re.lastIndex = 0;
      for (let m = re.exec(t.data); m; m = re.exec(t.data)) {
        const off = m.index + m[0].length;
        if (seen + off < total && off > 0) out.push([t, off]);
        if (!m[0].length) re.lastIndex++;
      }
      seen += t.data.length;
    }
    return out;
  }

  function splitText(el, fits, re) {
    const orig = el.cloneNode(true);
    const at = stops(orig, re);
    const restore = () => el.replaceChildren(...orig.cloneNode(true).childNodes);
    const head = k => {
      const r = document.createRange();
      r.setStart(orig, 0);
      r.setEnd(at[k][0], at[k][1]);
      return r.cloneContents();
    };
    let lo = 0, hi = at.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      el.replaceChildren(head(mid));
      if (fits()) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) {
      restore();
      return re === SENTENCE ? splitText(el, fits, WORD) : null;
    }
    el.replaceChildren(head(best));
    const r = document.createRange();
    r.setStart(at[best][0], at[best][1]);
    r.setEnd(orig, orig.childNodes.length);
    const rest = orig.cloneNode(false);
    rest.append(r.cloneContents());
    delete rest.dataset.rid;
    rest.classList.add('rd-cont');
    return rest;
  }

  function splitTable(el, fits, alone) {
    const tb = el.querySelector('tbody');
    if (!tb) return null;
    const rows = [...tb.rows];
    tb.replaceChildren();
    let i = 0;
    for (; i < rows.length; i++) { tb.append(rows[i]); if (!fits()) break; }
    if (i === rows.length) return null;
    if (i === 0) {
      // the first row alone is taller than the card: give it the card (it scrolls) and move on
      if (!alone || rows.length === 1) { tb.replaceChildren(...rows); return null; }
      i = 1;
    } else rows[i].remove();
    const rest = el.cloneNode(true);
    rest.querySelector('tbody').replaceChildren(...rows.slice(i));
    return rest;
  }

  function splitContainer(el, fits, alone) {
    const kids = [...el.childNodes];
    el.replaceChildren();
    let i = 0;
    for (; i < kids.length; i++) { el.append(kids[i]); if (!fits()) break; }
    if (i === kids.length) return null;
    const c = kids[i];
    const before = kids.slice(0, i).some(n => n.nodeType === 1 || n.textContent.trim());
    let first;
    let splitChild = false;
    if (before && !(c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName))) {
      c.remove(); // whole items read better than an item cut in half
      first = c;
    } else {
      first = c.nodeType === 1 ? splitInPlace(c, fits, alone && !before) : null;
      if (first) splitChild = true;
      else if (before) { c.remove(); first = c; }
      else if (alone && i < kids.length - 1) {
        // the first item alone is too tall: keep it here on its own (the card scrolls)
        const restKids = kids.slice(i + 1);
        if (!restKids.some(n => n.nodeType === 1 || n.textContent.trim())) return null;
        const rest = el.cloneNode(false);
        delete rest.dataset.rid;
        rest.append(...restKids);
        if (el.tagName === 'OL') rest.setAttribute('start', +(el.getAttribute('start') || 1) + 1);
        return rest;
      } else { el.replaceChildren(...kids); return null; }
    }
    const rest = el.cloneNode(false);
    delete rest.dataset.rid;
    rest.append(first, ...kids.slice(i + 1));
    if (el.tagName === 'OL') {
      const n = [...el.children].filter(x => x.tagName === 'LI').length;
      rest.setAttribute('start', +(el.getAttribute('start') || 1) + n - (splitChild ? 1 : 0));
    }
    return rest;
  }

  function splitInPlace(el, fits, alone = false) {
    if (el.matches('pre.mermaid, hr, img, svg, table')) return null;
    if (el.matches('pre')) return splitText(el, fits, LINE);
    if (el.matches('.tbl')) return splitTable(el, fits, alone);
    const blocky = [...el.children].some(c => BLOCKY.test(c.tagName));
    if (el.matches('ul, ol') || (blocky && el.matches('li, blockquote, .alert, div, dd'))) return splitContainer(el, fits, alone);
    if (el.matches('p, li, dd, dt, blockquote')) return splitText(el, fits, SENTENCE);
    return null;
  }

  // Greedily pack blocks into cards. h1/h2 always start a new card; a card never ends on a heading.
  function paginate(blocks, measure) {
    const body = measure.firstElementChild;
    body.replaceChildren();
    const cs = getComputedStyle(measure);
    const avail = measure.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const fits = () => body.offsetHeight <= avail + 1;
    const cards = [];
    const close = () => {
      const nodes = [...body.childNodes];
      const carry = [];
      while (nodes.length > 1 && isHead(nodes[nodes.length - 1])) carry.unshift(nodes.pop());
      if (nodes.length) cards.push(nodes);
      body.replaceChildren(...carry);
    };
    const queue = [...blocks];
    while (queue.length) {
      const b = queue.shift();
      const hasText = () => [...body.children].some(n => n !== b && !isHead(n));
      if (/^H[12]$/.test(b.tagName) && hasText()) close();
      const used = body.offsetHeight;
      body.append(b);
      if (fits()) continue;
      if (hasText()) {
        // Fill the rest of this card only when there is real room left; otherwise start fresh.
        const rest = avail - used > avail * 0.35 ? splitInPlace(b, fits) : null;
        if (!rest) b.remove();
        close();
        queue.unshift(rest || b);
        continue;
      }
      const rest = splitInPlace(b, fits, true); // alone (or under its heading) and still too tall
      close();
      if (rest) queue.unshift(rest);
    }
    close();
    if (body.childNodes.length) cards.push([...body.childNodes]);
    body.replaceChildren();
    return cards;
  }

  // ---------- overlay ----------
  let rd = null;
  let view = null; // { kind, go(delta|index), pos(), restore(pos), destroy() }

  function shell() {
    const el = document.createElement('div');
    el.className = 'rd';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Reading mode');
    el.tabIndex = -1;
    el.innerHTML = `<div class="rd-prog"><i></i></div>
<div class="rd-bar"><button type="button" class="rd-btn rd-x" aria-label="Exit reading mode" title="Exit (Esc)">✕</button>
<div class="rd-head"><span class="rd-doc"></span><span class="rd-sec"></span></div>
<span class="rd-pos" aria-live="polite"></span>
<button type="button" class="rd-btn rd-aa" aria-expanded="false" aria-label="Display settings" title="Display settings">Aa</button></div>
<div class="rd-menu" hidden>
<div class="rd-row"><span class="rd-lbl">Size</span><div class="rd-seg"><button type="button" data-a="smaller" aria-label="Smaller text">A−</button><button type="button" data-a="bigger" aria-label="Larger text">A+</button></div></div>
<div class="rd-row"><span class="rd-lbl">Font</span><div class="rd-seg" data-k="font"><button type="button" data-v="serif" class="rd-serif">Serif</button><button type="button" data-v="sans">Sans</button></div></div>
<div class="rd-row"><span class="rd-lbl">Theme</span><div class="rd-seg rd-themes" data-k="theme"><button type="button" data-v="auto">Auto</button><button type="button" data-v="light">Light</button><button type="button" data-v="sepia">Sepia</button><button type="button" data-v="dark">Dark</button></div></div>
<div class="rd-row"><span class="rd-lbl">Layout</span><div class="rd-seg" data-k="layout"><button type="button" data-v="auto">Auto</button><button type="button" data-v="page">Page</button><button type="button" data-v="cards">Cards</button></div></div>
<label class="rd-row rd-focus-row"><input type="checkbox"> Focus on the current paragraph <kbd>F</kbd></label>
</div>
<div class="rd-stage"></div>`;
    el.querySelector('.rd-doc').textContent = docTitle;
    return el;
  }

  function applyPrefs() {
    const theme = prefs.theme === 'auto' ? (sysDark.matches ? 'dark' : 'light') : prefs.theme;
    rd.dataset.theme = theme;
    // Code colours come from the system light/dark stylesheet; drop them if the theme disagrees.
    rd.classList.toggle('rd-mono', (theme === 'dark') !== sysDark.matches);
    rd.dataset.font = prefs.font;
    rd.style.setProperty('--rd-step', prefs.size);
    rd.querySelectorAll('.rd-seg[data-k] button').forEach(b => {
      const k = b.parentElement.dataset.k;
      b.setAttribute('aria-pressed', String(prefs[k] === b.dataset.v));
    });
    const focus = rd.querySelector('.rd-focus-row input');
    focus.checked = prefs.focus;
    rd.querySelector('.rd-page')?.classList.toggle('rd-focus', prefs.focus);
  }

  function setBar({ frac, pos, sec }) {
    rd.querySelector('.rd-prog i').style.transform = `scaleX(${clamp(frac, 0, 1)})`;
    rd.querySelector('.rd-pos').textContent = pos;
    rd.querySelector('.rd-sec').textContent = sec || '';
  }

  function savePos(p) {
    const all = read(POS_KEY, {});
    all[docPath] = { ...p, t: Date.now() };
    const keep = Object.entries(all).sort((a, b) => b[1].t - a[1].t).slice(0, 200);
    write(POS_KEY, Object.fromEntries(keep));
  }

  function endBlock() {
    const d = document.createElement('div');
    d.className = 'rd-end';
    d.innerHTML = `<div class="rd-end-mark">❦</div><p>End of <b></b></p>
<div class="rd-end-acts"><button type="button" class="rd-pill" data-a="restart">Start over</button><button type="button" class="rd-pill rd-pill-main" data-a="exit">Exit reading mode</button></div>`;
    d.querySelector('b').textContent = docTitle;
    return d;
  }

  // ----- Page view -----
  function pageView(stage, blocks) {
    stage.innerHTML = '<div class="rd-scroll"><article class="md rd-page"></article></div>';
    const scroll = stage.firstElementChild;
    const art = scroll.firstElementChild;
    art.append(...blocks, endBlock());
    art.classList.toggle('rd-focus', prefs.focus);
    const units = [...art.querySelectorAll(':scope > :not(ul, ol, hr, .rd-end), :scope > ul > li, :scope > ol > li')];
    if (!units.length) units.push(art.querySelector('.rd-end'));
    const words = units.map(countWords);
    const total = words.reduce((a, b) => a + b, 0) || 1;
    const before = []; words.reduce((acc, w, i) => (before[i] = acc, acc + w), 0);
    let cur = '';
    const secs = units.map(u => (isHead(u) ? (cur = u.textContent.trim()) : cur));
    const bi = u => +(u.dataset.bi ?? u.parentElement.dataset.bi);
    let active = -1;
    let lock = 0;

    function setActive(i) {
      if (i === active) return;
      units[active]?.classList.remove('rd-on');
      active = i;
      units[i].classList.add('rd-on');
      const left = total - before[i];
      setBar({ frac: before[i] / total, pos: minutes(left), sec: secs[i] });
    }
    // The reading line sits 35% down the screen, except near the top where it starts at the first
    // line of text and slides down with the scroll, so the title is the first thing in focus.
    const padTop = () => parseFloat(getComputedStyle(art).paddingTop);
    const line = () => Math.min(scroll.clientHeight * 0.35, padTop() + scroll.scrollTop + 4);
    function pick() {
      if (Date.now() < lock) return;
      const top = scroll.getBoundingClientRect().top;
      const L = top + line();
      let lo = 0, hi = units.length - 1, k = 0;
      while (lo <= hi) { // last unit whose top is above the reading line
        const mid = (lo + hi) >> 1;
        if (units[mid].getBoundingClientRect().top <= L) { k = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const r = units[k].getBoundingClientRect();
      if (r.bottom < L && units[k + 1] && units[k + 1].getBoundingClientRect().top - L < L - r.bottom) k++;
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2 && scroll.scrollTop > 0) {
        // bottom of the spacer: keep the last unit rather than snapping back
        k = Math.max(k, units.length - 1);
      }
      setActive(k);
    }
    function go(i, smooth = true) {
      i = clamp(i, 0, units.length - 1);
      setActive(i);
      const u = units[i];
      const r = u.getBoundingClientRect();
      const top = scroll.getBoundingClientRect().top;
      const at = r.height > scroll.clientHeight * 0.6 ? scroll.clientHeight * 0.12 : scroll.clientHeight * 0.35 - Math.min(r.height / 2, 40);
      lock = Date.now() + (smooth ? 700 : 300);
      scroll.scrollTo({ top: scroll.scrollTop + r.top - top - at, behavior: smooth ? 'smooth' : 'auto' });
    }
    let last = 0;
    let raf = 0;
    scroll.addEventListener('scroll', () => {
      const y = scroll.scrollTop;
      if (Date.now() >= lock) rd.classList.toggle('rd-bar-hidden', y > last && y > 80 && rd.querySelector('.rd-menu').hidden);
      last = y;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; pick(); });
    }, { passive: true });
    // a programmatic step owns the focus until the user scrolls again
    scroll.addEventListener('scrollend', () => { lock = 0; });
    art.addEventListener('click', e => {
      if (e.target.closest('a, button, input, summary') || String(getSelection())) return;
      const i = units.findIndex(u => u.contains(e.target));
      if (i >= 0) setActive(i);
    });

    return {
      kind: 'page',
      step: d => go(active + d),
      first: () => go(0),
      last: () => go(units.length - 1),
      jump: rid => {
        const t = art.querySelector(`[data-rid="${CSS.escape(rid)}"]`);
        const i = t ? units.findIndex(u => u === t || u.contains(t) || t.contains(u)) : -1;
        if (i >= 0) go(i);
      },
      pos: () => {
        const u = units[active];
        if (!u) return null;
        const b = bi(u);
        return { bi: b, k: units.slice(0, active).filter(x => bi(x) === b).length, end: active >= units.length - 1 };
      },
      restore: p => {
        let i = p ? units.findIndex(u => bi(u) >= p.bi) : 0;
        if (i < 0 || p?.end) i = 0;
        else if (p) { const same = units.map((u, j) => [u, j]).filter(([u]) => bi(u) === bi(units[i])); i = (same[Math.min(p.k || 0, same.length - 1)] || [, i])[1]; }
        active = -1;
        if (i === 0) { scroll.scrollTop = 0; pick(); if (active < 0) setActive(0); } else go(i, false);
      },
      relayout: () => pick(),
    };
  }

  // ----- Cards view -----
  async function cardsView(stage, blocks) {
    stage.innerHTML = '<div class="rd-track"></div><div class="rd-card rd-measure" aria-hidden="true"><div class="rd-body md"></div></div>'
      + '<button type="button" class="rd-nav rd-prev" aria-label="Previous card">‹</button><button type="button" class="rd-nav rd-next" aria-label="Next card">›</button>';
    const track = stage.querySelector('.rd-track');
    const measure = stage.querySelector('.rd-measure');
    measure.firstElementChild.append(...blocks);
    await waitImages(measure);
    const groups = paginate(blocks, measure);
    measure.remove();
    const words = groups.map(g => g.reduce((a, n) => a + countWords(n), 0));
    const total = words.reduce((a, b) => a + b, 0) || 1;
    const after = []; for (let i = words.length - 1, acc = 0; i >= 0; i--) { acc += words[i]; after[i] = acc; }
    let curSec = '';
    const secs = groups.map(g => {
      const h = g.find(isHead);
      if (h) curSec = h.textContent.trim();
      return h ? h.textContent.trim() : curSec;
    });
    const keys = groups.map(g => +(g.find(n => n.nodeType === 1)?.dataset.bi ?? -1));
    const frag = document.createDocumentFragment();
    groups.forEach((g, i) => {
      const card = document.createElement('section');
      card.className = 'rd-card';
      card.setAttribute('aria-label', `Card ${i + 1} of ${groups.length + 1}`);
      const body = document.createElement('div');
      body.className = 'rd-body md';
      body.append(...g);
      card.append(body);
      frag.append(card);
    });
    const endCard = document.createElement('section');
    endCard.className = 'rd-card rd-card-end';
    const endBody = document.createElement('div');
    endBody.className = 'rd-body';
    endBody.append(endBlock());
    endCard.append(endBody);
    frag.append(endCard);
    track.append(frag);
    const cards = [...track.children];
    const n = cards.length;
    let idx = -1;

    function show(i) {
      if (i === idx) return;
      idx = i;
      const isEnd = i >= groups.length;
      setBar({
        frac: (i + 1) / n,
        pos: isEnd ? 'Done' : `${i + 1} / ${groups.length} · ${minutes(after[i] - words[i] * 0.5)}`,
        sec: isEnd ? '' : secs[i],
      });
      stage.querySelector('.rd-prev').disabled = i === 0;
      stage.querySelector('.rd-next').disabled = i === n - 1;
      cards.forEach((c, j) => c.setAttribute('aria-hidden', String(j !== i)));
    }
    // The track is moved with a transform; the browser keeps vertical panning (touch-action: pan-y)
    // so tall cards still scroll, and horizontal drags come to us as pointer events.
    const place = (dx = 0, animate = true) => {
      track.style.transition = animate ? '' : 'none';
      track.style.transform = `translate3d(calc(${-idx * 100}% + ${dx}px), 0, 0)`;
    };
    function go(i, smooth = true) {
      i = clamp(i, 0, n - 1);
      show(i);
      place(0, smooth);
    }
    let drag = null;
    let swallowClick = false;
    track.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, on: false };
    });
    track.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.on) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
        drag.on = true;
        drag.x = e.clientX; // start from here so the card doesn't jump by the slop
        track.setPointerCapture?.(e.pointerId);
        return;
      }
      // rubber-band past the first and last card
      const edge = (idx === 0 && dx > 0) || (idx === n - 1 && dx < 0);
      drag.dx = edge ? dx / 3 : dx;
      place(drag.dx, false);
    });
    const endDrag = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.on) return;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
      const w = track.clientWidth || innerWidth;
      const v = d.dx / Math.max(1, e.timeStamp - d.t); // px per ms
      if (e.type !== 'pointercancel' && (d.dx < -w * 0.18 || v < -0.4)) go(idx + 1);
      else if (e.type !== 'pointercancel' && (d.dx > w * 0.18 || v > 0.4)) go(idx - 1);
      else place(0, true);
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    // Tap the outer edges to turn, like an e-reader.
    track.addEventListener('click', e => {
      if (swallowClick) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.target.closest('a, button, input, summary, pre, .tbl, img, svg') || String(getSelection())) return;
      const x = e.clientX / innerWidth;
      if (x < 0.25) go(idx - 1);
      else if (x > 0.75) go(idx + 1);
    }, true);
    stage.querySelector('.rd-prev').addEventListener('click', () => go(idx - 1));
    stage.querySelector('.rd-next').addEventListener('click', () => go(idx + 1));

    if (!localStorage.getItem(HINT_KEY)) {
      const hint = document.createElement('div');
      hint.className = 'rd-hint';
      hint.textContent = coarse.matches ? 'Swipe, or tap the edges, to turn' : 'Use ← → or click the edges to turn';
      stage.append(hint);
      setTimeout(() => hint.remove(), 3200);
      try { localStorage.setItem(HINT_KEY, '1'); } catch {}
    }

    return {
      kind: 'cards',
      step: d => go(idx + d),
      first: () => go(0),
      last: () => go(n - 1),
      jump: rid => {
        const i = cards.findIndex(c => c.querySelector(`[data-rid="${CSS.escape(rid)}"]`));
        if (i >= 0) go(i);
      },
      pos: () => (idx < 0 ? null : idx >= groups.length
        ? { bi: Infinity, k: 0, end: true }
        : { bi: keys[idx], k: keys.slice(0, idx).filter(k => k === keys[idx]).length, end: false }),
      restore: p => {
        let i = 0;
        if (p && !p.end) {
          i = keys.findIndex(k => k >= p.bi);
          if (i < 0) i = 0;
          else i = Math.min(i + (p.k || 0), keys.lastIndexOf(keys[i]));
        }
        idx = -1;
        go(i, false);
      },
      relayout: () => go(idx, false),
    };
  }

  // ---------- lifecycle ----------
  let building = 0;
  async function build(pos) {
    const id = ++building;
    const stage = rd.querySelector('.rd-stage');
    rd.dataset.mode = mode();
    rd.classList.remove('rd-bar-hidden');
    applyPrefs();
    stage.classList.add('rd-building');
    const blocks = sourceBlocks();
    const v = mode() === 'cards' ? await cardsView(stage, blocks) : pageView(stage, blocks);
    if (id !== building || !rd) return;
    view = v;
    view.restore(pos);
    stage.classList.remove('rd-building');
  }
  const rebuild = () => { const p = view?.pos(); if (p) savePos(p); return build(p || read(POS_KEY, {})[docPath]); };

  function open(push = true) {
    if (rd) return;
    rd = shell();
    document.body.append(rd);
    document.documentElement.classList.add('rd-lock');
    if (push && !history.state?.mdrRead) history.pushState({ ...history.state, mdrRead: 1 }, '');
    wire();
    build(read(POS_KEY, {})[docPath]);
    rd.focus({ preventScroll: true });
  }
  function close(fromHistory = false) {
    if (!rd) return;
    const p = view?.pos();
    if (p) savePos(p);
    building++;
    rd.remove();
    rd = null;
    view = null;
    document.documentElement.classList.remove('rd-lock');
    removeEventListener('resize', onResize);
    if (!fromHistory && history.state?.mdrRead) history.back();
    btn.focus({ preventScroll: true, focusVisible: false });
  }

  let resizeT = 0;
  let lastMode = '';
  let lastSize = '';
  function onResize() {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (!rd) return;
      const size = `${innerWidth}x${innerHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      // Cards depend on the exact screen size; the page view only on the mode.
      if (mode() !== lastMode || mode() === 'cards') { lastMode = mode(); rebuild(); } else view?.relayout();
    }, 200);
  }

  function wire() {
    lastMode = mode();
    lastSize = `${innerWidth}x${innerHeight}`;
    addEventListener('resize', onResize);
    const menu = rd.querySelector('.rd-menu');
    const aa = rd.querySelector('.rd-aa');
    const toggleMenu = v => { menu.hidden = !v; aa.setAttribute('aria-expanded', String(v)); };
    rd.querySelector('.rd-x').addEventListener('click', () => close());
    aa.addEventListener('click', () => toggleMenu(menu.hidden));
    rd.querySelector('.rd-stage').addEventListener('pointerdown', () => toggleMenu(false));
    menu.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.a === 'smaller' || b.dataset.a === 'bigger') {
        prefs.size = clamp(prefs.size + (b.dataset.a === 'bigger' ? 1 : -1), -3, 6);
      } else {
        prefs[b.parentElement.dataset.k] = b.dataset.v;
      }
      savePrefs();
      const k = b.parentElement.dataset.k;
      if (k === 'theme') applyPrefs();
      else rebuild();
    });
    menu.querySelector('.rd-focus-row input').addEventListener('change', e => { prefs.focus = e.target.checked; savePrefs(); applyPrefs(); });
    rd.addEventListener('click', e => {
      const a = e.target.closest('[data-a]');
      if (a?.dataset.a === 'exit') close();
      if (a?.dataset.a === 'restart') view?.first();
      const link = e.target.closest('a[href^="#"]');
      if (link) { e.preventDefault(); view?.jump(decodeURIComponent(link.getAttribute('href').slice(1))); }
    });
    rd.addEventListener('mousemove', e => { if (e.clientY < 70) rd.classList.remove('rd-bar-hidden'); });
    rd.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.key !== 'Escape') return;
      if (e.key === 'Escape') { e.preventDefault(); if (!menu.hidden) toggleMenu(false); else close(); return; }
      if (!view) return;
      const cards = view.kind === 'cards';
      const next = ['j', 'n', 'l', 'ArrowRight', ...(cards ? ['PageDown', ' ', 'ArrowDown'] : [])];
      const prev = ['k', 'p', 'h', 'ArrowLeft', ...(cards ? ['PageUp', 'ArrowUp'] : [])];
      if (cards && e.key === ' ' && e.shiftKey) { e.preventDefault(); view.step(-1); }
      else if (next.includes(e.key)) { e.preventDefault(); view.step(1); }
      else if (prev.includes(e.key)) { e.preventDefault(); view.step(-1); }
      else if (e.key === 'Home' && cards) { e.preventDefault(); view.first(); }
      else if (e.key === 'End' && cards) { e.preventDefault(); view.last(); }
      else if (e.key === 'f' && !cards) { prefs.focus = !prefs.focus; savePrefs(); applyPrefs(); }
      else if (e.key === '+' || e.key === '=') { prefs.size = clamp(prefs.size + 1, -3, 6); savePrefs(); rebuild(); }
      else if (e.key === '-') { prefs.size = clamp(prefs.size - 1, -3, 6); savePrefs(); rebuild(); }
    });
    sysDark.addEventListener?.('change', () => rd && applyPrefs());
  }

  btn.addEventListener('click', () => open());
  addEventListener('popstate', e => {
    if (rd && !e.state?.mdrRead) close(true);
    else if (!rd && e.state?.mdrRead) open(false);
  });
  addEventListener('pagehide', () => { const p = view?.pos(); if (p) savePos(p); });
  document.addEventListener('keydown', e => {
    if (rd || e.metaKey || e.ctrlKey || e.altKey || e.key !== 'r') return;
    const a = document.activeElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName) || a?.isContentEditable || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    open();
  });
  // Reloading while in reading mode stays in reading mode.
  if (history.state?.mdrRead) open(false);
})();
