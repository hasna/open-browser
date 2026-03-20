# open-browser

Unified browser automation MCP for AI agents — wraps Chrome DevTools, Playwright, and Lightpanda with a common interface, screenshot compression, and switchable backends.

## Problem

`chrome-devtools-mcp` is great but has critical issues:
- `take_screenshot` returns raw PNG that can exceed 20MB, breaking MCP protocol
- No compression/resize before returning
- No backend flexibility (only Chrome)
- No smart routing (always spins up full Chrome even for simple fetches)

## Solution

`open-browser` provides:
- **Unified tool interface** — same tools work across all backends
- **Automatic screenshot compression** — max 1200px, JPEG 70%, guaranteed <500KB
- **Switchable backends** — Chrome DevTools, Playwright, Lightpanda
- **Smart auto-selection** — light pages → Lightpanda, JS apps → Chrome, cross-browser → Playwright
- **All the tools** — navigate, click, fill, snapshot, screenshot, upload, evaluate, wait

## Backends

| Backend | Speed | JS Support | Use case |
|---------|-------|------------|----------|
| **Chrome DevTools** | Medium | Full | Complex SPAs, auth flows, file uploads |
| **Playwright** | Medium | Full | Cross-browser, PDF, reliable selectors |
| **Lightpanda** | Fast (~10x) | Partial | Static pages, scraping, DOM inspection |

## Installation

```bash
bun install -g @hasna/open-browser
```

## Usage

```bash
# Default (Chrome DevTools backend)
open-browser serve

# Playwright backend
BROWSER_BACKEND=playwright open-browser serve

# Lightpanda backend
BROWSER_BACKEND=lightpanda open-browser serve
```

## MCP Tools

All tools work identically across backends:

- `navigate_page` — Go to URL
- `take_snapshot` — Get accessibility tree (text, no size issues)
- `take_screenshot` — **Compressed** screenshot (max 1200px, JPEG 70%)
- `click` — Click element by UID
- `fill` — Fill input
- `type_text` — Type text
- `press_key` — Press keyboard key
- `upload_file` — Upload file to input
- `evaluate_script` — Execute JavaScript
- `wait_for` — Wait for element/condition
- `new_page` — Open new tab
- `close_page` — Close tab
- `list_pages` — List open tabs
- `get_network_requests` — Inspect network traffic

## Status

🚧 In development. See [tasks](https://github.com/hasna/open-browser/issues) for progress.

## License

MIT
