# mdreader

Mobile-friendly, read-only markdown reader and file browser for `../repos`.

- File tree on the left (☰ or ⌘B / Ctrl+B to hide; a drawer on phones): click folders to expand/collapse, `›` opens the folder page; toolbar has `.md` only, text size (`AA` S → M → L, scales the whole app and reading mode; remembered in a cookie), ◎ reveal current file, ⊟ collapse all. The current file is always revealed and highlighted, and flashes when opened from the palette.
- `/browse/<dir>`: folder listing (markdown files first, README rendered below)
- `/view/<file>`: rendered markdown (`?src=1` for source), other text files as plain text
- Reading mode (Read button or `R` on any markdown page; Esc or back exits, reload stays in it, position is remembered per file). Desktop: a reader column with progress and minutes left, font size / serif-sans / Auto-Light-Sepia-Dark in the `Aa` menu, and an optional focus mode (`F`, off by default) that softly dims all but the current paragraph; `J`/`K` step paragraph by paragraph. Phones: fullscreen cards sized to the screen, swiped left/right with a drag that follows your finger (or tap the edges); long paragraphs, lists, tables and code are split at sentence, item, row or line boundaries. Layout can be forced to Page or Cards in the `Aa` menu.
- ⌘K / Ctrl+K (or `/`, or tap the search bar): search palette; recently viewed files first, arrows + Enter to open, Tab toggles `.md` only. `/search?q=` is the plain-page fallback: file-name search, all terms must match the path (falling back to fuzzy file-name matching, e.g. `rvwmd` → `REVIEW.md`); `.md` only by default

Markdown gets syntax-highlighted code (highlight.js), Mermaid diagrams (loaded only on pages that have one), GitHub alerts (`> [!NOTE]` …), and phone-friendly tables (cards with a ⇄ grid toggle). It installs as a PWA and keeps viewed pages for offline reading.

The search index skips `node_modules`, `.git`, pnpm stores, worktrees and build output, and refreshes every 10 minutes (or via `/reindex`).

## Run

```sh
npm install
node server.mjs            # http://127.0.0.1:7780
npm test
```

Env: `MDR_ROOT` (default `../repos`), `MDR_PORT` (7780), `MDR_HOST` (127.0.0.1).

## As a service on the tailnet

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mdreader.repos.plist
tailscale serve --bg --https=10443 http://127.0.0.1:7780
```

macOS blocks launchd agents from reading `~/Documents` until the `node` binary used in the plist has Full Disk Access.
