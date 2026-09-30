import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) || 3000;
const host = '127.0.0.1';
const uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const conversationId = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
const projectId = process.env.ANTIGRAVITY_PROJECT_ID || '';
const agentapiExe = process.env.ANTIGRAVITY_AGENTAPI_EXE || '';

function log(...args) {
  process.stderr.write(`[probe-sidecar] ${args.join(' ')}\n`);
}

// Try locating official preload.js via sidecar_sdk if resolvable
let sdkPreloadJs = null;
try {
  const resolved = import.meta.resolve ? import.meta.resolve('sidecar_sdk') : null;
  if (resolved) {
    const sdkPath = fileURLToPath(resolved);
    const candidatePreload = join(dirname(sdkPath), '..', 'preload.js');
    if (existsSync(candidatePreload)) {
      sdkPreloadJs = readFileSync(candidatePreload, 'utf-8');
      log('Loaded official SDK preload.js from', candidatePreload);
    }
  }
} catch (e) {
  log('Could not resolve official sidecar_sdk preload.js:', e.message);
}

const fallbackPreloadJs = `
// Fallback preload shim
window.__A2UI_PRELOAD_SHIM__ = true;
window.sidecar = window.sidecar || {};
window.sidecar.agent = window.sidecar.agent || {
  sendMessage: async (text, options = {}) => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const convId = options.conversationId || params.get('conversationId') || '';
    const res = await fetch('/_sidecar/send-message' + (token ? '?token=' + encodeURIComponent(token) : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: convId,
        message: text,
        title: options.title,
        projectId: options.projectId
      })
    });
    return res.json();
  }
};
`;

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  log(`${req.method} ${pathname}`);

  // Authentication check helper
  const checkToken = () => {
    if (!uiToken) return true;
    const provided = reqUrl.searchParams.get('token') || req.headers['x-sidecar-token'];
    return provided === uiToken;
  };

  if (req.method === 'GET' && pathname === '/') {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>A2UI Probe Sidecar</title>
  <style>
    :root {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-sizing: border-box;
      line-height: 1.4;
    }
    body {
      margin: 0;
      padding: 16px;
      background: var(--background, #fff);
      color: var(--foreground, #1f1f1f);
    }
    h2, h3 { margin-top: 0; }
    .card {
      border: 1px solid var(--border, #dadce0);
      background: var(--card, rgba(0,0,0,0.02));
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    pre {
      background: rgba(0,0,0,0.05);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 12px;
      max-height: 250px;
    }
    .swatch {
      display: inline-block;
      width: 16px;
      height: 16px;
      vertical-align: middle;
      border: 1px solid #ccc;
      margin-right: 6px;
      border-radius: 3px;
    }
    button {
      background: var(--primary, #0b57d0);
      color: #fff;
      border: none;
      padding: 8px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      margin-right: 8px;
      margin-bottom: 8px;
    }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
    }
    .badge-ok { background: #e6f4ea; color: #137333; }
    .badge-warn { background: #fef7e0; color: #b06000; }
    .badge-err { background: #fce8e6; color: #c5221f; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td, th { padding: 6px; text-align: left; border-bottom: 1px solid var(--border, #eee); }
  </style>
  <script src="/preload.js"></script>
</head>
<body>
  <h2>A2UI Host Probe Diagnostics</h2>

  <div class="card">
    <h3>1. Host Theme Tokens</h3>
    <table>
      <thead><tr><th>Token Name</th><th>Computed Value</th><th>Sample</th></tr></thead>
      <tbody id="theme-tbody"></tbody>
    </table>
  </div>

  <div class="card">
    <h3>2. Client Environment & window.sidecar</h3>
    <div><strong>URL Query:</strong> <code id="url-search"></code></div>
    <div><strong>Preload Source:</strong> <span id="preload-source" class="badge"></span></div>
    <div><strong>window.sidecar:</strong> <span id="sidecar-status" class="badge"></span></div>
    <div><strong>window.sidecar.agent.sendMessage:</strong> <span id="sendmessage-status" class="badge"></span></div>
    <div style="margin-top: 10px;">
      <button onclick="testSendMessage()">Test sendMessage()</button>
      <span id="sendmessage-result"></span>
    </div>
  </div>

  <div class="card">
    <h3>3. SSE Streaming Test (/api/sse-test)</h3>
    <p>Verifies if the host/Electron proxy streams events in real-time (1/sec) or buffers them.</p>
    <div>
      <button id="btn-sse" onclick="toggleSSE()">Start SSE Stream Test</button>
      <span id="sse-status" class="badge badge-warn">Disconnected</span>
    </div>
    <div style="margin-top: 10px;">
      <div><strong>Events Received:</strong> <span id="sse-count">0</span></div>
      <div><strong>Average Interval:</strong> <span id="sse-interval">-</span></div>
      <div><strong>Buffer Verdict:</strong> <span id="sse-verdict">Waiting for events...</span></div>
    </div>
    <pre id="sse-log">Click "Start SSE Stream Test" to begin.</pre>
  </div>

  <div class="card">
    <h3>4. Sidecar Backend Environment (/api/env)</h3>
    <pre id="env-pre">Loading...</pre>
  </div>

  <script>
    // 1. Inspect Theme
    const tokens = ['--background', '--foreground', '--card', '--primary', '--border', '--muted-foreground'];
    const tbody = document.getElementById('theme-tbody');
    const computed = getComputedStyle(document.documentElement);
    tokens.forEach(tok => {
      const val = computed.getPropertyValue(tok).trim() || '(not set)';
      const tr = document.createElement('tr');
      tr.innerHTML = \`<td><code>\${tok}</code></td><td>\${val}</td><td><span class="swatch" style="background:\${val}"></span></td>\`;
      tbody.appendChild(tr);
    });

    // 2. Inspect Client Sidecar
    document.getElementById('url-search').textContent = window.location.search || '(none)';
    const isShim = window.__A2UI_PRELOAD_SHIM__;
    const preloadSource = document.getElementById('preload-source');
    if (isShim) {
      preloadSource.textContent = 'Fallback Shim';
      preloadSource.className = 'badge badge-warn';
    } else {
      preloadSource.textContent = 'Official SDK';
      preloadSource.className = 'badge badge-ok';
    }

    const sidecarStatus = document.getElementById('sidecar-status');
    if (window.sidecar) {
      sidecarStatus.textContent = 'Available';
      sidecarStatus.className = 'badge badge-ok';
    } else {
      sidecarStatus.textContent = 'Missing';
      sidecarStatus.className = 'badge badge-err';
    }

    const sendStatus = document.getElementById('sendmessage-status');
    if (window.sidecar?.agent?.sendMessage) {
      sendStatus.textContent = 'Available';
      sendStatus.className = 'badge badge-ok';
    } else {
      sendStatus.textContent = 'Missing';
      sendStatus.className = 'badge badge-err';
    }

    async function testSendMessage() {
      const resSpan = document.getElementById('sendmessage-result');
      resSpan.textContent = 'Sending...';
      try {
        const res = await window.sidecar.agent.sendMessage('[A2UI Probe] Test message from probe diagnostics UI');
        resSpan.textContent = 'Sent! Response: ' + JSON.stringify(res);
      } catch (err) {
        resSpan.textContent = 'Error: ' + err.message;
      }
    }

    // 3. SSE Stream
    let eventSource = null;
    let sseEvents = [];
    let lastTs = null;

    function toggleSSE() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
        document.getElementById('btn-sse').textContent = 'Start SSE Stream Test';
        document.getElementById('sse-status').textContent = 'Closed';
        document.getElementById('sse-status').className = 'badge badge-warn';
        return;
      }

      sseEvents = [];
      lastTs = null;
      document.getElementById('sse-count').textContent = '0';
      document.getElementById('sse-interval').textContent = '-';
      document.getElementById('sse-verdict').textContent = 'Streaming...';
      document.getElementById('sse-log').textContent = '';

      const token = new URLSearchParams(window.location.search).get('token');
      const url = '/api/sse-test' + (token ? '?token=' + encodeURIComponent(token) : '');
      eventSource = new EventSource(url);

      document.getElementById('btn-sse').textContent = 'Stop SSE Stream Test';
      document.getElementById('sse-status').textContent = 'Connecting...';
      document.getElementById('sse-status').className = 'badge badge-warn';

      eventSource.onopen = () => {
        document.getElementById('sse-status').textContent = 'Connected (streaming)';
        document.getElementById('sse-status').className = 'badge badge-ok';
      };

      eventSource.addEventListener('probe-event', (e) => {
        const now = Date.now();
        const data = JSON.parse(e.data);
        const interval = lastTs ? (now - lastTs) : null;
        lastTs = now;

        sseEvents.push({ count: data.count, interval });
        document.getElementById('sse-count').textContent = sseEvents.length;

        if (interval !== null) {
          const intervals = sseEvents.filter(x => x.interval !== null).map(x => x.interval);
          const avg = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
          document.getElementById('sse-interval').textContent = \`\${avg}ms (last: \${interval}ms)\`;

          if (sseEvents.length >= 3) {
            // If intervals are around 1000ms (+/- 300ms), it's real-time streaming!
            if (avg >= 700 && avg <= 1300) {
              document.getElementById('sse-verdict').textContent = '✅ Real-time unbuffered SSE streaming confirmed!';
              document.getElementById('sse-verdict').className = 'badge badge-ok';
            } else if (intervals.some(i => i < 100)) {
              document.getElementById('sse-verdict').textContent = '⚠️ Burst arrival detected - proxy may be buffering!';
              document.getElementById('sse-verdict').className = 'badge badge-err';
            }
          }
        }

        const logElem = document.getElementById('sse-log');
        logElem.textContent = \`[#\${data.count}] \${new Date().toLocaleTimeString()} (interval: \${interval !== null ? interval + 'ms' : 'first'})\n\` + logElem.textContent;
      });

      eventSource.onerror = (err) => {
        document.getElementById('sse-status').textContent = 'Error / Reconnecting';
        document.getElementById('sse-status').className = 'badge badge-err';
      };
    }

    // Auto-fetch /api/env
    fetch('/api/env' + window.location.search)
      .then(r => r.json())
      .then(d => {
        document.getElementById('env-pre').textContent = JSON.stringify(d, null, 2);
      })
      .catch(err => {
        document.getElementById('env-pre').textContent = 'Error fetching env: ' + err.message;
      });
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && pathname === '/preload.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(sdkPreloadJs || fallbackPreloadJs);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/env') {
    const envSnapshot = {
      port,
      hasToken: !!uiToken,
      conversationId,
      projectId,
      agentapiExe,
      nodeVersion: process.version,
      argv: process.argv,
      cwd: process.cwd(),
      interestingEnv: {},
    };
    for (const [k, v] of Object.entries(process.env)) {
      if (
        k.startsWith('ANTIGRAVITY_') ||
        k.startsWith('JETSKI_') ||
        k.startsWith('A2UI_') ||
        k.startsWith('PLUGIN_')
      ) {
        envSnapshot.interestingEnv[k] = v;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(envSnapshot, null, 2));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sse-test') {
    if (!checkToken()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let count = 0;
    // Send initial event
    res.write(
      `event: probe-event\nid: ${count}\ndata: ${JSON.stringify({ count, ts: Date.now() })}\n\n`,
    );

    const timer = setInterval(() => {
      count++;
      if (count > 60) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(
        `event: probe-event\nid: ${count}\ndata: ${JSON.stringify({ count, ts: Date.now() })}\n\n`,
      );
    }, 1000);

    req.on('close', () => {
      log('SSE client closed connection at count', count);
      clearInterval(timer);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/_sidecar/send-message') {
    if (!checkToken()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const targetConv = payload.conversationId || conversationId;
        const msg = payload.message || '';

        log(`Sending message to conv=${targetConv}: ${msg.slice(0, 80)}`);

        const exe = agentapiExe || 'agentapi';
        const args = agentapiExe
          ? ['agentapi', 'send-message', targetConv, msg]
          : ['send-message', targetConv, msg];

        execFile(exe, args, { encoding: 'utf-8' }, (err, stdout, stderr) => {
          if (err) {
            log('Error calling agentapi:', err.message, stderr);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, stderr }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, output: stdout.trim() }));
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(port, host, () => {
  log(`A2UI probe sidecar listening on http://${host}:${port}`);
});
