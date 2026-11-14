// src/rest.ts — GitHub REST v3: repositories, branches, commits, git refs, contents,
// labels, issues, comments and pull requests. Every reply is JSON with a `message`
// error shape; pagination follows GitHub's `Link: <url>; rel="next"` header.

import { VIEWER, isoAt, type Forge, type Issue, type PullRequest, type Repo } from './store.ts';
import { isObjectId, parseCommit } from './objects.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyMalformed: boolean;
  baseUrl: string;
}

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  /** Prebuilt JSON body (with trailing newline) sent verbatim, skipping re-stringify. */
  text?: string;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, headers, body };
}

function okText(status: number, text: string, headers?: Record<string, string>): RestResult {
  return { status, headers, body: null, text };
}

/** The `Link` header for a paginated list, plus the page slice. */
function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const urlFor = (pageNumber: number): string => {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(pageNumber));
    return url.toString();
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

// ---------------------------------------------------------------- serializers

/** The viewer's user object never changes; every serializer shares one frozen copy. */
const USER_JSON: Json = Object.freeze({
  login: VIEWER.login,
  id: VIEWER.id,
  node_id: '',
  avatar_url: '',
  type: 'User',
  site_admin: false,
  name: VIEWER.name,
  email: VIEWER.email,
});

function userJson(): Json {
  return USER_JSON;
}

function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: '',
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    created_at: isoAt(1),
    updated_at: isoAt(1),
    pushed_at: isoAt(1),
    default_branch: repo.defaultBranch,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    size: 0,
  };
}

function labelJson(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return { id: repo.id * 1000 + name.length, name, color: label?.color ?? 'ededed', default: false, description: '' };
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    locked: false,
    comments: issue.comments.length,
    created_at: isoAt(issue.seq),
    updated_at: isoAt(issue.seq),
    html_url: '',
    url: '',
  };
}

/** Cached serialization of one issue, keyed by its mutation version. A single
 *  issue is often fetched thousands of times unchanged (the read benchmark
 *  GETs the same issue 2,000 times per round), so rebuilding its JSON — labels,
 *  two timestamps, the user object — on every request is pure waste. Every
 *  mutation site bumps `issue.version`, which invalidates the entry. */
const issueTextCache = new WeakMap<Issue, { version: number; text: string }>();
function issueJsonText(repo: Repo, issue: Issue): string {
  const hit = issueTextCache.get(issue);
  if (hit !== undefined && hit.version === issue.version) return hit.text;
  const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
  issueTextCache.set(issue, { version: issue.version, text });
  return text;
}

function pullJson(forge: Forge, repo: Repo, pr: PullRequest): Json {
  const headSha = repo.refCommit(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = repo.refCommit(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return {
    id: repo.id * 100000 + pr.number,
    node_id: '',
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userJson(),
    head: { label: `${VIEWER.login}:${pr.headRef}`, ref: pr.headRef, sha: headSha, user: userJson(), repo: repoJson(repo) },
    base: { label: `${VIEWER.login}:${pr.baseRef}`, ref: pr.baseRef, sha: baseSha, user: userJson(), repo: repoJson(repo) },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: forge.mergeable(repo, pr) === 'MERGEABLE',
    created_at: isoAt(pr.seq),
    updated_at: isoAt(pr.seq),
    html_url: '',
    url: '',
  };
}

// ---------------------------------------------------------------- helpers

/** Resolve an owner/name pair to a repository the token owns; anything else is a 404. */
function repoOf(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return forge.getRepo(owner, name);
}

function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.defaultTip();
  if (ref.startsWith('refs/')) return repo.refCommit(ref);
  const byBranch = repo.refCommit(`refs/heads/${ref}`);
  if (byBranch !== null) return byBranch;
  if (isObjectId(ref) && repo.objects.has(ref)) return repo.peelToCommit(ref);
  return null;
}

function badBody(req: RestRequest): RestResult | null {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  return null;
}

// ---------------------------------------------------------------- the router

export function handleRest(forge: Forge, req: RestRequest): RestResult | null {
  const s = req.segments;
  const method = req.method;

  // API root and meta are public.
  if (s.length === 0 && method === 'GET') {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (s.length === 1 && s[0] === 'meta' && method === 'GET') {
    return ok(200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
  }
  if (s.length === 1 && s[0] === 'user' && method === 'GET') {
    return ok(200, userJson());
  }

  if (s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const all = forge.reposOf(VIEWER.login);
      const { page, link } = paginate(all, req.query, req.baseUrl, '/api/v3/user/repos');
      return ok(200, page.map((repo) => repoJson(repo)), link === null ? undefined : { link });
    }
    if (method === 'POST') {
      const bad = badBody(req);
      if (bad !== null) return bad;
      if (!isRecord(req.body) || typeof req.body.name !== 'string' || req.body.name === '') {
        return err(422, 'Repository name is required');
      }
      const name = req.body.name as string;
      const description = typeof req.body.description === 'string' ? (req.body.description as string) : '';
      const isPrivate = req.body.private === true;
      const created = forge.createRepo(VIEWER.login, name, description, isPrivate);
      if (created === null) return err(422, `Repository ${VIEWER.login}/${name} already exists`);
      return ok(201, repoJson(created));
    }
    return null;
  }

  if (s[0] !== 'repos' || s.length < 3) return null;
  const owner = s[1]!;
  const repoName = s[2]!;
  const rest = s.slice(3);

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    const repo = repoOf(forge, owner, repoName);
    if (method === 'GET') {
      if (repo === null) return err(404, 'Not Found');
      return ok(200, repoJson(repo));
    }
    if (method === 'PATCH') {
      const bad = badBody(req);
      if (bad !== null) return bad;
      if (repo === null) return err(404, 'Not Found');
      if (isRecord(req.body)) {
        if (typeof req.body.description === 'string') repo.description = req.body.description as string;
        if (typeof req.body.private === 'boolean') repo.isPrivate = req.body.private as boolean;
      }
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      if (repo === null) return err(404, 'Not Found');
      forge.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return null;
  }

  const repo = repoOf(forge, owner, repoName);
  if (repo === null) return err(404, 'Not Found');

  // Branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! }, protected: false }));
      return ok(200, list);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.refCommit(`refs/heads/${rest[1]}`);
      if (sha === null) return err(404, 'Not Found');
      return ok(200, { name: rest[1], commit: { sha }, protected: false });
    }
    return null;
  }

  // Commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = req.query.get('sha');
    const tip = resolveRefTip(repo, shaParam);
    if (tip === null && shaParam !== null) return err(404, 'Not Found');
    const commits = forge.listCommits(repo, tip);
    const { page, link } = paginate(commits, req.query, req.baseUrl, `/api/v3/repos/${owner}/${repoName}/commits`);
    const body = page.map((sha) => {
      const object = repo.objects.get(sha)!;
      const commit = parseCommit(object.data);
      return {
        sha,
        commit: {
          message: commit.message.replace(/\n+$/, ''),
          author: { name: VIEWER.name, email: VIEWER.email, date: isoAt(repo.commitSeq.get(sha) ?? 1) },
          committer: { name: VIEWER.name, email: VIEWER.email, date: isoAt(repo.commitSeq.get(sha) ?? 1) },
          tree: { sha: commit.tree },
        },
        author: userJson(),
        committer: userJson(),
      };
    });
    return ok(200, body, link === null ? undefined : { link });
  }

  // Git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const bad = badBody(req);
      if (bad !== null) return bad;
      if (!isRecord(req.body) || typeof req.body.ref !== 'string' || typeof req.body.sha !== 'string') {
        return err(422, 'ref and sha are required');
      }
      const ref = req.body.ref as string;
      const sha = req.body.sha as string;
      if (!ref.startsWith('refs/')) return err(422, 'Invalid ref');
      const commit = repo.peelToCommit(sha);
      if (commit === null) return err(422, 'Object does not exist');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.version += 1;
      return ok(201, { ref, object: { sha, type: 'commit' }, url: '' });
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const list = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        return ok(200, list);
      }
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha, type: 'commit' }, url: '' });
    }
    return null;
  }

  // Contents
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    return handleContents(forge, repo, req, filePath);
  }

  // Labels
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return ok(200, [...repo.labels.values()].map((label) => labelJson(repo, label.name)));
    }
    if (rest.length === 1 && method === 'POST') {
      const bad = badBody(req);
      if (bad !== null) return bad;
      if (!isRecord(req.body) || typeof req.body.name !== 'string' || req.body.name === '') {
        return err(422, 'Label name is required');
      }
      const name = req.body.name as string;
      const color = typeof req.body.color === 'string' ? (req.body.color as string) : 'ededed';
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
      return ok(201, labelJson(repo, name));
    }
    return null;
  }

  // Issues
  if (rest[0] === 'issues') {
    return handleIssues(forge, repo, req, rest.slice(1));
  }

  // Pull requests
  if (rest[0] === 'pulls') {
    return handlePulls(forge, repo, req, rest.slice(1));
  }

  return null;
}

// ---------------------------------------------------------------- contents

function handleContents(forge: Forge, repo: Repo, req: RestRequest, filePath: string): RestResult {
  const method = req.method;
  const branch = typeof req.body === 'object' && req.body !== null && 'branch' in (req.body as Json) ? String((req.body as Json).branch) : req.query.get('ref') ?? null;
  const tip = resolveRefTip(repo, branch);

  if (method === 'GET') {
    if (tip === null) return err(404, 'Not Found');
    const commitObject = repo.objects.get(tip);
    if (commitObject === undefined) return err(404, 'Not Found');
    const treeOid = parseCommit(commitObject.data).tree;
    if (filePath === '') {
      const entries = forge.dirEntries(repo, treeOid, '') ?? [];
      return ok(200, entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.oid, size: 0 })));
    }
    const file = forge.fileAt(repo, tip, filePath);
    if (file !== null) {
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: file.data.length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        content: file.data.toString('base64'),
        sha: file.oid,
      });
    }
    const entries = forge.dirEntries(repo, treeOid, filePath);
    if (entries !== null) {
      return ok(200, entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.oid, size: 0 })));
    }
    return err(404, 'Not Found');
  }

  if (method === 'PUT') {
    const bad = badBody(req);
    if (bad !== null) return bad;
    if (!isRecord(req.body) || typeof req.body.content !== 'string' || typeof req.body.message !== 'string') {
      return err(422, 'content and message are required');
    }
    let content: Buffer;
    try {
      content = Buffer.from((req.body.content as string).replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return err(400, 'Invalid base64 content');
    }
    const branchName = typeof req.body.branch === 'string' ? (req.body.branch as string) : repo.defaultBranch;
    const branchTip = resolveRefTip(repo, branchName);
    const existing = branchTip === null ? null : forge.fileAt(repo, branchTip, filePath);
    const givenSha = typeof req.body.sha === 'string' ? (req.body.sha as string) : null;
    if (existing !== null) {
      if (givenSha === null || givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
        return err(409, 'Conflict: the file has changed since the given sha');
      }
      const sha = forge.commitOnBranch(repo, branchName, new Map([[filePath, content]]), req.body.message as string);
      const blobSha = forge.fileAt(repo, sha, filePath)!.oid;
      return ok(200, { content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobSha, size: content.length, encoding: 'base64' }, commit: { sha, message: req.body.message } });
    }
    const sha = forge.commitOnBranch(repo, branchName, new Map([[filePath, content]]), req.body.message as string);
    const blobSha = forge.fileAt(repo, sha, filePath)!.oid;
    return ok(201, { content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobSha, size: content.length, encoding: 'base64' }, commit: { sha, message: req.body.message } });
  }

  if (method === 'DELETE') {
    const bad = badBody(req);
    if (bad !== null) return bad;
    if (tip === null) return err(404, 'Not Found');
    const existing = forge.fileAt(repo, tip, filePath);
    if (existing === null) return err(404, 'Not Found');
    const givenSha = isRecord(req.body) && typeof req.body.sha === 'string' ? (req.body.sha as string) : null;
    if (givenSha !== null && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return err(409, 'Conflict: the file has changed since the given sha');
    }
    const branchName = isRecord(req.body) && typeof req.body.branch === 'string' ? (req.body.branch as string) : repo.defaultBranch;
    const message = isRecord(req.body) && typeof req.body.message === 'string' ? (req.body.message as string) : `Delete ${filePath}`;
    const sha = forge.commitOnBranch(repo, branchName, new Map([[filePath, null]]), message);
    return ok(200, { commit: { sha, message } });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function handleIssues(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestResult {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(list, req.query, req.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return ok(200, page.map((issue) => issueJson(repo, issue)), link === null ? undefined : { link });
    }
    if (method === 'POST') {
      const bad = badBody(req);
      if (bad !== null) return bad;
      if (!isRecord(req.body) || typeof req.body.title !== 'string' || req.body.title === '') {
        return err(422, 'title is required');
      }
      const labels = Array.isArray(req.body.labels) ? (req.body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `Label '${label}' does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const seq = forge.nextSeq();
      const issue: Issue = {
        id: repo.id * 100000 + number,
        number,
        title: req.body.title as string,
        body: typeof req.body.body === 'string' ? (req.body.body as string) : '',
        state: 'open',
        labels,
        comments: [],
        seq,
        version: 1,
      };
      repo.issues.push(issue);
      return okText(201, issueJsonText(repo, issue));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return okText(200, issueJsonText(repo, issue));
    if (method === 'PATCH') {
      const bad = badBody(req);
      if (bad !== null) return bad;
      if (isRecord(req.body)) {
        if (typeof req.body.title === 'string') issue.title = req.body.title as string;
        if (typeof req.body.body === 'string') issue.body = req.body.body as string;
        if (req.body.state === 'open' || req.body.state === 'closed') issue.state = req.body.state;
        if (Array.isArray(req.body.labels)) {
          const labels = (req.body.labels as unknown[]).filter((label): label is string => typeof label === 'string');
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `Label '${label}' does not exist`);
          }
          issue.labels = labels;
        }
        issue.version += 1;
      }
      return okText(200, issueJsonText(repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (rest[1] === 'comments') {
    if (rest.length === 2 && method === 'GET') {
      return ok(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: userJson(), created_at: isoAt(comment.seq), updated_at: isoAt(comment.seq) })));
    }
    if (rest.length === 2 && method === 'POST') {
      const bad = badBody(req);
      if (bad !== null) return bad;
      if (!isRecord(req.body) || typeof req.body.body !== 'string' || req.body.body === '') {
        return err(422, 'body is required');
      }
      const id = repo.nextCommentId;
      repo.nextCommentId += 1;
      const comment = { id, body: req.body.body as string, seq: forge.nextSeq() };
      issue.comments.push(comment);
      issue.version += 1;
      return ok(201, { id, body: comment.body, user: userJson(), created_at: isoAt(comment.seq), updated_at: isoAt(comment.seq) });
    }
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

function handlePulls(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestResult {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state === 'open') list = list.filter((pr) => pr.state === 'open');
      else if (state === 'closed') list = list.filter((pr) => pr.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(list, req.query, req.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return ok(200, page.map((pr) => pullJson(forge, repo, pr)), link === null ? undefined : { link });
    }
    if (method === 'POST') {
      const bad = badBody(req);
      if (bad !== null) return bad;
      if (!isRecord(req.body) || typeof req.body.title !== 'string' || typeof req.body.head !== 'string' || typeof req.body.base !== 'string') {
        return err(422, 'title, head and base are required');
      }
      const head = req.body.head as string;
      const base = req.body.base as string;
      const headSha = repo.refCommit(`refs/heads/${head}`);
      const baseSha = repo.refCommit(`refs/heads/${base}`);
      if (headSha === null || baseSha === null) return err(422, 'head or base branch does not exist');
      const existing = repo.pulls.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
      if (existing !== undefined) return err(422, 'A pull request already exists for this head and base');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const seq = forge.nextSeq();
      const pr: PullRequest = {
        id: repo.id * 100000 + number,
        number,
        title: req.body.title as string,
        body: typeof req.body.body === 'string' ? (req.body.body as string) : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        baseShaAtCreation: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq,
      };
      repo.pulls.push(pr);
      return ok(201, pullJson(forge, repo, pr));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pr = repo.pulls.find((candidate) => candidate.number === number);
  if (pr === undefined) return err(404, 'Not Found');

  if (rest.length === 1 && method === 'GET') {
    return ok(200, pullJson(forge, repo, pr));
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = repo.refCommit(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseTip = repo.refCommit(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const headObject = repo.objects.get(headTip);
    const baseObject = repo.objects.get(baseTip);
    if (headObject === undefined || baseObject === undefined) return err(404, 'Not Found');
    const diffs = forge.diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
    const files = diffs.map((diff) => {
      const oldData = diff.oldOid === null ? null : repo.objects.get(diff.oldOid)?.data ?? null;
      const newData = diff.newOid === null ? null : repo.objects.get(diff.newOid)?.data ?? null;
      const counts = forge.lineCounts(oldData, newData);
      const status = diff.status === 'added' ? 'added' : diff.status === 'removed' ? 'removed' : 'modified';
      return {
        sha: diff.newOid ?? diff.oldOid ?? '',
        filename: diff.path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        blob_url: '',
        raw_url: '',
        contents_url: '',
        patch: '',
      };
    });
    return ok(200, files);
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const bad = badBody(req);
    if (bad !== null) return bad;
    if (pr.merged) return err(405, 'Pull request is already merged');
    if (pr.state !== 'open') return err(405, 'Pull request is closed');
    if (forge.mergeable(repo, pr) === 'CONFLICTING') return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
    const merged = forge.mergePull(repo, pr);
    if (merged === null) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
    return ok(200, { merged: true, sha: merged.sha, message: merged.message });
  }

  return err(404, 'Not Found');
}
