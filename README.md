# mdreader

A mobile-friendly, read-only markdown reader and file browser. Point it at any folder (notes, docs, a checkout of repos) and read it in the browser, on desktop or phone.

```sh
mdr ~/notes          # serves the folder and opens it in your browser
mdr README.md        # opens one file (its folder becomes the root)
```

## Install

Requires Node.js 20 or newer.

**From npm**

```sh
npm install -g @siddiqus/mdreader
```

**From source**

```sh
git clone https://github.com/siddiqus/mdreader.git
cd mdreader
npm install
echo "alias mdr='node $PWD/bin/mdr.mjs'" >> "$HOME/.$(basename "$SHELL")rc"   # adds mdr to ~/.zshrc or ~/.bashrc
```

Open a new terminal (or `source` the rc file) and run `mdr <folder>`.

## Usage

```
mdr [folder-or-file] [options]

  -p, --port <n>   port (default 7780, next free one if taken)
  -H, --host <h>   interface to bind (default 127.0.0.1)
      --no-open    don't open a browser
```

With no path, `mdr` serves the current directory. Stop it with Ctrl+C.

## Features

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

## Security

mdreader has no authentication. Anyone who can reach the port can read every file under the folder it serves (not just markdown). By default it listens on 127.0.0.1 only. Don't bind it to a public interface; to reach it from other devices, use a private network such as Tailscale (below).

Inside the served folder, paths and symlinks that resolve outside it are refused. Rendered pages are served with a strict Content-Security-Policy, so scripts embedded in markdown don't run.

## Reading from your phone with Tailscale

[Tailscale](https://tailscale.com) gives your devices a private network, and `tailscale serve` puts a local port on it over HTTPS, reachable only by your tailnet.

```sh
mdr ~/notes --port 7780 --no-open
tailscale serve --bg --https=10443 http://127.0.0.1:7780
```

Then open `https://<machine-name>.<tailnet>.ts.net:10443` on any device signed in to your tailnet (`tailscale serve status` shows the URL). Over HTTPS it can also be installed as a PWA from the browser's share menu. Undo it with `tailscale serve --https=10443 off`.

To keep it running in the background, start it from your OS service manager. On macOS, a launchd agent at `~/Library/LaunchAgents/com.mdreader.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mdreader</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/mdreader/bin/mdr.mjs</string>
    <string>/Users/you/notes</string>
    <string>--port</string><string>7780</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

Use absolute paths (`which node`, and `npm root -g` for a global install), then load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mdreader.plist`. macOS blocks launchd agents from reading `~/Documents`, `~/Desktop` and `~/Downloads` until the `node` binary has Full Disk Access (System Settings → Privacy & Security). On Linux, a systemd user service running the same command does the job.

## Development

```sh
npm install
npm start -- ~/notes    # same as mdr ~/notes
npm test
```

`node server.mjs` also works, configured with environment variables: `MDR_ROOT` (default: current directory), `MDR_PORT` (7780), `MDR_HOST` (127.0.0.1).

## License

[MIT](LICENSE)
