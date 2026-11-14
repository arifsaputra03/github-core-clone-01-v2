// src/mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp, modern
// revision 2026-07-28 (`server/discover`, no handshake, no session) with the legacy
// `initialize` handshake as a fallback. JSON-RPC 2.0, one JSON body per request.
// The six tools act on the same store as REST, so a repository or issue made over
// MCP is the same object over REST.

import { VIEWER, isoAt, type Forge, type Repo } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

/** The tools, defined once so two `tools/list` answers are byte-identical. */
const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoAt(1),
    updated_at: isoAt(1),
  };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: unknown; isError?: boolean };

function toolOk(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(args: Record<string, unknown>, tool: McpToolDef): string | null {
  for (const name of tool.inputSchema.required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return toolError(`Unknown tool: ${name}`);
  const missing = missingArg(args, tool);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);

  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';

  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name : '';
    if (repoNameArg === '') return toolError('Missing required argument: name');
    if (owner !== VIEWER.login) return toolError(`Cannot create a repository for ${owner}`);
    const repo = forge.createRepo(owner, repoNameArg, typeof args.description === 'string' ? args.description : '', args.private === true);
    if (repo === null) return toolError(`Repository ${owner}/${repoNameArg} already exists`);
    return toolOk(repoJson(repo));
  }

  if (owner !== VIEWER.login) return toolError(`Repository ${owner}/${repoName} not found`);
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);

  if (name === 'get_repo') {
    return toolOk(repoJson(repo));
  }

  if (name === 'create_issue') {
    const title = args.title as string;
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue = {
      id: repo.id * 100000 + number,
      number,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [] as string[],
      comments: [] as unknown[],
      seq: forge.nextSeq(),
      version: 1,
    };
    repo.issues.push(issue);
    return toolOk({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: [], created_at: isoAt(issue.seq) });
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    const items = list.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
    return toolOk(items);
  }

  if (name === 'create_pull_request') {
    const head = args.head as string;
    const base = args.base as string;
    const headSha = repo.refCommit(`refs/heads/${head}`);
    const baseSha = repo.refCommit(`refs/heads/${base}`);
    if (headSha === null || baseSha === null) return toolError('head or base branch does not exist');
    const existing = repo.pulls.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
    if (existing !== undefined) return toolError('A pull request already exists for this head and base');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pr = {
      id: repo.id * 100000 + number,
      number,
      title: args.title as string,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      baseShaAtCreation: baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: forge.nextSeq(),
    };
    repo.pulls.push(pr);
    return toolOk({ id: pr.id, number: pr.number, title: pr.title, body: pr.body, state: pr.state, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } });
  }

  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
    const pr = repo.pulls.find((candidate) => candidate.number === number);
    if (pr === undefined) return toolError(`Pull request #${number} not found`);
    if (pr.merged || pr.state !== 'open') return toolError(`Pull request #${number} is not open`);
    if (forge.mergeable(repo, pr) === 'CONFLICTING') return toolError(`Pull request #${number} conflicts`);
    const merged = forge.mergePull(repo, pr);
    if (merged === null) return toolError(`Pull request #${number} conflicts`);
    return toolOk({ merged: true, number: pr.number, sha: merged.sha, message: merged.message, state: 'closed' });
  }

  return toolError(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------- JSON-RPC

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Handle one POST /mcp body (already parsed JSON). Notifications (no id) answer 202 with no body. */
export function handleMcp(forge: Forge, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => handleOne(forge, entry));
    return { status: 200, body: results.filter((entry) => entry !== null) };
  }
  const result = handleOne(forge, body);
  if (result === null) return { status: 202, body: null };
  return { status: 200, body: result };
}

function handleOne(forge: Forge, request: unknown): Record<string, unknown> | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = request as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof record.id === 'string' || typeof record.id === 'number' ? record.id : null;
  const isNotification = record.id === undefined;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== undefined && typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
    if (name === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
    return rpcResult(id, callTool(forge, name, args));
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  void isNotification;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** The answer for a body that is not JSON: HTTP 400 with JSON-RPC -32700. */
export function mcpParseError(): { status: number; body: unknown } {
  return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
}
