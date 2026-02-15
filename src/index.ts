#!/usr/bin/env node

/**
 * MCP Browser Control Agent using Playwright
 *
 * Exposes browser automation actions (launch, navigate, interact, click, type, evaluate, screenshot, close, content extract)
 * as Model Context Protocol tools. Advanced and robust error handling, auto-restart, and best practices enforced.
 * 
 * FIXES for -32000 Connection closed error:
 * - Proper browser context lifecycle management
 * - Connection validation before every operation
 * - Auto-reconnect on connection loss
 * - Comprehensive error handling and recovery
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import playwright from "playwright";
import { existsSync } from "node:fs";

let browser: playwright.Browser | null = null;
let context: playwright.BrowserContext | null = null;
let page: playwright.Page | null = null;
let usingCdpConnection = false;
const consoleLogs: Array<{
  ts: string;
  type: string;
  text: string;
  url: string;
}> = [];
const maxConsoleLogs = 500;
const registeredContexts = new WeakSet<playwright.BrowserContext>();
const registeredPages = new WeakSet<playwright.Page>();

function pushConsoleLog(entry: { ts: string; type: string; text: string; url: string }) {
  consoleLogs.push(entry);
  if (consoleLogs.length > maxConsoleLogs) {
    consoleLogs.splice(0, consoleLogs.length - maxConsoleLogs);
  }
}

function attachPageHandlers(pg: playwright.Page) {
  if (registeredPages.has(pg)) {
    return;
  }
  registeredPages.add(pg);

  pg.on("console", (msg) => {
    pushConsoleLog({
      ts: new Date().toISOString(),
      type: msg.type(),
      text: msg.text(),
      url: pg.url(),
    });
  });

  pg.on("pageerror", (error) => {
    const text = error instanceof Error ? error.stack || error.message : String(error);
    pushConsoleLog({
      ts: new Date().toISOString(),
      type: "pageerror",
      text,
      url: pg.url(),
    });
    console.error("Page error:", error);
  });

  pg.on("crash", async () => {
    pushConsoleLog({
      ts: new Date().toISOString(),
      type: "crash",
      text: "Page crashed",
      url: pg.url(),
    });
    console.error("Page crashed! Attempting recovery...");
    browser = null;
    context = null;
    page = null;
    usingCdpConnection = false;
  });
}

function registerContext(ctx: playwright.BrowserContext) {
  if (registeredContexts.has(ctx)) {
    return;
  }
  registeredContexts.add(ctx);

  for (const pg of ctx.pages()) {
    attachPageHandlers(pg);
  }
  ctx.on("page", (newPage) => {
    attachPageHandlers(newPage);
  });
}

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveExecutablePath(): string {
  const configuredPath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("No Chrome/Chromium executable found. Set PLAYWRIGHT_EXECUTABLE_PATH to a valid browser binary.");
}

async function getTabsSnapshot(ctx: playwright.BrowserContext): Promise<Array<{ index: number; url: string; title: string }>> {
  const tabs = ctx.pages();
  const enriched = await Promise.all(
    tabs.map(async (pg, index) => ({ index, url: pg.url(), title: await pg.title() }))
  );
  return enriched;
}

async function getWindowsSnapshot(br: playwright.Browser): Promise<Array<{ index: number; tabs: number; activeUrl: string; activeTitle: string }>> {
  const contexts = br.contexts();
  return Promise.all(
    contexts.map(async (ctx, index) => {
      const pages = ctx.pages();
      const activePage = pages[pages.length - 1] || null;
      let activeTitle = "";
      if (activePage) {
        try {
          activeTitle = await activePage.title();
        } catch {
          activeTitle = "";
        }
      }
      return {
        index,
        tabs: pages.length,
        activeUrl: activePage?.url() || "",
        activeTitle,
      };
    })
  );
}

async function switchToWindow(index: number): Promise<playwright.Page> {
  if (!browser) {
    throw new Error("Browser not initialized");
  }

  const contexts = browser.contexts();
  if (index < 0 || index >= contexts.length) {
    throw new Error(`Invalid window index ${index}. Available windows: ${contexts.length}`);
  }

  context = contexts[index];
  registerContext(context);
  const pages = context.pages();
  page = pages[pages.length - 1] ?? await context.newPage();
  await page.bringToFront();
  return page;
}

async function switchToTab(index: number): Promise<playwright.Page> {
  if (!context) {
    throw new Error("Browser context not initialized");
  }

  const tabs = context.pages();
  if (index < 0 || index >= tabs.length) {
    throw new Error(`Invalid tab index ${index}. Available tabs: ${tabs.length}`);
  }

  page = tabs[index];
  await page.bringToFront();
  return page;
}

/**
 * Initialize (or reinitialize) the Playwright browser/context/page with robust settings.
 */
async function launchBrowser() {
  // Clean up any existing browser
  if (browser) {
    try { 
      if (usingCdpConnection) {
        if (context) {
          await context.close();
        }
      } else {
        await browser.close();
      }
    } catch (e) {
      console.error("Error closing existing browser:", e);
    }
  }
  
  browser = null;
  context = null;
  page = null;
  usingCdpConnection = false;

  const cdpUrl = process.env.PLAYWRIGHT_CDP_URL;
  const requestedHeadless = envBool("PLAYWRIGHT_HEADLESS", false);

  if (cdpUrl) {
    browser = await playwright.chromium.connectOverCDP(cdpUrl, { timeout: 60000 });
    usingCdpConnection = true;
    const existingContexts = browser.contexts();
    context = existingContexts[0] ?? await browser.newContext();
    registerContext(context);
    const pages = context.pages();
    page = pages[0] ?? await context.newPage();
    await page.bringToFront();
    console.error(`Connected to existing browser via CDP: ${cdpUrl}`);
  } else {
    const executablePath = resolveExecutablePath();

    // Launch with args to prevent crashes and connection issues.
    browser = await playwright.chromium.launch({
      executablePath,
      headless: requestedHeadless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote'
      ],
      timeout: 60000
    });

    // Create persistent context with proper settings
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    });
    registerContext(context);

    page = await context.newPage();
    console.error(`Browser launched successfully (headless=${requestedHeadless}, executable=${executablePath})`);
  }

  // Set default timeouts
  context.setDefaultTimeout(30000); // 30 seconds for operations
  context.setDefaultNavigationTimeout(60000); // 60 seconds for navigation

  pushConsoleLog({
    ts: new Date().toISOString(),
    type: "info",
    text: `Browser ready (headless=${requestedHeadless}, cdp=${Boolean(cdpUrl)})`,
    url: page.url(),
  });
}

/**
 * Check if browser/page are still connected and valid
 */
async function isConnected(): Promise<boolean> {
  if (!browser || !context || !page) {
    return false;
  }

  try {
    // Test if browser is still responsive
    if (!browser.isConnected()) {
      return false;
    }
    
    // Try a simple operation to verify page is alive
    await page.evaluate(() => true);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Validate there is an open browser/page, auto (re)launch if needed
 */
async function ensurePage(): Promise<playwright.Page> {
  const connected = await isConnected();
  
  if (!connected) {
    console.error('Browser not connected, relaunching...');
    await launchBrowser();
  }

  return page!;
}

/**
 * Wrap all operations with connection validation and auto-recovery
 */
async function safeExecute<T>(operation: (pg: playwright.Page) => Promise<T>): Promise<T> {
  let retries = 0;
  const maxRetries = 2;

  while (retries <= maxRetries) {
    try {
      const pg = await ensurePage();
      return await operation(pg);
    } catch (e: any) {
      const isConnectionError = 
        e.message?.includes('Connection closed') ||
        e.message?.includes('Browser has been closed') ||
        e.message?.includes('Target closed') ||
        e.message?.includes('Session closed') ||
        e.message?.includes('Protocol error');

      if (isConnectionError && retries < maxRetries) {
        console.error(`Connection error detected (attempt ${retries + 1}/${maxRetries}): ${e.message}`);
        browser = null;
        context = null;
        page = null;
        usingCdpConnection = false;
        retries++;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
        continue;
      }
      
      throw e;
    }
  }

  throw new Error('Max retries exceeded for browser operation');
}

/**
 * MCP Server with browser control tools (basic + advanced)
 */
const server = new Server(
  {
    name: "playwright-browser-agent",
    version: "0.6.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

// MCP: List available browser control tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "launch_browser",
        description: "Start or restart a fresh browser instance",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "goto_url",
        description: "Navigate to a web page URL",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", description: "URL to visit" } },
          required: ["url"]
        }
      },
      {
        name: "screenshot",
        description: "Take a screenshot of the current page and return base64 PNG",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "extract_content",
        description: "Extract full HTML and optional text content of the current page",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "close_browser",
        description: "Gracefully close the browser and free resources",
        inputSchema: { type: "object", properties: {} }
      },
      // Advanced browser control tools
      {
        name: "click_element",
        description: "Click an element by CSS selector",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string", description: "CSS selector to click" } },
          required: ["selector"]
        }
      },
      {
        name: "type_text",
        description: "Type text into an element by selector",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            text: { type: "string", description: "Text to type" }
          },
          required: ["selector", "text"]
        }
      },
      {
        name: "fill_field",
        description: "Fill a value into a form field by selector",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            value: { type: "string", description: "Value to fill" }
          },
          required: ["selector", "value"]
        }
      },
      {
        name: "evaluate_javascript",
        description: "Evaluate custom JavaScript in page context",
        inputSchema: {
          type: "object",
          properties: { script: { type: "string", description: "JS to run in browser" } },
          required: ["script"]
        }
      },
      {
        name: "get_element_attribute",
        description: "Get an attribute from an element by selector",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            attribute: { type: "string", description: "Attribute to fetch" }
          },
          required: ["selector", "attribute"]
        }
      },
      {
        name: "scroll_to_element",
        description: "Scroll viewport to bring a selector into view",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector to scroll to" }
          },
          required: ["selector"]
        }
      },
      {
        name: "hover_element",
        description: "Hover over an element by CSS selector",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector to hover" }
          },
          required: ["selector"]
        }
      },
      {
        name: "press_key",
        description: "Press a keyboard key on the page",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name, e.g. Enter, Tab, ArrowDown" }
          },
          required: ["key"]
        }
      },
      {
        name: "mouse_wheel",
        description: "Scroll the page with mouse wheel deltas",
        inputSchema: {
          type: "object",
          properties: {
            deltaX: { type: "number", description: "Horizontal wheel delta", default: 0 },
            deltaY: { type: "number", description: "Vertical wheel delta", default: 800 }
          }
        }
      },
      {
        name: "wait_for_selector",
        description: "Wait for an element state on the page",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            state: { type: "string", description: "attached, detached, visible, hidden" },
            timeoutMs: { type: "number", description: "Timeout in milliseconds", default: 30000 }
          },
          required: ["selector"]
        }
      },
      {
        name: "wait_for_timeout",
        description: "Pause for a number of milliseconds",
        inputSchema: {
          type: "object",
          properties: {
            timeoutMs: { type: "number", description: "Delay in milliseconds", default: 1000 }
          }
        }
      },
      {
        name: "select_option",
        description: "Select a value/label/index in a select element",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "Select element CSS selector" },
            value: { type: "string", description: "Option value" },
            label: { type: "string", description: "Option label" },
            index: { type: "number", description: "Option index" }
          },
          required: ["selector"]
        }
      },
      {
        name: "set_checked",
        description: "Set checked state for checkbox/radio",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "Checkbox/radio CSS selector" },
            checked: { type: "boolean", description: "True to check, false to uncheck", default: true }
          },
          required: ["selector"]
        }
      },
      {
        name: "set_input_files",
        description: "Upload one or multiple files to file input",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "File input CSS selector" },
            filePaths: {
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } }
              ],
              description: "Absolute file path or list of paths"
            }
          },
          required: ["selector", "filePaths"]
        }
      },
      {
        name: "drag_and_drop",
        description: "Drag source selector onto target selector",
        inputSchema: {
          type: "object",
          properties: {
            sourceSelector: { type: "string", description: "Source element selector" },
            targetSelector: { type: "string", description: "Target element selector" }
          },
          required: ["sourceSelector", "targetSelector"]
        }
      },
      {
        name: "navigate_history",
        description: "Navigate browser history or reload page",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "back, forward, reload" }
          },
          required: ["action"]
        }
      },
      {
        name: "tab_control",
        description: "List/create/switch/close tabs",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "list, new, switch, close" },
            url: { type: "string", description: "URL for new tab" },
            index: { type: "number", description: "Tab index for switch/close" }
          },
          required: ["action"]
        }
      },
      {
        name: "window_control",
        description: "List/create/switch/close browser windows",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "list, new, switch, close" },
            url: { type: "string", description: "URL for new window" },
            index: { type: "number", description: "Window index for switch/close" }
          },
          required: ["action"]
        }
      },
      {
        name: "get_console_logs",
        description: "Read browser console/pageerror logs captured so far",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max number of most recent log lines", default: 100 },
            clear: { type: "boolean", description: "Clear logs after reading", default: false }
          }
        }
      },
      {
        name: "clear_console_logs",
        description: "Clear captured browser console logs",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "page_info",
        description: "Get current page metadata",
        inputSchema: { type: "object", properties: {} }
      },
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  try {
    switch (name) {
      case "launch_browser":
        await launchBrowser();
        return { content: [{ type: "text", text: "Browser launched successfully." }] };
        
      case "goto_url": {
        const url = String(request.params.arguments?.url);
        if (!url) throw new Error("Missing URL");
        
        await safeExecute(async (pg) => {
          await pg.goto(url, { waitUntil: 'domcontentloaded' });
        });
        
        return { content: [{ type: "text", text: `Navigated to: ${url}` }] };
      }
      
      case "screenshot": {
        const buffer = await safeExecute(async (pg) => {
          return await pg.screenshot({ type: "png" });
        });
        
        return { content: [{ type: "image", encoding: "base64", data: buffer.toString("base64"), mimeType: "image/png" }] };
      }
      
      case "extract_content": {
        const result = await safeExecute(async (pg) => {
          const html = await pg.content();
          const text = await pg.evaluate(() => document.body?.innerText || "");
          return { html, text };
        });
        
        return { content: [
            { type: "text", text: `TEXT:\n${result.text.slice(0, 1000)}...` },
            { type: "text", text: `HTML:\n${result.html.slice(0, 2000)}...` }
        ] };
      }
      
      case "close_browser":
        if (browser) {
          try {
            if (usingCdpConnection) {
              if (context) {
                await context.close();
              }
            } else {
              await browser.close();
            }
          } catch (e) {
            console.error('Error closing browser:', e);
          }
        }
        browser = null;
        context = null;
        page = null;
        usingCdpConnection = false;
        consoleLogs.length = 0;
        return { content: [{ type: "text", text: "Browser closed successfully." }] };
        
      // Advanced tools
      case "click_element": {
        const selector = String(request.params.arguments?.selector);
        if (!selector) throw new Error("Missing selector");
        
        await safeExecute(async (pg) => {
          await pg.click(selector);
        });
        
        return { content: [{ type: "text", text: `Clicked element: ${selector}` }] };
      }
      
      case "type_text": {
        const selector = String(request.params.arguments?.selector);
        const text = String(request.params.arguments?.text ?? "");
        if (!selector) throw new Error("Missing selector");
        
        await safeExecute(async (pg) => {
          await pg.type(selector, text);
        });
        
        return { content: [{ type: "text", text: `Typed text '${text}' into: ${selector}` }] };
      }
      
      case "fill_field": {
        const selector = String(request.params.arguments?.selector);
        const value = String(request.params.arguments?.value ?? "");
        if (!selector) throw new Error("Missing selector");
        
        await safeExecute(async (pg) => {
          await pg.fill(selector, value);
        });
        
        return { content: [{ type: "text", text: `Filled value '${value}' into: ${selector}` }] };
      }
      
      case "evaluate_javascript": {
        const script = String(request.params.arguments?.script ?? "");
        if (!script) throw new Error("Missing script");
        
        const value = await safeExecute(async (pg) => {
          return await pg.evaluate(script);
        });
        
        return { content: [{ type: "text", text: `JS result: ${JSON.stringify(value)}` }] };
      }
      
      case "get_element_attribute": {
        const selector = String(request.params.arguments?.selector);
        const attribute = String(request.params.arguments?.attribute);
        if (!selector || !attribute) throw new Error("Missing selector or attribute");
        
        const value = await safeExecute(async (pg) => {
          return await pg.getAttribute(selector, attribute);
        });
        
        return { content: [{ type: "text", text: `Attribute '${attribute}' of ${selector} is: '${value}'` }] };
      }
      
      case "scroll_to_element": {
        const selector = String(request.params.arguments?.selector);
        if (!selector) throw new Error("Missing selector");
        
        await safeExecute(async (pg) => {
          await pg.$eval(selector, el => el.scrollIntoView({ behavior: "smooth", block: "center" }));
        });
        
        return { content: [{ type: "text", text: `Scrolled to selector: ${selector}` }] };
      }

      case "hover_element": {
        const selector = String(request.params.arguments?.selector);
        if (!selector) throw new Error("Missing selector");

        await safeExecute(async (pg) => {
          await pg.hover(selector);
        });

        return { content: [{ type: "text", text: `Hovered element: ${selector}` }] };
      }

      case "press_key": {
        const key = String(request.params.arguments?.key ?? "");
        if (!key) throw new Error("Missing key");

        await safeExecute(async (pg) => {
          await pg.keyboard.press(key);
        });

        return { content: [{ type: "text", text: `Pressed key: ${key}` }] };
      }

      case "mouse_wheel": {
        const deltaX = toNumber(request.params.arguments?.deltaX, 0);
        const deltaY = toNumber(request.params.arguments?.deltaY, 800);

        await safeExecute(async (pg) => {
          await pg.mouse.wheel(deltaX, deltaY);
        });

        return { content: [{ type: "text", text: `Mouse wheel moved by (${deltaX}, ${deltaY})` }] };
      }

      case "wait_for_selector": {
        const selector = String(request.params.arguments?.selector ?? "");
        const state = String(request.params.arguments?.state ?? "visible") as "attached" | "detached" | "visible" | "hidden";
        const timeoutMs = toNumber(request.params.arguments?.timeoutMs, 30000);
        if (!selector) throw new Error("Missing selector");

        await safeExecute(async (pg) => {
          await pg.waitForSelector(selector, { state, timeout: timeoutMs });
        });

        return { content: [{ type: "text", text: `Selector ready: ${selector} (${state})` }] };
      }

      case "wait_for_timeout": {
        const timeoutMs = Math.max(0, toNumber(request.params.arguments?.timeoutMs, 1000));
        await safeExecute(async (pg) => {
          await pg.waitForTimeout(timeoutMs);
        });
        return { content: [{ type: "text", text: `Waited ${timeoutMs}ms` }] };
      }

      case "select_option": {
        const selector = String(request.params.arguments?.selector ?? "");
        if (!selector) throw new Error("Missing selector");

        const valueArg = request.params.arguments?.value;
        const labelArg = request.params.arguments?.label;
        const indexArg = request.params.arguments?.index;

        if (valueArg === undefined && labelArg === undefined && indexArg === undefined) {
          throw new Error("Provide one of value, label, or index");
        }

        const selected = await safeExecute(async (pg) => {
          if (valueArg !== undefined) {
            return pg.selectOption(selector, { value: String(valueArg) });
          }
          if (labelArg !== undefined) {
            return pg.selectOption(selector, { label: String(labelArg) });
          }
          return pg.selectOption(selector, { index: toNumber(indexArg, 0) });
        });

        return { content: [{ type: "text", text: `Selected option(s): ${selected.join(", ")}` }] };
      }

      case "set_checked": {
        const selector = String(request.params.arguments?.selector ?? "");
        const checked = request.params.arguments?.checked === undefined ? true : Boolean(request.params.arguments?.checked);
        if (!selector) throw new Error("Missing selector");

        await safeExecute(async (pg) => {
          await pg.setChecked(selector, checked);
        });

        return { content: [{ type: "text", text: `Set checked=${checked} for ${selector}` }] };
      }

      case "set_input_files": {
        const selector = String(request.params.arguments?.selector ?? "");
        const filePaths = request.params.arguments?.filePaths;
        if (!selector) throw new Error("Missing selector");
        if (!filePaths) throw new Error("Missing filePaths");

        const normalized = Array.isArray(filePaths)
          ? filePaths.map((item) => String(item))
          : [String(filePaths)];

        await safeExecute(async (pg) => {
          await pg.setInputFiles(selector, normalized);
        });

        return { content: [{ type: "text", text: `Uploaded ${normalized.length} file(s) into ${selector}` }] };
      }

      case "drag_and_drop": {
        const sourceSelector = String(request.params.arguments?.sourceSelector ?? "");
        const targetSelector = String(request.params.arguments?.targetSelector ?? "");
        if (!sourceSelector || !targetSelector) throw new Error("Missing sourceSelector or targetSelector");

        await safeExecute(async (pg) => {
          await pg.dragAndDrop(sourceSelector, targetSelector);
        });

        return { content: [{ type: "text", text: `Dragged ${sourceSelector} -> ${targetSelector}` }] };
      }

      case "navigate_history": {
        const action = String(request.params.arguments?.action ?? "").toLowerCase();
        if (!["back", "forward", "reload"].includes(action)) {
          throw new Error("Invalid action. Use back, forward, or reload");
        }

        await safeExecute(async (pg) => {
          if (action === "back") {
            await pg.goBack({ waitUntil: "domcontentloaded" });
          } else if (action === "forward") {
            await pg.goForward({ waitUntil: "domcontentloaded" });
          } else {
            await pg.reload({ waitUntil: "domcontentloaded" });
          }
        });

        const currentUrl = await safeExecute(async (pg) => pg.url());
        return { content: [{ type: "text", text: `Navigation action '${action}' complete. URL: ${currentUrl}` }] };
      }

      case "tab_control": {
        const action = String(request.params.arguments?.action ?? "").toLowerCase();
        if (!context) {
          await ensurePage();
        }

        if (!context) {
          throw new Error("Failed to initialize browser context");
        }

        if (action === "list") {
          const tabs = await getTabsSnapshot(context);
          return { content: [{ type: "text", text: `Tabs: ${JSON.stringify(tabs)}` }] };
        }

        if (action === "new") {
          const url = String(request.params.arguments?.url ?? "about:blank");
          const newPage = await context.newPage();
          await newPage.goto(url, { waitUntil: "domcontentloaded" });
          page = newPage;
          return { content: [{ type: "text", text: `Opened new tab: ${newPage.url()}` }] };
        }

        if (action === "switch") {
          const index = Math.trunc(toNumber(request.params.arguments?.index, -1));
          if (index < 0) {
            throw new Error("Missing valid tab index for switch action");
          }
          const switched = await switchToTab(index);
          return { content: [{ type: "text", text: `Switched to tab ${index}: ${switched.url()}` }] };
        }

        if (action === "close") {
          const tabs = context.pages();
          const requestedIndex = request.params.arguments?.index;
          const index = requestedIndex === undefined
            ? tabs.findIndex((pg) => pg === page)
            : Math.trunc(toNumber(requestedIndex, -1));

          if (index < 0 || index >= tabs.length) {
            throw new Error(`Invalid tab index ${index}`);
          }

          await tabs[index].close();
          const remaining = context.pages();
          if (remaining.length === 0) {
            page = await context.newPage();
          } else {
            page = remaining[Math.min(index, remaining.length - 1)];
            await page.bringToFront();
          }

          return { content: [{ type: "text", text: `Closed tab ${index}. Active URL: ${page.url()}` }] };
        }

        throw new Error("Invalid action. Use list, new, switch, or close");
      }

      case "window_control": {
        const action = String(request.params.arguments?.action ?? "").toLowerCase();
        if (!browser) {
          await ensurePage();
        }

        if (!browser) {
          throw new Error("Failed to initialize browser");
        }

        if (action === "list") {
          const windows = await getWindowsSnapshot(browser);
          return { content: [{ type: "text", text: `Windows: ${JSON.stringify(windows)}` }] };
        }

        if (action === "new") {
          const url = String(request.params.arguments?.url ?? "about:blank");
          const newContext = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
          });
          registerContext(newContext);
          const newPage = await newContext.newPage();
          await newPage.goto(url, { waitUntil: "domcontentloaded" });
          context = newContext;
          page = newPage;
          await page.bringToFront();
          return { content: [{ type: "text", text: `Opened new window: ${newPage.url()}` }] };
        }

        if (action === "switch") {
          const index = Math.trunc(toNumber(request.params.arguments?.index, -1));
          if (index < 0) {
            throw new Error("Missing valid window index for switch action");
          }
          const switched = await switchToWindow(index);
          return { content: [{ type: "text", text: `Switched to window ${index}: ${switched.url()}` }] };
        }

        if (action === "close") {
          const windows = browser.contexts();
          const requestedIndex = request.params.arguments?.index;
          const currentIndex = context ? windows.findIndex((ctx) => ctx === context) : -1;
          const index = requestedIndex === undefined
            ? currentIndex
            : Math.trunc(toNumber(requestedIndex, -1));

          if (index < 0 || index >= windows.length) {
            throw new Error(`Invalid window index ${index}`);
          }

          await windows[index].close();
          const remaining = browser.contexts();
          if (remaining.length === 0) {
            context = await browser.newContext({
              viewport: { width: 1920, height: 1080 },
              userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            });
            registerContext(context);
            page = await context.newPage();
          } else {
            context = remaining[Math.min(index, remaining.length - 1)];
            const pages = context.pages();
            page = pages[pages.length - 1] ?? await context.newPage();
          }

          await page.bringToFront();
          return { content: [{ type: "text", text: `Closed window ${index}. Active URL: ${page.url()}` }] };
        }

        throw new Error("Invalid action. Use list, new, switch, or close");
      }

      case "get_console_logs": {
        const limit = Math.max(1, Math.trunc(toNumber(request.params.arguments?.limit, 100)));
        const clear = Boolean(request.params.arguments?.clear ?? false);
        const logs = consoleLogs.slice(-limit);
        const text = logs.length === 0
          ? "No console logs captured yet"
          : logs.map((entry) => `[${entry.ts}] [${entry.type}] ${entry.text} (${entry.url})`).join("\n");
        if (clear) {
          consoleLogs.length = 0;
        }
        return { content: [{ type: "text", text }] };
      }

      case "clear_console_logs": {
        const previous = consoleLogs.length;
        consoleLogs.length = 0;
        return { content: [{ type: "text", text: `Cleared ${previous} console log entries` }] };
      }

      case "page_info": {
        const info = await safeExecute(async (pg) => {
          const title = await pg.title();
          const url = pg.url();
          return { title, url, tabCount: context?.pages().length ?? 0, windowCount: browser?.contexts().length ?? 0 };
        });

        return { content: [{ type: "text", text: `Page info: ${JSON.stringify(info)}` }] };
      }
       
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e: any) {
    console.error(`Tool ${name} error:`, e);
    return { content: [{ type: "text", text: `Error: ${e.message || e}` }] };
  }
});

/**
 * Start the server using stdio transport for Model Context Protocol communication.
 */
async function main() {
  try {
    await launchBrowser();
  } catch(e) {
    console.error('Initial browser launch failed, will retry on first tool call:', e);
  }
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('MCP Playwright Browser Agent ready');
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
