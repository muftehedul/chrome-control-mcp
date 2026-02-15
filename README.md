# Chrome Control MCP (Playwright)

An MCP server that gives AI agents Antigravity-style browser control using Playwright.

It supports visible desktop browser automation, tab/window management, form interaction, file upload, drag-and-drop, JS evaluation, screenshots, page extraction, and console log capture.

## Capabilities

- Browser lifecycle: launch, navigate, close
- Interaction: click, hover, type, fill, press key
- Scrolling: mouse wheel, scroll to element
- Waits: wait for selector, wait timeout
- Forms: select option, set checked state, upload files
- Navigation: back, forward, reload
- Tabs: list/new/switch/close
- Windows: list/new/switch/close
- Diagnostics: page info, extract content, screenshot
- Observability: get/clear console logs and page errors

## Quick Start

```bash
npm install
npm run build
```

Run the MCP server:

```bash
./run-mcp.sh
```

`run-mcp.sh` forces visible mode (`PLAYWRIGHT_HEADLESS=false`) and auto-attaches to Chrome CDP on `http://127.0.0.1:9222` if available.

## Recommended Desktop Setup

Start Chrome with remote debugging so MCP controls your real desktop browser:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-mcp" --new-window
```

Then start MCP:

```bash
./run-mcp.sh
```

## OpenCode Configuration

Add this to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": [
        "/absolute/path/to/chrome-control-mcp/run-mcp.sh"
      ]
    }
  }
}
```

## Validation

Run deterministic capability tests:

```bash
npm run test:capabilities
```

Run tests in visible mode:

```bash
PLAYWRIGHT_HEADLESS=false npm run test:capabilities
```

## Files

- `src/index.ts` - MCP server source
- `build/index.js` - compiled server
- `run-mcp.sh` - launcher used by MCP clients
- `test-capabilities.js` - regression test for tools
- `PLAYWRIGHT_MCP_DESKTOP_INTEGRATION.md` - desktop integration notes
