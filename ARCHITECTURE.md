# open-browser Architecture

## Overview

open-browser is a unified browser automation MCP server with three swappable backends: Chrome DevTools, Playwright, and Lightpanda.

## Backend Comparison

| Feature | Chrome DevTools | Playwright | Lightpanda |
|---------|----------------|------------|------------|
| Speed | Medium | Medium | **11× faster** |
| Memory | ~207MB | ~200MB | **24MB** |
| JS execution | Full V8 | Full V8 | Full V8 (ES2024) |
| Screenshots | ✅ | ✅ | ❌ (no renderer) |
| PDF export | ❌ | ✅ | ❌ |
| Cross-browser | Chrome only | Chrome/Firefox/WebKit | Chrome-like only |
| CDP protocol | ✅ | Via adapter | ✅ (22 domains) |
| Lighthouse | ✅ | ❌ | ❌ |
| Best for | Complex apps, auth | Cross-browser, PDF | Scraping, extraction |

## Backend Selection

Three-tier precedence:

1. **Per-call** `{ backend: 'playwright' }` — highest priority
2. **Env var** `OPEN_BROWSER_BACKEND=playwright`
3. **Config** `~/.config/open-browser/config.json → { "defaultBackend": "chrome" }`

### Auto-routing rules

| Tool | Backend |
|------|---------|
| `take_screenshot` | Never Lightpanda → Chrome or Playwright |
| `export_pdf` | Playwright only |
| `lighthouse_audit` | Chrome only |
| `performance_trace` | Chrome only |
| `navigate` + `snapshot` (no screenshot) | Lightpanda (fastest) |
| Default | Chrome |

## Screenshot Compression

All screenshots are post-processed via Sharp before returning through MCP:

```typescript
import sharp from 'sharp';

async function compressScreenshot(rawBuffer: Buffer): Promise<Buffer> {
  return sharp(rawBuffer)
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
}
```

**Result:** Guaranteed <500KB per screenshot (vs chrome-devtools-mcp's potential 20MB+).

User-configurable via env: `BROWSER_SCREENSHOT_FORMAT`, `BROWSER_SCREENSHOT_QUALITY`, `BROWSER_SCREENSHOT_MAX_WIDTH`.

### Why chrome-devtools-mcp breaks

chrome-devtools-mcp uses its own 4-stage Sharp pipeline (max 900×600, WebP→PNG fallback) but returns the raw buffer through MCP which can exceed 20MB on complex pages. open-browser enforces the size cap deterministically.

## Tool Set

### Common tools (all backends)

| Tool | Description |
|------|-------------|
| `navigate_page` | Go to URL |
| `take_snapshot` | Accessibility tree (text, no size issues) |
| `take_screenshot` | Compressed screenshot (max 1200px, JPEG 70%) |
| `click` | Click element by UID |
| `fill` | Fill input field |
| `type_text` | Type text into focused element |
| `press_key` | Press keyboard key |
| `upload_file` | Upload file to input |
| `evaluate_script` | Execute JavaScript |
| `wait_for` | Wait for element/condition |
| `new_page` | Open new tab |
| `close_page` | Close tab |
| `list_pages` | List open tabs |
| `select_page` | Switch to tab |
| `get_network_requests` | Inspect network traffic |
| `handle_dialog` | Accept/dismiss browser dialogs |

### Additional tools (beyond chrome-devtools-mcp)

| Tool | Backend | Description |
|------|---------|-------------|
| `get_page_text` | All | Extract visible text (no full DOM dump) |
| `get_links` | All | Return all href values from `<a>` tags |
| `scroll_to` | All | Scroll to element or position |
| `select_option` | All | Select dropdown option |
| `set_cookies` / `get_cookies` | All | Session management |
| `network_block` | Chrome/Playwright | Block resource types before load |
| `export_pdf` | Playwright | Generate PDF |
| `get_accessibility_tree` | Playwright | Structured semantic snapshot (low-token) |

### Chrome-only tools

`lighthouse_audit`, `performance_start_trace`, `performance_stop_trace`, `take_memory_snapshot`

## Installation (Backends)

### Chrome DevTools

```bash
# Chrome must be running with remote debugging enabled
# chrome-devtools-mcp handles this automatically
```

### Playwright

```bash
bun add playwright-core
npx playwright install chromium
```

### Lightpanda

```bash
bun add @lightpanda/browser puppeteer-core
# Binary auto-downloaded to ~/.cache/lightpanda-node
```

Usage:
```typescript
import { lightpanda } from '@lightpanda/browser';
const proc = await lightpanda.serve({ host: '127.0.0.1', port: 9222 });
// Connect via puppeteer or playwright CDP
```

## Project Structure

```
open-browser/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── backends/
│   │   ├── base.ts           # Backend interface
│   │   ├── chrome.ts         # Chrome DevTools backend
│   │   ├── playwright.ts     # Playwright backend
│   │   └── lightpanda.ts     # Lightpanda backend
│   ├── tools/
│   │   ├── navigation.ts     # navigate, new_page, close_page, list_pages
│   │   ├── interaction.ts    # click, fill, type_text, press_key, upload_file
│   │   ├── capture.ts        # screenshot, snapshot, accessibility_tree
│   │   ├── network.ts        # network requests, blocking, cookies
│   │   └── debug.ts          # evaluate, console, lighthouse, performance
│   ├── compress.ts           # Sharp screenshot compression pipeline
│   └── resolver.ts           # Backend resolution (per-call → env → config)
├── package.json
├── README.md
└── ARCHITECTURE.md
```

## References

- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Lightpanda](https://github.com/lightpanda-io/browser) — 11× faster headless browser in Zig
- [@playwright/mcp](https://github.com/microsoft/playwright-mcp) — Microsoft's official Playwright MCP
- [Sharp](https://sharp.pixelplumbing.com/) — image compression
