#!/usr/bin/env node
import { spawn } from 'child_process';
import fs from 'fs';

const uploadPath = '/tmp/mcp-upload.txt';
fs.writeFileSync(uploadPath, 'upload-test');

const child = spawn('/usr/bin/node', ['/srv/mcp-proxy/playwright-mcp/playwright/build/index.js'], {
  env: { ...process.env, PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS || 'true' },
  stdio: ['pipe', 'pipe', 'pipe']
});

let buffer = '';
const pending = new Map();
let id = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (_) {}
  }
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString().trim();
  if (text) process.stderr.write(`[mcp] ${text}\n`);
});

function send(method, params) {
  const reqId = id++;
  const payload = { jsonrpc: '2.0', id: reqId, method, params };
  return new Promise((resolve, reject) => {
    pending.set(reqId, resolve);
    child.stdin.write(JSON.stringify(payload) + '\n');
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        reject(new Error('Timeout for ' + method));
      }
    }, 20000);
  });
}

async function callTool(name, args = {}) {
  const res = await send('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`${name} failed: ${JSON.stringify(res.error)}`);
  const content = res.result?.content ?? [];
  const text = content.map((c) => c.text || c.type).join(' | ');
  if (text.startsWith('Error:')) {
    throw new Error(`${name} returned error content: ${text}`);
  }
  return text;
}

async function main() {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '1.0.0' }
  });

  const html = `<html><body>
    <h1 id="title">Demo</h1>
    <input id="txt" />
    <select id="sel"><option value="a">A</option><option value="b">B</option></select>
    <input id="cb" type="checkbox" />
    <input id="file" type="file" />
    <div id="src" draggable="true" style="width:100px;height:30px;background:#ddd">src</div>
    <div id="dst" style="width:100px;height:30px;background:#eee">dst</div>
    <script>
      document.getElementById('dst').addEventListener('drop', e => { e.preventDefault(); document.body.setAttribute('data-dropped','yes'); });
      document.getElementById('dst').addEventListener('dragover', e => e.preventDefault());
    </script>
  </body></html>`;
  const dataUrl = 'data:text/html,' + encodeURIComponent(html);

  const steps = [
    ['launch_browser', {}],
    ['goto_url', { url: dataUrl }],
    ['wait_for_selector', { selector: '#title', state: 'visible', timeoutMs: 5000 }],
    ['hover_element', { selector: '#title' }],
    ['fill_field', { selector: '#txt', value: 'hello' }],
    ['press_key', { key: 'Tab' }],
    ['mouse_wheel', { deltaY: 200 }],
    ['select_option', { selector: '#sel', value: 'b' }],
    ['set_checked', { selector: '#cb', checked: true }],
    ['set_input_files', { selector: '#file', filePaths: uploadPath }],
    ['drag_and_drop', { sourceSelector: '#src', targetSelector: '#dst' }],
    ['evaluate_javascript', { script: "(() => { console.log('hello-from-page'); return document.body.getAttribute('data-dropped'); })()" }],
    ['get_console_logs', { limit: 20 }],
    ['page_info', {}],
    ['tab_control', { action: 'new', url: 'about:blank' }],
    ['tab_control', { action: 'list' }],
    ['tab_control', { action: 'switch', index: 0 }],
    ['navigate_history', { action: 'reload' }],
    ['window_control', { action: 'new', url: 'data:text/html,<title>Window2</title><h1>Window2</h1>' }],
    ['window_control', { action: 'list' }],
    ['window_control', { action: 'switch', index: 0 }],
    ['window_control', { action: 'close', index: 1 }],
    ['wait_for_timeout', { timeoutMs: 100 }],
    ['tab_control', { action: 'close', index: 1 }],
    ['clear_console_logs', {}],
    ['close_browser', {}],
  ];

  for (const [name, args] of steps) {
    const out = await callTool(name, args);
    console.log(`${name}: ${out}`);
  }

  console.log('PASS: expanded capabilities working');
}

main()
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { child.kill('SIGTERM'); } catch (_) {}
  });
