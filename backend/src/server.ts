import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionRegistry } from "./registry.js";
import { AskAIEngine } from "./engine.js";
import { MockStore } from "./store.js";
import type { ChatRequest, JsonObject } from "./types.js";
import { providerFromEnvironment } from "./provider.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (typeof process.loadEnvFile === "function" && existsSync(".env")) {
  try { process.loadEnvFile(".env"); } catch {}
}
const port = Number(process.env.PORT ?? 8787);
const registry = new ActionRegistry();
const store = new MockStore([...new Set(registry.all().map((action) => action.moduleId))]);
const engine = new AskAIEngine(store, registry, "optimized", providerFromEnvironment());
const MAX_REQUEST_BYTES = 64 * 1024;

class RequestBodyError extends Error {
  readonly status = 413;
}

const send = (response: ServerResponse, status: number, body: unknown, contentType = "application/json"): void => {
  const text = contentType === "application/json" ? JSON.stringify(body) : String(body);
  response.writeHead(status, { "content-type": `${contentType}; charset=utf-8`, "access-control-allow-origin": "*", "cache-control": "no-store" });
  response.end(text);
};

async function body(request: IncomingMessage): Promise<JsonObject> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) throw new RequestBodyError("Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_REQUEST_BYTES) throw new RequestBodyError("Request body is too large.");
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
}

function contentType(path: string): string {
  return ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}

async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const dist = join(root, "frontend", "dist");
  const requested = request.url === "/" ? "index.html" : (request.url ?? "/").replace(/^\//, "");
  const candidate = normalize(join(dist, requested));
  const filePath = candidate.startsWith(dist) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(dist, "index.html");
  if (!existsSync(filePath)) return send(response, 404, { error: "Frontend is not built. Run npm run dev or npm run build." });
  response.writeHead(200, { "content-type": `${contentType(filePath)}; charset=utf-8` });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (method === "OPTIONS") return send(response, 204, "", "text/plain");
    if (url.pathname === "/api/health" && method === "GET") return send(response, 200, { ok: true, modules: 50, actions: 500 });
    if (url.pathname === "/api/catalog" && method === "GET") return send(response, 200, registry.all().map(({ handler: _handler, ...definition }) => definition));
    if (url.pathname === "/api/reset" && method === "POST") { engine.reset(); return send(response, 200, { ok: true, message: "Synthetic state reset to the reproducible baseline." }); }
    if (url.pathname === "/api/chat" && method === "POST") {
      const input = await body(request) as unknown as Partial<ChatRequest>;
      if (typeof input.sessionId !== "string" || typeof input.message !== "string") return send(response, 400, { error: "sessionId and message are required" });
      return send(response, 200, await engine.chat({ sessionId: input.sessionId, message: input.message, confirmationToken: input.confirmationToken, planHash: input.planHash, cancelConfirmation: input.cancelConfirmation, idempotencyKey: input.idempotencyKey }));
    }
    if (url.pathname === "/api/chat/stream" && method === "POST") {
      const input = await body(request) as unknown as Partial<ChatRequest>;
      if (typeof input.sessionId !== "string" || typeof input.message !== "string") return send(response, 400, { error: "sessionId and message are required" });
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
      const emit = (event: string, payload: unknown): void => { response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); };
      try {
        const result = await engine.chat({ sessionId: input.sessionId, message: input.message, confirmationToken: input.confirmationToken, planHash: input.planHash, cancelConfirmation: input.cancelConfirmation, idempotencyKey: input.idempotencyKey }, (step) => emit("progress", step));
        emit("complete", result);
      } catch (error) {
        emit("error", { error: error instanceof Error ? error.message : "Unexpected server error" });
      }
      response.end();
      return;
    }
    return serveStatic(request, response);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 500;
    return send(response, status, { error: error instanceof Error ? error.message : "Unexpected server error" });
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Ask AI API listening on http://localhost:${port}`));
