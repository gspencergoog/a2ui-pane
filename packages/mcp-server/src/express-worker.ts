import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface WorkerError {
  kind: string;
  message: string;
  line?: number;
  column?: number;
}

export type WorkerRequest = {
  id: number;
  op: 'init' | 'ping' | 'compile' | 'instructions' | 'decompile';
  catalogPath?: string;
  version?: string;
  dsl?: string;
  surfaceId?: string;
  messages?: unknown[];
};

export type WorkerResponse =
  | { id: number | null; ok: true; messages?: unknown[]; text?: string; [key: string]: unknown }
  | { id: number | null; ok: false; error: WorkerError };

export interface ExpressWorkerOptions {
  /** Interpreter that already has the A2UI agent SDK importable (`A2UI_PANE_PYTHON`). */
  pythonBin?: string;
  /** `uv` executable used when `pythonBin` is not set. */
  uvBin?: string;
  /** Local a2ui checkout (uv workspace root) used with `uv run --project`. */
  agentSdkPath?: string;
  /** PEP 508 spec used with `uv run --with` when neither `pythonBin` nor `agentSdkPath` is set. */
  agentSdkSpec?: string;
  /** Absolute path to `express_worker.py`. */
  workerScript: string;
  /** Absolute path to the basic catalog JSON. */
  catalogPath: string;
  /** Protocol version passed to the compiler (`v0.9`, `v0.9.1`, `v1.0`). */
  defaultVersion?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Test seam: replaces `child_process.spawn`. */
  spawnFn?: typeof spawn;
  /** Test seam: stderr sink. */
  log?: (line: string) => void;
}

export const DEFAULT_AGENT_SDK_SPEC = 'a2ui-agent-sdk>0.8.0';
const UNAVAILABLE_MEMO_MS = 60_000;

/**
 * Error raised when the worker reports a compile or validation failure.
 * Carries the structured payload so tool handlers can format line and column.
 */
export class ExpressWorkerError extends Error {
  constructor(readonly detail: WorkerError) {
    super(detail.message);
    this.name = 'ExpressWorkerError';
  }
}

/** Error raised when the worker process cannot be started or dies twice in a row. */
export class ExpressWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressWorkerUnavailableError';
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

/**
 * Builds the executable and argv for the worker process.
 * Preference order: a resolved interpreter, a local a2ui checkout via `uv run --project`,
 * then a published SDK via `uv run --with`.
 */
export function buildSpawnArgs(opts: ExpressWorkerOptions): { command: string; args: string[] } {
  const pythonBin = nonEmpty(opts.pythonBin);
  if (pythonBin) {
    return { command: pythonBin, args: [opts.workerScript] };
  }
  const uvBin = nonEmpty(opts.uvBin) ?? 'uv';
  const agentSdkPath = nonEmpty(opts.agentSdkPath);
  if (agentSdkPath) {
    return {
      command: uvBin,
      args: [
        'run',
        '--project',
        agentSdkPath,
        '--package',
        'a2ui-agent-sdk',
        '--no-sync',
        'python',
        opts.workerScript,
      ],
    };
  }
  return {
    command: uvBin,
    args: [
      'run',
      '--with',
      opts.agentSdkSpec ?? DEFAULT_AGENT_SDK_SPEC,
      'python',
      opts.workerScript,
    ],
  };
}

interface Pending {
  request: WorkerRequest;
  resolve: (value: WorkerResponse) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  retried: boolean;
  timeoutMs?: number;
}

/**
 * Owns one long-lived Python process that compiles A2UI Express into protocol messages.
 * Requests are serialized FIFO; a crashed process is restarted once and the in-flight
 * request retried once before the caller sees an error.
 */
export class ExpressWorker {
  private child?: ChildProcessWithoutNullStreams;
  private reader?: Interface;
  private readyPromise?: Promise<void>;
  private readonly queue: Pending[] = [];
  private inflight?: Pending;
  private nextId = 1;
  private unavailableUntil = 0;
  private unavailableReason = '';
  private disposed = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ExpressWorkerOptions) {
    this.log = opts.log ?? ((line) => console.error(`[express-worker] ${line}`));
  }

  /** Reason the worker is unavailable, or an empty string. */
  get unavailableMessage(): string {
    return this.unavailableReason;
  }

  /** Starts the worker if needed and reports whether it can serve requests. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureReady();
      return true;
    } catch {
      return false;
    }
  }

  async compile(dsl: string, surfaceId: string, version?: string): Promise<unknown[]> {
    const res = await this.send({
      id: 0,
      op: 'compile',
      dsl,
      surfaceId,
      version: version ?? this.opts.defaultVersion,
    });
    return (res.messages as unknown[]) ?? [];
  }

  async instructions(): Promise<string> {
    const res = await this.send({ id: 0, op: 'instructions' });
    return String(res.text ?? '');
  }

  async decompile(messages: unknown[]): Promise<string> {
    const res = await this.send({ id: 0, op: 'decompile', messages });
    return String(res.text ?? '');
  }

  /** Stops the child process and fails any queued requests. */
  dispose(): void {
    this.disposed = true;
    this.teardown(new ExpressWorkerUnavailableError('Express worker disposed'));
  }

  private async send(request: WorkerRequest): Promise<Extract<WorkerResponse, { ok: true }>> {
    await this.ensureReady();
    const response = await this.enqueue(request);
    if (!response.ok) {
      throw new ExpressWorkerError(response.error);
    }
    return response;
  }

  private enqueue(
    request: WorkerRequest,
    retried = false,
    timeoutMs?: number,
  ): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.queue.push({
        request: { ...request, id: this.nextId++ },
        resolve,
        reject,
        retried,
        timeoutMs,
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inflight || this.queue.length === 0 || !this.child) return;
    const pending = this.queue.shift()!;
    this.inflight = pending;
    const timeoutMs = pending.timeoutMs ?? this.opts.requestTimeoutMs ?? 10_000;
    pending.timer = setTimeout(() => {
      if (pending.request.op === 'init') {
        this.teardown(new Error(`Express worker did not initialize within ${timeoutMs} ms`));
        return;
      }
      this.log(`request ${pending.request.op} timed out after ${timeoutMs} ms; restarting worker`);
      this.handleCrash(new Error(`Express worker request '${pending.request.op}' timed out`));
    }, timeoutMs);
    pending.timer.unref?.();
    this.child.stdin.write(JSON.stringify(pending.request) + '\n');
  }

  private handleResponseLine(line: string): void {
    let parsed: WorkerResponse;
    try {
      parsed = JSON.parse(line) as WorkerResponse;
    } catch {
      this.log(`ignoring non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }
    const pending = this.inflight;
    if (!pending || (parsed.id !== null && parsed.id !== pending.request.id)) {
      this.log(`ignoring response for unknown request id ${String(parsed.id)}`);
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.inflight = undefined;
    pending.resolve(parsed);
    this.pump();
  }

  private ensureReady(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new ExpressWorkerUnavailableError('Express worker disposed'));
    }
    if (this.readyPromise) return this.readyPromise;
    if (Date.now() < this.unavailableUntil) {
      return Promise.reject(new ExpressWorkerUnavailableError(this.unavailableReason));
    }
    this.readyPromise = this.start().catch((err: Error) => {
      this.readyPromise = undefined;
      this.markUnavailable(err.message);
      throw new ExpressWorkerUnavailableError(err.message);
    });
    return this.readyPromise;
  }

  private markUnavailable(reason: string): void {
    this.unavailableUntil = Date.now() + UNAVAILABLE_MEMO_MS;
    this.unavailableReason = reason;
    this.log(`unavailable: ${reason}`);
  }

  private async start(): Promise<void> {
    const { command, args } = buildSpawnArgs(this.opts);
    const spawnFn = this.opts.spawnFn ?? spawn;
    this.log(`starting: ${command} ${args.join(' ')}`);

    const child = await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        reject(new Error(`failed to spawn ${command}: ${err?.message || err}`));
        return;
      }
      proc.once('error', (err) => reject(new Error(`failed to spawn ${command}: ${err.message}`)));
      proc.once('spawn', () => resolve(proc));
    });

    if (this.disposed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      throw new ExpressWorkerUnavailableError('Express worker disposed');
    }

    this.child = child;
    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.handleResponseLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) this.log(line);
      }
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.handleCrash(new Error(`Express worker exited (code ${code}, signal ${signal})`));
      }
    });

    const startupTimeoutMs = this.opts.startupTimeoutMs ?? 30_000;
    const initRequest: WorkerRequest = {
      id: 0,
      op: 'init',
      catalogPath: this.opts.catalogPath,
      version: this.opts.defaultVersion ?? 'v0.9',
    };
    try {
      const response = await this.enqueue(initRequest, true, startupTimeoutMs);
      if (!response.ok) {
        throw new Error(`Express worker init failed: ${response.error.message}`);
      }
      this.log(
        `ready (${String(response.version)}, ${String(response.componentCount)} components)`,
      );
    } catch (err: any) {
      this.teardown(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private handleCrash(reason: Error): void {
    const inflight = this.inflight;
    const queued = this.queue.splice(0);
    this.inflight = undefined;
    this.killChild();
    this.readyPromise = undefined;

    if (this.disposed) {
      inflight?.reject(reason);
      for (const p of queued) p.reject(reason);
      return;
    }

    const toRetry: Pending[] = [];
    if (inflight) {
      if (inflight.timer) clearTimeout(inflight.timer);
      if (inflight.request.op === 'init') {
        inflight.reject(reason);
      } else if (inflight.retried) {
        inflight.reject(new ExpressWorkerUnavailableError(`${reason.message} (after one retry)`));
      } else {
        toRetry.push({ ...inflight, retried: true });
      }
    }
    toRetry.push(...queued);
    if (toRetry.length === 0) return;

    this.log(`${reason.message}; restarting and retrying ${toRetry.length} request(s)`);
    this.ensureReady()
      .then(() => {
        for (const p of toRetry) {
          this.queue.push({ ...p, request: { ...p.request, id: this.nextId++ } });
        }
        this.pump();
      })
      .catch((err: Error) => {
        for (const p of toRetry) p.reject(err);
      });
  }

  private killChild(): void {
    const child = this.child;
    this.child = undefined;
    this.reader?.close();
    this.reader = undefined;
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  private teardown(reason: Error): void {
    const inflight = this.inflight;
    const queued = this.queue.splice(0);
    this.inflight = undefined;
    if (inflight?.timer) clearTimeout(inflight.timer);
    this.killChild();
    this.readyPromise = undefined;
    inflight?.reject(reason);
    for (const p of queued) p.reject(reason);
  }
}
