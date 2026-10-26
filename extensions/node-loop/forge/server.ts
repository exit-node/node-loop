/**
 * Forge: a loopback-only HTTP server that shows the newest node-loop run as a live page.
 *
 * Routes: `GET /` serves page.html, `GET /state` the State JSON, `GET /events` an SSE stream
 * that pushes the full State on connect and on every change (contract: docs/CONTRACT.md "Forge view").
 *
 * Decisions:
 * - node:http only, so the module runs inside omp's Bun runtime, plain Bun, and Node with type stripping.
 * - The active run is the newest-modified `ledger.md` under `$NODE_LOOP_HOME/<repo>/<run-id>/`,
 *   rescanned every 2 s. The active ledger is watched with fs.watch plus a 1 s mtime/size poll,
 *   because fs.watch drops events on some filesystems and after atomic replaces.
 * - State is re-parsed from the whole ledger on each change and only broadcast when its JSON differs.
 * - startForge() is idempotent through a module-level promise; stopForge() exists for tests.
 */

import { readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLedger, type State } from "./ledger.ts";

const HOST = "127.0.0.1";
const BASE_PORT = 4747;
// Ports tried: 4747 through 4767.
const PORT_SPAN = 20;
const SCAN_MS = 2000;
const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;
// Coalesces bursts of fs.watch events from one append.
const DEBOUNCE_MS = 50;

// Bun exposes import.meta.dir; Node only has import.meta.url.
const MODULE_DIR =
  "dir" in import.meta && typeof import.meta.dir === "string"
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));

interface Active {
  ledger: string;
  runDir: string;
  mtimeMs: number;
  size: number;
}

interface Forge {
  /** Null until a port is bound. */
  server: Server | null;
  clients: Set<ServerResponse>;
  timers: NodeJS.Timeout[];
  watcher: FSWatcher | null;
  debounce: NodeJS.Timeout | undefined;
  active: Active | null;
  /** Last broadcast State, serialized; doubles as the change detector. */
  json: string;
}

let starting: Promise<{ url: string }> | null = null;
let forge: Forge | null = null;

/** Lists subdirectory names, or nothing when the directory is missing or unreadable. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Finds the newest-modified `<home>/<repo>/<run-id>/ledger.md`, or null when no run exists. */
function findNewestLedger(): Active | null {
  const home = process.env.NODE_LOOP_HOME || join(homedir(), ".omp", "node-loop");
  let best: Active | null = null;
  for (const repo of subdirs(home)) {
    for (const run of subdirs(join(home, repo))) {
      const runDir = join(home, repo, run);
      const ledger = join(runDir, "ledger.md");
      try {
        const stat = statSync(ledger);
        if (!stat.isFile()) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) best = { ledger, runDir, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        // No ledger in this directory.
      }
    }
  }
  return best;
}

/** First non-empty line of goal.md; empty when the file is missing. */
function readGoal(runDir: string): string {
  try {
    const text = readFileSync(join(runDir, "goal.md"), "utf8");
    return text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
  } catch {
    return "";
  }
}

/** State for the active run; null when its ledger vanished mid-read, so the last state stays up until the next scan. */
function readState(active: Active | null): State | null {
  if (!active) return parseLedger("", { id: "", repo: "", goal: "" });
  let text: string;
  try {
    text = readFileSync(active.ledger, "utf8");
  } catch {
    return null;
  }
  return parseLedger(text, {
    id: basename(active.runDir),
    repo: basename(dirname(active.runDir)),
    goal: readGoal(active.runDir),
  });
}

/** Re-parses the active ledger and pushes the state to every SSE client when it changed. */
function refresh(f: Forge): void {
  const state = readState(f.active);
  if (!state) return;
  const json = JSON.stringify(state);
  if (json === f.json) return;
  f.json = json;
  for (const client of f.clients) client.write(`data: ${json}\n\n`);
}

function scheduleRefresh(f: Forge): void {
  clearTimeout(f.debounce);
  f.debounce = setTimeout(() => {
    f.debounce = undefined;
    refresh(f);
  }, DEBOUNCE_MS);
}

function unwatch(f: Forge): void {
  f.watcher?.close();
  f.watcher = null;
}

/** Makes `next` the active run, watching its ledger; the poll covers a failed or silent watch. */
function activate(f: Forge, next: Active | null): void {
  unwatch(f);
  f.active = next;
  if (next) {
    try {
      const watcher = watch(next.ledger, () => scheduleRefresh(f));
      watcher.on("error", () => unwatch(f));
      f.watcher = watcher;
    } catch {
      f.watcher = null;
    }
  }
  refresh(f);
}

/** Switches to the newest run when it is a different ledger, or to empty when all runs vanished. */
function scan(f: Forge): void {
  const newest = findNewestLedger();
  if (newest?.ledger !== f.active?.ledger) activate(f, newest);
}

/** Detects ledger appends by mtime and size, for filesystems where fs.watch stays silent. */
function poll(f: Forge): void {
  const active = f.active;
  if (!active) return;
  try {
    const stat = statSync(active.ledger);
    if (stat.mtimeMs === active.mtimeMs && stat.size === active.size) return;
    active.mtimeMs = stat.mtimeMs;
    active.size = stat.size;
    refresh(f);
  } catch {
    // The ledger vanished; the next scan picks another run or the empty state.
  }
}

/** Accepts only loopback Host headers so a DNS-rebound page cannot read run state. */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

function handle(f: Forge, port: number, req: IncomingMessage, res: ServerResponse): void {
  if (!hostAllowed(req, port)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("forbidden host\n");
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET", "content-type": "text/plain" }).end("method not allowed\n");
    return;
  }
  const path = (req.url ?? "/").split("?")[0];

  if (path === "/") {
    let html: string;
    try {
      // Read per request so edits to page.html show on reload.
      html = readFileSync(join(MODULE_DIR, "page.html"), "utf8");
    } catch {
      res.writeHead(500, { "content-type": "text/plain" }).end("page.html missing\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    return;
  }

  if (path === "/state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(f.json);
    return;
  }

  if (path === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    // Browser reconnect delay after a dropped stream.
    res.write("retry: 2000\n\n");
    res.write(`data: ${f.json}\n\n`);
    f.clients.add(res);
    req.on("close", () => f.clients.delete(res));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
}

/** Listens on the first free port in range; rejects on any error other than a taken port. */
async function listenFree(f: Forge): Promise<{ server: Server; port: number }> {
  for (let port = BASE_PORT; port <= BASE_PORT + PORT_SPAN; port++) {
    const server = createServer((req, res) => handle(f, port, req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return { server, port };
    } catch (err) {
      server.close();
      if (!(err instanceof Error && "code" in err && err.code === "EADDRINUSE")) throw err;
    }
  }
  throw new Error(`forge: no free port in ${BASE_PORT}-${BASE_PORT + PORT_SPAN} on ${HOST}`);
}

async function boot(): Promise<{ url: string }> {
  const f: Forge = {
    server: null,
    clients: new Set(),
    timers: [],
    watcher: null,
    debounce: undefined,
    active: null,
    json: "",
  };
  // Always activates, so json holds the first state (empty when no run exists) before any client connects.
  activate(f, findNewestLedger());
  const { server, port } = await listenFree(f);
  f.server = server;
  f.timers.push(
    setInterval(() => scan(f), SCAN_MS),
    setInterval(() => poll(f), POLL_MS),
    setInterval(() => {
      for (const client of f.clients) client.write(": heartbeat\n\n");
    }, HEARTBEAT_MS),
  );
  // Timers must not keep a host process alive on their own; the listening socket does that.
  for (const timer of f.timers) timer.unref();
  forge = f;
  return { url: `http://${HOST}:${port}/` };
}

/** Starts the forge once; later calls return the running URL. */
export function startForge(): Promise<{ url: string }> {
  if (!starting) {
    starting = boot().catch((err) => {
      starting = null;
      throw err;
    });
  }
  return starting;
}

/** Stops the server, timers, watcher and SSE streams so a later startForge() boots fresh. */
export async function stopForge(): Promise<void> {
  const pending = starting;
  starting = null;
  if (pending) await pending.catch(() => undefined);
  const f = forge;
  forge = null;
  if (!f) return;
  for (const timer of f.timers) clearInterval(timer);
  clearTimeout(f.debounce);
  unwatch(f);
  for (const client of f.clients) client.end();
  f.clients.clear();
  const server = f.server;
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Drop idle keep-alive sockets so close() resolves promptly.
    server.closeAllConnections();
  });
}

// Standalone: `bun extensions/node-loop/forge/server.ts` prints the URL and keeps serving.
if ("main" in import.meta && import.meta.main === true) {
  startForge().then(({ url }) => console.log(`forge: ${url}`));
}
