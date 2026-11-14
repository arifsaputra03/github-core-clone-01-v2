// src/store.ts — the forge's in-memory store: repositories, refs, git objects, issues,
// pull requests, labels and comments, plus the tree/commit/merge machinery the REST,
// GraphQL and MCP surfaces share. Everything is synchronous and in-memory; a trial's
// whole state fits easily in the pod's 1024 MB.
//
// The token's owner is the scenario's seeded viewer (the kit's wire.ts builds the one
// scenario from a fixed seed, so this identity is the same in every trial, practice or
// scored). Any other owner string names a different user with no repositories here.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './objects.ts';

/** The login the bearer token names (wire.ts Scenario.viewer, fixed seed). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;
export const DEFAULT_BRANCH = 'main';

/** Deterministic clock: a fixed epoch plus a per-forge counter, so server-made commit
 *  SHAs and timestamps are reproducible across runs of the same request sequence. */
const EPOCH_SEC = 1_735_689_600;

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly seq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly seq: number;
  /** Bumped on every mutation; serializations cached by this version stay valid. */
  version: number;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The base tip when the pull request was opened: the merge base for conflict checks. */
  readonly baseShaAtCreation: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly seq: number;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string = DEFAULT_BRANCH;
  /** ref name -> commit/tag oid. */
  readonly refs = new Map<string, string>();
  /** oid -> object. */
  readonly objects = new Map<string, GitObject>();
  /** commit oid -> creation sequence (newest-first ordering for /commits). */
  readonly commitSeq = new Map<string, number>();
  readonly issues: Issue[] = [];
  readonly pulls: PullRequest[] = [];
  readonly labels = new Map<string, Label>();
  nextNumber = 1;
  nextCommentId = 1;
  /** Bumped on every mutation; the git layer keys its pack cache on it. */
  version = 0;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  defaultTip(): string | null {
    return this.refs.get(`refs/heads/${this.defaultBranch}`) ?? null;
  }

  lookup(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      if (type === 'commit') this.commitSeq.set(oid, this.objects.size);
    }
    return oid;
  }

  /** Resolve a ref name to an oid, following a tag object to its target commit. */
  peelToCommit(oid: string): string | null {
    const object = this.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      return this.peelToCommit(target);
    }
    return null;
  }

  /** The commit a ref points at, or null. */
  refCommit(ref: string): string | null {
    const oid = this.refs.get(ref);
    if (oid === undefined) return null;
    return this.peelToCommit(oid);
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 0;

  /** A strictly increasing sequence for ordering and deterministic timestamps. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  timestamp(): number {
    return EPOCH_SEC + this.seq;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repository owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  // ---------------------------------------------------------- trees and files

  /** Flatten a tree to path -> {oid, mode}, walking subdirectories. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, path: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const full = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, full);
        else out.set(full, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** The entries directly under `dirPath` in a tree (files and subdirectories). */
  dirEntries(repo: Repo, treeOid: string, dirPath: string): Array<{ name: string; path: string; oid: string; mode: string; type: 'file' | 'dir' }> | null {
    let current = treeOid;
    if (dirPath !== '') {
      for (const segment of dirPath.split('/')) {
        const object = repo.objects.get(current);
        if (object === undefined || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (entry === undefined || entry.mode !== '40000') return null;
        current = entry.oid;
      }
    }
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      oid: entry.oid,
      mode: entry.mode,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  /** Build a new tree from a base tree plus file changes (Buffer to set, null to delete). */
  buildTreeWithChanges(repo: Repo, baseTreeOid: string | null, changes: ReadonlyMap<string, Buffer | null>): string {
    const flat = baseTreeOid === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, baseTreeOid);
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else {
        const oid = repo.putObject('blob', content);
        flat.set(path, { oid, mode: '100644' });
      }
    }
    // Rebuild bottom-up: group paths by directory.
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i]!;
        let child = node.dirs.get(segment);
        if (child === undefined) {
          child = make();
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return repo.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on `branch` applying `changes` to its tip tree; returns the commit sha.
   *  A branch that does not exist yet forks from the default branch tip (as GitHub's
   *  contents API does); the very first commit of a repository is a root commit. */
  commitOnBranch(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref) ?? repo.defaultTip() ?? null;
    const baseTree = parent === null ? null : parseCommit(repo.objects.get(parent)!.data).tree;
    const tree = this.buildTreeWithChanges(repo, baseTree, changes);
    const seq = this.nextSeq();
    const commit = buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: EPOCH_SEC + seq,
    });
    const sha = repo.putObject('commit', commit);
    repo.commitSeq.set(sha, repo.objects.size);
    repo.refs.set(ref, sha);
    repo.version += 1;
    return sha;
  }

  /** The blob at `path` in the tree of `commitSha`, or null. */
  fileAt(repo: Repo, commitSha: string, path: string): { oid: string; data: Buffer } | null {
    const commitObject = repo.objects.get(commitSha);
    if (commitObject === undefined || commitObject.type !== 'commit') return null;
    const flat = this.flattenTree(repo, parseCommit(commitObject.data).tree);
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined || blob.type !== 'blob') return null;
    return { oid: entry.oid, data: blob.data };
  }

  /** Commits reachable from `fromSha`, newest first (by creation sequence). */
  listCommits(repo: Repo, fromSha: string | null): string[] {
    if (fromSha === null) return [];
    const reachable = collectReachable([fromSha], (oid) => repo.lookup(oid), { allowMissing: true });
    const commits: string[] = [];
    for (const oid of reachable) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') commits.push(oid);
    }
    commits.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
    return commits;
  }

  // ---------------------------------------------------------- diffs and merges

  /** File-level diff between two trees. */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    for (const [path, value] of head) {
      const old = base.get(path);
      if (old === undefined) out.push({ path, status: 'added', oldOid: null, newOid: value.oid });
      else if (old.oid !== value.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: value.oid });
    }
    for (const [path, value] of base) {
      if (!head.has(path)) out.push({ path, status: 'removed', oldOid: value.oid, newOid: null });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** Added/removed line counts between two blobs (multiset line difference). */
  lineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const linesOf = (data: Buffer | null): Map<string, number> => {
      const counts = new Map<string, number>();
      if (data === null) return counts;
      for (const line of data.toString('utf8').split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const oldLines = linesOf(oldData);
    const newLines = linesOf(newData);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newLines) {
      const missing = count - (oldLines.get(line) ?? 0);
      if (missing > 0) additions += missing;
    }
    for (const [line, count] of oldLines) {
      const missing = count - (newLines.get(line) ?? 0);
      if (missing > 0) deletions += missing;
    }
    return { additions, deletions };
  }

  /** Whether a pull request merges cleanly (three-way, against the base at creation). */
  mergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    if (pr.merged) return 'MERGEABLE';
    const headTip = repo.refCommit(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refCommit(`refs/heads/${pr.baseRef}`);
    if (headTip === null || baseTip === null) return 'CONFLICTING';
    if (headTip === baseTip) return 'MERGEABLE';
    const baseTree = parseCommit(repo.objects.get(pr.baseShaAtCreation)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const currentTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const currentFlat = this.flattenTree(repo, currentTree);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...currentFlat.keys()]);
    for (const path of paths) {
      const baseOid = baseFlat.get(path)?.oid ?? null;
      const headOid = headFlat.get(path)?.oid ?? null;
      const currentOid = currentFlat.get(path)?.oid ?? null;
      if (headOid === baseOid) continue;
      if (currentOid === baseOid) continue;
      if (headOid === currentOid) continue;
      return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha, or
   * null when the merge conflicts. The squash commit has one parent (the base tip) and
   * the merged tree.
   */
  mergePull(repo: Repo, pr: PullRequest): { sha: string; message: string } | null {
    if (pr.merged || pr.state !== 'open') return null;
    if (this.mergeable(repo, pr) === 'CONFLICTING') return null;
    const headTip = repo.refCommit(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refCommit(`refs/heads/${pr.baseRef}`);
    if (headTip === null || baseTip === null) return null;
    const baseTree = parseCommit(repo.objects.get(pr.baseShaAtCreation)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const currentTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const currentFlat = this.flattenTree(repo, currentTree);
    const changes = new Map<string, Buffer | null>();
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const baseOid = baseFlat.get(path)?.oid ?? null;
      const headOid = headFlat.get(path)?.oid ?? null;
      if (headOid === baseOid) continue;
      if (headOid === null) changes.set(path, null);
      else {
        const blob = repo.objects.get(headOid);
        if (blob !== undefined) changes.set(path, blob.data);
      }
    }
    // Anything the base changed since creation that the head did not touch stays as-is:
    // buildTreeWithChanges starts from the CURRENT base tree, so only head's changes apply.
    void currentFlat;
    const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`;
    const seq = this.nextSeq();
    const tree = this.buildTreeWithChanges(repo, currentTree, changes);
    const commit = buildCommit({
      tree,
      parents: [baseTip],
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: EPOCH_SEC + seq,
    });
    const sha = repo.putObject('commit', commit);
    repo.commitSeq.set(sha, repo.objects.size);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    repo.version += 1;
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = new Date((EPOCH_SEC + seq) * 1000).toISOString();
    pr.mergeCommitSha = sha;
    return { sha, message: message.trimEnd() };
  }
}

// ---------------------------------------------------------------- global ids

/** An opaque, stable Relay-style global id: base64url of `<Kind>:<key>`. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pr: PullRequest): string {
  return globalId('PullRequest', `${repo.id}:${pr.number}`);
}

export function commentGlobalId(repo: Repo, comment: IssueComment): string {
  return globalId('IssueComment', `${repo.id}:${comment.id}`);
}

/** Decode a global id this forge issued, or null. */
export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
}

/** The ISO timestamp for a creation sequence number (deterministic). Memoized:
 *  the same few sequence numbers recur on every serialization, and `Date` +
 *  `toISOString` is otherwise paid per field, per issue, per request. The clock
 *  is deterministic, so the value for a seq never changes; the cache is capped
 *  so a long-lived forge cannot grow it without bound. */
const isoCache = new Map<number, string>();
export function isoAt(seq: number): string {
  const hit = isoCache.get(seq);
  if (hit !== undefined) return hit;
  const value = new Date((EPOCH_SEC + seq) * 1000).toISOString();
  if (isoCache.size > 100_000) isoCache.clear();
  isoCache.set(seq, value);
  return value;
}

export { ZERO_OID };
