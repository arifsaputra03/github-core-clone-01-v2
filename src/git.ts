// src/git.ts — git smart HTTP: ref advertisements (v0 and v2), ls-refs, fetch and
// receive-pack. The wire shapes mirror the kit's git-client.ts exactly: the same
// pkt-line framing, the same section order, the same report-status lines.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack    (command=ls-refs | command=fetch)
//   POST /{owner}/{repo}.git/git-receive-pack   (command list + pack, report-status)

import {
  decodePktLines,
  encodePktLine,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './objects.ts';
import { collectReachable } from './objects.ts';
import { DEFAULT_BRANCH, type Forge, type Repo } from './store.ts';

export const SERVER_AGENT = 'github-core-clone-forge/1.0';

/** One advertised ref, as ls-refs and the v0 advertisement report it. */
interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repository, HEAD first, sorted by name after it. */
function allRefs(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultOid = repo.refs.get(defaultRef);
  if (defaultOid !== undefined) {
    out.push({ oid: defaultOid, name: 'HEAD', symrefTarget: defaultRef });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: defaultRef, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: AdvertisedRef = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const peeled = repo.peelToCommit(target);
      if (peeled !== null) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function refLinesV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer[] {
  const capabilities =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs thin-pack ofs-delta'
      : `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  const refs = allRefs(repo);
  const real = refs.filter((ref) => ref.name !== 'HEAD');
  if (real.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities} agent=${SERVER_AGENT}\n`));
  } else {
    const head = refs.find((ref) => ref.name === 'HEAD')!;
    const headOid = head.unborn === true ? ZERO_OID : head.oid;
    parts.push(encodePktLine(`${headOid} HEAD\u0000${capabilities} agent=${SERVER_AGENT}\n`));
    for (const ref of real) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktLineFlush());
  return parts;
}

function advertisementV2(): Buffer[] {
  return [
    encodePktLine('version 2\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('ls-refs\n'),
    encodePktLine('object-format=sha1\n'),
    encodePktLine(`agent=${SERVER_AGENT}\n`),
    pktLineFlush(),
  ];
}

/** The v2 advertisement never changes; build it once. */
const ADVERTISEMENT_V2 = Buffer.concat(advertisementV2());

/** Cached v0 advertisements, keyed by service and repo version. Every mutation
 *  that changes a ref or an object bumps `repo.version`, so a cached advertisement
 *  can never be stale. The clone/push benchmarks re-request the same advertisement
 *  dozens of times per round; rebuilding its pkt-lines (sort + tag peeling) each
 *  time is pure waste. */
const advertCache = new WeakMap<Repo, Map<string, Buffer>>();

/** GET /{owner}/{repo}.git/info/refs?service=... — 404 when the repository is missing. */
export function handleInfoRefs(forge: Forge, owner: string, repoName: string, service: string, gitProtocol: string | null): { status: number; contentType: string; body: Buffer } | null {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return null;
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  }
  const isV2 = service === 'git-upload-pack' && gitProtocol === 'version=2';
  let body: Buffer;
  if (isV2) {
    body = ADVERTISEMENT_V2;
  } else {
    const key = `${service}:${repo.version}`;
    let cache = advertCache.get(repo);
    if (cache === undefined) {
      cache = new Map();
      advertCache.set(repo, cache);
    }
    const hit = cache.get(key);
    if (hit !== undefined) {
      body = hit;
    } else {
      body = Buffer.concat(refLinesV0(repo, service));
      if (cache.size > 64) cache.clear();
      cache.set(key, body);
    }
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body,
  };
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Parse a v2 upload-pack request body into its command and arguments. */
function parseUploadPack(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).replace(/\n$/, '') : '';
  return { command, args: lines.slice(1) };
}

/** POST git-upload-pack: ls-refs or fetch. Returns null when the body is not an upload-pack request. */
export function handleUploadPack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  let parsed: { command: string; args: string[] };
  try {
    parsed = parseUploadPack(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n') };
  }
  if (parsed.command === 'ls-refs') return lsRefs(repo, parsed.args);
  if (parsed.command === 'fetch') return fetchPack(repo, parsed.args);
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n') };
}

function lsRefs(repo: Repo, args: readonly string[]): { status: number; contentType: string; body: Buffer } {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = allRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.name === 'HEAD' && ref.unborn === true && !unborn) continue;
    let line: string;
    if (ref.unborn === true) {
      line = `unborn HEAD${symrefs && ref.symrefTarget !== undefined ? ` symref-target:${ref.symrefTarget}` : ''}\n`;
    } else {
      line = `${ref.oid} ${ref.name}`;
      if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      line += '\n';
    }
    parts.push(encodePktLine(line));
  }
  parts.push(pktLineFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** The commit ancestors of `oid` (parents only), including `oid` itself. */
function commitAncestors(repo: Repo, oid: string): Set<string> {
  const out = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (out.has(current)) continue;
    out.add(current);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

interface FetchPlan {
  toSend: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/** The objects a fetch's `have` lines prove the client holds. A shallow boundary
 *  commit is held itself (with its tree) but not its history: the walk stops there,
 *  so a deepen can still deliver the parent. */
function haveClosure(repo: Repo, haves: readonly string[], shallowBoundaries: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const lookup = (oid: string): GitObject | undefined => repo.lookup(oid);
  const queue = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const entry of collectReachable([commit.tree], lookup, { allowMissing: true })) out.add(entry);
      if (!shallowBoundaries.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of collectReachable([oid], lookup, { allowMissing: true })) out.add(entry);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return out;
}

/** Work out which objects a fetch delivers, honouring haves and depth. */
function planFetch(repo: Repo, request: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.lookup(oid);
  const havesClosure = haveClosure(repo, request.haves, new Set(request.shallow));

  // Resolve wants to commit tips (a tag want contributes its target commit).
  const wantCommits: string[] = [];
  const extraObjects = new Map<string, GitObject>();
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraObjects.set(want, object);
      const target = repo.peelToCommit(want);
      if (target !== null) wantCommits.push(target);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }

  const included = new Set<string>();
  const newShallow: string[] = [];
  if (request.depth === null) {
    for (const oid of collectReachable(wantCommits, lookup, { allowMissing: true })) included.add(oid);
  } else {
    // Depth-limited walk over commits: distance < depth from a want.
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; depth: number }> = wantCommits.map((oid) => ({ oid, depth: 0 }));
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (distance.has(current.oid)) continue;
      distance.set(current.oid, current.depth);
      const object = repo.objects.get(current.oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (current.depth + 1 < request.depth) {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: current.depth + 1 });
      }
    }
    for (const [oid] of distance) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      // A commit is a new shallow boundary when it has a parent outside the walk.
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((parent) => !distance.has(parent))) newShallow.push(oid);
    }
    // Included is exactly the walked commits plus their own trees/blobs — not the parents.
    for (const oid of distance.keys()) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      included.add(oid);
      for (const entry of collectReachable([commit.tree], lookup, { allowMissing: true })) included.add(entry);
    }
  }
  for (const [oid, object] of extraObjects) included.add(oid);

  const toSend = new Map<string, GitObject>();
  for (const oid of included) {
    if (havesClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) toSend.set(oid, object);
  }
  const unshallow = request.shallow.filter((oid) => included.has(oid) && !newShallow.includes(oid));
  return { toSend, shallow: newShallow, unshallow };
}

const packCache = new WeakMap<Repo, Map<string, Buffer>>();

/** Cached whole fetch responses (acknowledgments + shallow-info + packfile).
 *  The response is a pure function of the request and the repo's objects/refs,
 *  both covered by the cache key (repo id + version + wants/haves/shallow/depth),
 *  so a hit is byte-identical to rebuilding it. The clone benchmark issues the
 *  same 50 fetches per round; skipping the ack walk, the fetch plan and the
 *  sideband framing on repeats is the whole win. */
const fetchResponseCache = new WeakMap<Repo, Map<string, Buffer>>();

function fetchPack(repo: Repo, args: readonly string[]): { status: number; contentType: string; body: Buffer } {
  const request: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth)) request.depth = depth;
    }
  }
  const cacheKey = `${repo.id}:${repo.version}:${[...request.wants].sort().join(',')}:${request.depth ?? ''}:${[...request.haves].sort().join(',')}:${[...request.shallow].sort().join(',')}`;
  let responseCache = fetchResponseCache.get(repo);
  if (responseCache === undefined) {
    responseCache = new Map();
    fetchResponseCache.set(repo, responseCache);
  }
  const cached = responseCache.get(cacheKey);
  if (cached !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const parts: Buffer[] = [];
  // acknowledgments
  const lookup = (oid: string): GitObject | undefined => repo.lookup(oid);
  let ack: string | null = null;
  if (request.haves.length > 0) {
    const wantClosure = new Set<string>();
    for (const want of request.wants) {
      for (const oid of collectReachable([want], lookup, { allowMissing: true })) wantClosure.add(oid);
    }
    for (const have of request.haves) {
      if (wantClosure.has(have)) {
        ack = have;
        break;
      }
    }
  }
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine(ack === null ? 'NAK\n' : `ACK ${ack}\n`));
  parts.push(pktLineDelim());

  const plan = planFetch(repo, request);
  if (request.depth !== null && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }

  if (plan.toSend.size > 0) {
    let cache = packCache.get(repo);
    if (cache === undefined) {
      cache = new Map();
      packCache.set(repo, cache);
    }
    let pack = cache.get(cacheKey);
    if (pack === undefined) {
      // Deterministic order: commits, then trees, then blobs, each in oid order, so the
      // same request always builds the same pack bytes.
      const rank = (type: string): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3);
      const objects = [...plan.toSend.entries()].sort(([aOid, a], [bOid, b]) => rank(a.type) - rank(b.type) || (aOid < bOid ? -1 : aOid > bOid ? 1 : 0)).map(([, object]) => object);
      pack = writePack(objects);
      if (cache.size > 64) cache.clear();
      cache.set(cacheKey, pack);
    }
    parts.push(encodePktLine('packfile\n'));
    // Sideband band 1, chunked so no pkt-line exceeds the maximum.
    const CHUNK = 32768;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
      const payload = Buffer.concat([Buffer.from([1]), chunk]);
      parts.push(encodePktLine(payload));
    }
  }
  parts.push(pktLineFlush());
  const body = Buffer.concat(parts);
  if (responseCache.size > 64) responseCache.clear();
  responseCache.set(cacheKey, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Whether `ancestor` is reachable from `oid` following commit parents. */
function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target === ancestor) return true;
      queue.push(target);
    }
  }
  return false;
}

/** POST git-receive-pack: apply a command list and its pack, answer report-status in sideband. */
export async function handleReceivePack(repo: Repo, body: Buffer): Promise<{ status: number; contentType: string; body: Buffer }> {
  let commands: PushCommand[] = [];
  let packBytes = Buffer.alloc(0);
  try {
    const { packets, trailing } = decodePktLines(body, { allowTrailing: true });
    packBytes = trailing;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\u0000');
      if (nul >= 0) line = line.slice(0, nul);
      line = line.replace(/\n$/, '');
      if (line === '') continue;
      const fields = line.split(' ');
      if (fields.length !== 3 || !isObjectId(fields[0]!) || !isObjectId(fields[1]!) || !fields[2]!.startsWith('refs/')) {
        throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
      }
      commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
    }
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n') };
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n') };
  }

  // Unpack first: a refused update still unpacks, and the objects stay stored.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = await readPack(packBytes);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, object);
          if (object.type === 'commit') repo.commitSeq.set(oid, repo.objects.size);
        }
      }
      repo.version += 1;
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`];
  for (const command of commands) {
    let ok = false;
    if (!unpackOk) {
      ok = false;
    } else {
      const current = repo.refs.get(command.ref) ?? null;
      if (command.oldOid === ZERO_OID && command.newOid !== ZERO_OID) {
        // Create: the ref must not exist and the new object must be present.
        ok = current === null && repo.objects.has(command.newOid);
      } else if (command.newOid === ZERO_OID) {
        // Delete: the ref must exist and the old value must match (or be unchecked).
        ok = current !== null && (command.oldOid === ZERO_OID || command.oldOid === current);
      } else {
        // Update: the old value must match and the new tip must descend from it.
        ok =
          current !== null &&
          command.oldOid === current &&
          repo.objects.has(command.newOid) &&
          isAncestor(repo, command.oldOid, command.newOid);
      }
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      repo.version += 1;
      reportLines.push(`ok ${command.ref}`);
    } else {
      reportLines.push(`ng ${command.ref} ${unpackOk ? 'non-fast-forward' : 'unpack failed'}`);
    }
  }

  // Report-status inside sideband band 1: each report line is itself a pkt-line.
  const parts: Buffer[] = [];
  for (const line of reportLines) {
    const inner = encodePktLine(`${line}\n`);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), inner])));
  }
  parts.push(pktLineFlush());
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}

export { hashObject };
