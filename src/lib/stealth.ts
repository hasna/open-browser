import type { Page } from "playwright";

// ─── Stealth Patches ────────────────────────────────────────────────────────
// Makes automated Playwright sessions harder to detect by overriding common
// bot-detection signals.  Applied once per page via addInitScript so every
// navigation re-injects the patches automatically.

const REALISTIC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const STEALTH_SCRIPT = `
// ── 1. Remove navigator.webdriver flag ──────────────────────────────────────
Object.defineProperty(navigator, 'webdriver', {
  get: () => false,
  configurable: true,
});

// ── 2. Override navigator.plugins to show typical Chrome plugins ────────────
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
    ];
    // Mimic PluginArray interface
    const pluginArray = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { value: p.name, enumerable: true },
        filename: { value: p.filename, enumerable: true },
        description: { value: p.description, enumerable: true },
        length: { value: p.length, enumerable: true },
      });
      pluginArray[i] = plugin;
    });
    Object.defineProperty(pluginArray, 'length', { value: plugins.length });
    pluginArray.item = (i) => pluginArray[i] || null;
    pluginArray.namedItem = (name) => plugins.find(p => p.name === name) ? pluginArray[plugins.findIndex(p => p.name === name)] : null;
    pluginArray.refresh = () => {};
    return pluginArray;
  },
  configurable: true,
});

// ── 3. Override navigator.languages ─────────────────────────────────────────
Object.defineProperty(navigator, 'languages', {
  get: () => ['en-US', 'en'],
  configurable: true,
});

// ── 4. Override chrome.runtime to appear like real Chrome ────────────────────
if (!window.chrome) {
  window.chrome = {};
}
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {} }; },
    sendMessage: function() {},
    onMessage: { addListener: function() {}, removeListener: function() {} },
    id: undefined,
  };
}
`;

export async function applyStealthPatches(page: Page): Promise<void> {
  // Set realistic user-agent at the context level
  await page.context().addInitScript(STEALTH_SCRIPT);

  // Also override user-agent header for all requests from this context
  await page.context().setExtraHTTPHeaders({
    "User-Agent": REALISTIC_USER_AGENT,
  });
}

export { REALISTIC_USER_AGENT };
