# Playwright MCP Desktop Integration

Use this when you want OpenCode's `playwright` MCP server to control a visible desktop browser.

## Current status
- OpenCode already points to this local server: `playwright/build/index.js`
- OpenCode launcher now forces desktop-visible mode (`PLAYWRIGHT_HEADLESS=false`)
- Optional CDP attach mode is supported for controlling an already-open Chrome

## Environment variables
- `PLAYWRIGHT_HEADLESS`
  - `run-mcp.sh` forces this to `false` so OpenCode always uses visible browser windows
  - for automated testing, call `build/index.js` directly with `PLAYWRIGHT_HEADLESS=true`
- `PLAYWRIGHT_EXECUTABLE_PATH` (default: `/usr/bin/chromium-browser`)
  - Set a custom Chrome/Chromium binary path
- `PLAYWRIGHT_CDP_URL` (optional)
  - Example: `http://127.0.0.1:9222`
  - If set, the MCP server attaches to an existing Chrome started with remote debugging

## Option A: Let MCP launch visible browser
No extra setup needed. Start/restart OpenCode and use playwright tools normally.

## Option B: Attach MCP to your already-open Chrome (recommended)
1. Start Chrome with debugging enabled:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-mcp" --new-window
```

2. Start OpenCode with env vars:

```bash
PLAYWRIGHT_CDP_URL=http://127.0.0.1:9222 PLAYWRIGHT_HEADLESS=false opencode
```

Now MCP actions control that physical Chrome window directly.

## Quick verification
Inside OpenCode, run a prompt such as:

"Use playwright to open https://example.com, scroll, and take a screenshot."

Expected:
- browser actions occur on your desktop window
- MCP responds without `-32000 Connection closed`

## Antigravity-style capabilities now supported
- Navigation: open URL, back, forward, reload
- Interaction: click, hover, type, fill, press key
- Scrolling: wheel scroll, scroll to element
- Waiting: wait for selector state, wait timeout
- Forms: select dropdown option, set checkbox/radio state, upload files
- Tabs: list, create, switch, close
- Windows: list, create, switch, close
- Utilities: evaluate JavaScript, get element attribute, extract content, screenshot, page info
- Observability: read and clear browser console logs and page errors

## Capability test (deterministic)
Run this test suite to verify the expanded browser controls:

```bash
cd /srv/mcp-proxy/playwright-mcp/playwright
npm run test:capabilities
```

Default test mode is headless. To watch the browser physically:

```bash
cd /srv/mcp-proxy/playwright-mcp/playwright
PLAYWRIGHT_HEADLESS=false npm run test:capabilities
```
