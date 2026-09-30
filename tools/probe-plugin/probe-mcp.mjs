#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(...args) {
  process.stderr.write(`[probe-mcp] ${args.join(' ')}\n`);
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req = JSON.parse(trimmed);
    handleRequest(req);
  } catch (err) {
    log('Failed to parse input line:', err.message);
  }
});

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'a2ui-probe',
          version: '0.1.0',
        },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    log('Client initialized');
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'probe_env',
            description:
              'Returns environment variables, paths, and process metadata for this MCP server.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'probe_embed',
            description:
              'Writes a test HTML file to ${PLUGIN_DATA} and returns an <agent-embed> snippet.',
            inputSchema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Title to display in the test embed' },
              },
            },
          },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'probe_env') {
      const interestingKeys = [
        'A2UI_PROBE_DATA',
        'A2UI_PROBE_ROOT',
        'PLUGIN_DATA',
        'PLUGIN_ROOT',
        'ANTIGRAVITY_CONVERSATION_ID',
        'ANTIGRAVITY_PROJECT_ID',
        'ANTIGRAVITY_LS_ADDRESS',
        'ANTIGRAVITY_AGENTAPI_EXE',
        'ANTIGRAVITY_SIDECAR_WEB_PORT',
        'ANTIGRAVITY_SIDECAR_UI_TOKEN',
        'PATH',
        'USER',
        'HOME',
        'SHELL',
      ];

      const envSnapshot = {};
      for (const k of interestingKeys) {
        if (process.env[k] !== undefined) {
          envSnapshot[k] = process.env[k];
        }
      }

      const allKeys = Object.keys(process.env).sort();

      const resultData = {
        nodeVersion: process.version,
        execPath: process.execPath,
        cwd: process.cwd(),
        argv: process.argv,
        pid: process.pid,
        interestingEnv: envSnapshot,
        allEnvKeyCount: allKeys.length,
        allEnvKeys: allKeys,
      };

      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resultData, null, 2),
            },
          ],
        },
      });
      return;
    }

    if (toolName === 'probe_embed') {
      const dataDir = process.env.A2UI_PROBE_DATA || process.env.PLUGIN_DATA || '/tmp';
      const embedDir = join(dataDir, 'probe-embed');
      try {
        if (!existsSync(embedDir)) {
          mkdirSync(embedDir, { recursive: true });
        }
        const filePath = join(embedDir, 'test-embed.html');
        const title = args.title || 'A2UI Probe Test Card';
        const timestamp = new Date().toISOString();

        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root {
      font-family: system-ui, -apple-system, sans-serif;
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 16px;
      background: var(--background, #ffffff);
      color: var(--foreground, #1f1f1f);
    }
    .card {
      border: 1px solid var(--border, #dadce0);
      background: var(--card, rgba(0,0,0,0.02));
      border-radius: 8px;
      padding: 16px;
    }
    h3 {
      margin-top: 0;
      color: var(--primary, #0b57d0);
    }
    button {
      background: var(--primary, #0b57d0);
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
    }
    .meta {
      font-size: 12px;
      color: var(--muted-foreground, #70757a);
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h3>${title}</h3>
    <p>This is a test snapshot rendered via <code>&lt;agent-embed&gt;</code>.</p>
    <button onclick="sendPrompt()">Send Test Prompt</button>
    <div class="meta">Rendered at: ${timestamp}</div>
  </div>
  <script>
    function sendPrompt() {
      window.parent.postMessage({
        type: 'PROMPT',
        prompt: '[A2UI Probe] Clicked test button in embed card at ${timestamp}'
      }, '*');
    }
    // Inform host of size
    window.parent.postMessage({
      type: 'RESIZE',
      height: document.body.scrollHeight
    }, '*');
  </script>
</body>
</html>`;

        writeFileSync(filePath, html, 'utf-8');

        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Wrote embed test card to file://${filePath}\n\nTag to display inline:\n<agent-embed src="file://${filePath}"></agent-embed>`,
              },
            ],
          },
        });
        return;
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          isError: true,
          result: {
            content: [
              {
                type: 'text',
                text: `Error creating embed file: ${err.message}`,
              },
            ],
          },
        });
        return;
      }
    }

    send({
      jsonrpc: '2.0',
      id,
      isError: true,
      error: {
        code: -32601,
        message: `Unknown tool: ${toolName}`,
      },
    });
    return;
  }

  // Fallback for unhandled methods
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  });
}
