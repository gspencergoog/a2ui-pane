import { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/** Options for the standalone Vite development server plugin. */
export interface DevServerOptions {
  fixturePath?: string;
}

/**
 * Vite dev server plugin providing mock SSE streaming, /preload.js, and configuration
 * for standalone browser development and testing of the A2UI pane application.
 */
export function a2uiDevPlugin(options: DevServerOptions = {}): Plugin {
  return {
    name: 'a2ui-dev-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const host = req.headers.host || 'localhost';
        const url = new URL(req.url ?? '/', `http://${host}`);

        // Stub preload.js with a mock window.sidecar
        if (url.pathname === '/preload.js') {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(`
            window.sidecar = {
              agent: {
                sendMessage: async (msg) => {
                  console.log('[Dev Sidecar] agent.sendMessage:', msg);
                  return { ok: true };
                }
              }
            };
            console.log('[Dev Server] Injected mock window.sidecar');
          `);
          return;
        }

        // Mock config route
        if (url.pathname === '/api/config') {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              conversationId: 'dev-conversation',
              projectId: 'dev-project',
            }),
          );
          return;
        }

        // Mock send-message route
        if (url.pathname === '/_sidecar/send-message') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            console.log('[Dev Server] Received message:', body);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, echo: body }));
          });
          return;
        }

        // Mock stream route
        if (url.pathname === '/api/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          const fixture =
            options.fixturePath || path.resolve(process.cwd(), 'fixtures/sample.jsonl');
          let fileWatcher: fs.FSWatcher | null = null;
          let keepAliveTimer: NodeJS.Timeout | null = null;

          const sendLine = (lineStr: string) => {
            if (!lineStr.trim()) return;
            try {
              const parsed = JSON.parse(lineStr);
              res.write(`id: ${parsed.seq}\nevent: line\ndata: ${JSON.stringify(parsed)}\n\n`);
            } catch {
              // Ignore malformed lines
            }
          };

          const sendFixtureLines = () => {
            if (fs.existsSync(fixture)) {
              const content = fs.readFileSync(fixture, 'utf-8');
              const lines = content.split('\n');
              for (const line of lines) {
                sendLine(line);
              }
            } else {
              // Default dev sample if no fixture file exists
              const defaultLines = [
                {
                  seq: 1,
                  ts: new Date().toISOString(),
                  callId: 'dev_init',
                  message: {
                    version: 'v0.9',
                    createSurface: {
                      surfaceId: 'devSurface',
                      catalogId: 'basic',
                    },
                  },
                },
                {
                  seq: 2,
                  ts: new Date().toISOString(),
                  callId: 'dev_init',
                  message: {
                    version: 'v0.9',
                    updateComponents: {
                      surfaceId: 'devSurface',
                      components: [
                        {
                          id: 'root',
                          component: 'Card',
                          title: 'A2UI Pane Dev',
                          child: 'bodyText',
                        },
                        {
                          id: 'bodyText',
                          component: 'Text',
                          text: 'Live development server running with mock stream!',
                        },
                      ],
                    },
                  },
                },
              ];
              for (const l of defaultLines) {
                res.write(`id: ${l.seq}\nevent: line\ndata: ${JSON.stringify(l)}\n\n`);
              }
            }
          };

          sendFixtureLines();

          if (fs.existsSync(fixture)) {
            try {
              fileWatcher = fs.watch(fixture, () => {
                sendFixtureLines();
              });
            } catch {
              // File watch optional
            }
          }

          keepAliveTimer = setInterval(() => {
            res.write(': keepalive\n\n');
          }, 15000);

          req.on('close', () => {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            if (fileWatcher) fileWatcher.close();
          });

          return;
        }

        next();
      });
    },
  };
}
