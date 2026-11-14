// app.ts — the HTTP server: routing, auth, JSON bodies and the request-id header.
// Everything else lives in src/: the store, git smart HTTP, REST v3, GraphQL and MCP.
//
//   GET  /healthz                                   the env's boot probe
//   GET  /api/v3/  /api/v3/meta                     public API root and meta
//   *    /api/v3/...                                REST v3 (bearer token required)
//   POST /api/graphql                              GraphQL v4 (bearer token required)
//   POST /mcp                                      MCP (bearer token required)
//   *    /{owner}/{repo}.git/...                    git smart HTTP (bearer token required)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, SERVER_AGENT } from './src/git.ts';
import { handleRest, type RestRequest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp, mcpParseError } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${process.pid}-${requestCounter}`;
}

/** The bearer token the entry accepts: MAKEFUN_SHOP_TOKEN when set, else any non-empty token. */
function tokenAccepted(authorization: string | string[] | undefined): boolean {
  if (typeof authorization !== 'string') return false;
  const trimmed = authorization.trim();
  // Fast path: the common `Bearer <token>` shape without a regex.
  if (!trimmed.startsWith('Bearer ')) return false;
  const token = trimmed.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  if (expected === '') return true;
  return token === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': nextRequestId(), ...extraHeaders };
  if (body !== null) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  } else {
    headers['content-length'] = '0';
  }
  res.writeHead(status, headers);
  res.end(text);
}

/** Send a prebuilt JSON body (e.g. a cached serialization) without re-stringifying. */
function sendText(res: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'x-github-request-id': nextRequestId(),
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function decodeSegments(pathname: string): string[] | null {
  try {
    // Segments without '%' decode to themselves; skip the decoder for them.
    return pathname.split('/').filter((segment) => segment !== '').map((segment) => (segment.includes('%') ? decodeURIComponent(segment) : segment));
  } catch {
    return null;
  }
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handleRequest(forge, req, res);
      } catch (err) {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pathname = url.pathname;
  const query = url.searchParams;
  const host = req.headers.host ?? '127.0.0.1';
  const baseUrl = `http://${host}`;

  // The env's boot probe: 200 {"ok":true}, no auth.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const isPublicApi = (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) || (method === 'GET' && pathname === '/api/v3/meta');
  if (!isPublicApi && !tokenAccepted(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const rawBody = hasBody ? await readBody(req) : Buffer.alloc(0);

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restPath = pathname.slice('/api/v3'.length);
    const segments = decodeSegments(restPath);
    if (segments === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let body: unknown;
    let bodyMalformed = false;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        bodyMalformed = true;
      }
    }
    const restReq: RestRequest = { method, segments, query, body, bodyMalformed, baseUrl };
    const result = handleRest(forge, restReq);
    if (result === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (result.status === 204) {
      sendJson(res, 204, null);
      return;
    }
    if (result.text !== undefined) {
      sendText(res, result.status, result.text, result.headers ?? {});
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
      return;
    }
    const result = handleGraphQL(forge, body);
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      const parsed = mcpParseError();
      sendJson(res, parsed.status, parsed.body);
      return;
    }
    const result = handleMcp(forge, body);
    if (result.status === 202) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId(), 'content-length': '0' });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const suffix = gitMatch[3]!;
    if (method === 'GET' && suffix === '/info/refs') {
      const service = query.get('service') ?? '';
      const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
      const result = handleInfoRefs(forge, owner, repoName, service, gitProtocol);
      if (result === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (result.status !== 200) {
        sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown);
        return;
      }
      sendBytes(res, 200, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const result = handleUploadPack(repo, rawBody);
      if (result.status !== 200) {
        sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown);
        return;
      }
      sendBytes(res, 200, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const result = await handleReceivePack(repo, rawBody);
      if (result.status !== 200) {
        sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown);
        return;
      }
      sendBytes(res, 200, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export { SERVER_AGENT };
