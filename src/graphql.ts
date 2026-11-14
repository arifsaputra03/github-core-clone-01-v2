// src/graphql.ts — a small GraphQL v4 executor for the documents gh and
// github-mcp-server actually send: viewer/repository/node/__type reads, issue and
// pull-request connections with cursors, and the create/close/merge/comment
// mutations. A hand-rolled parser for the documented subset (no dependency), with
// field validation that reports an unknown field as a 200 `errors` entry, the way
// GitHub does.
//
//   POST /api/graphql   {query, variables}  or  [{query, variables}, ...] (batching)

import {
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  VIEWER,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { parseCommit as parseCommitLocal } from './objects.ts';

// ------------------------------------------------------------------- parsing

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface Token {
  type: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'variable' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i + 1));
      if (match === null) throw new Error('bad variable');
      tokens.push({ type: 'variable', value: match[0] });
      i += 1 + match[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j]!;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error('bad number');
      tokens.push({ type: match[0].includes('.') || /[eE]/.test(match[0]) ? 'float' : 'int', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: 'name', value: match![0] });
      i += match![0].length;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.type === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().type !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first.type === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName.type === 'name') {
        name = maybeName.value;
        this.next();
      }
    }
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const varToken = this.next();
        if (varToken.type !== 'variable') throw new Error('expected a variable in the variable definitions');
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        variables.push({ name: varToken.value, defaultValue });
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      const token = this.next();
      if (token.type !== 'name') throw new Error('expected a type name');
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().type === 'spread') {
      this.next();
      const on = this.next();
      if (on.type !== 'name' || on.value !== 'on') throw new Error('expected "on" after ...');
      const typeToken = this.next();
      if (typeToken.type !== 'name') throw new Error('expected a type condition');
      return { kind: 'fragment', typeCondition: typeToken.value, selections: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.type !== 'name') throw new Error('expected a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.acceptPunct(':')) {
      alias = name;
      const nameToken = this.next();
      if (nameToken.type !== 'name') throw new Error('expected a field name after the alias');
      name = nameToken.value;
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.next();
        if (argName.type !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args.push({ name: argName.value, value: this.parseValue() });
      }
    }
    let selections: SelectionNode[] = [];
    if (this.peek().type === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.type) {
      case 'variable':
        return { kind: 'variable', name: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!this.acceptPunct(']')) values.push(this.parseValue());
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.acceptPunct('}')) {
            const nameToken = this.next();
            if (nameToken.type !== 'name') throw new Error('expected an object field name');
            this.expectPunct(':');
            fields.push({ name: nameToken.value, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected ${token.value} as a value`);
      default:
        throw new Error(`unexpected token ${token.value} as a value`);
    }
  }
}

// ------------------------------------------------------------------- execution

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface GqlContext {
  forge: Forge;
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// The schema surface the suite feature-detects, for __type introspection.
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'comments', 'labels', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'mergedAt', 'mergeCommitSha'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
};

const TYPE_KINDS: Readonly<Record<string, string>> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pr: PullRequest): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pr };
}

function stateOf(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateOf(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberAfter(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

function executeSelectionSet(parent: GqlObject, selections: SelectionNode[], ctx: GqlContext, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (parent.__typename === selection.typeCondition) {
        Object.assign(out, executeSelectionSet(parent, selection.selections, ctx, variables));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(parent, selection, ctx, variables);
    if (selection.selections.length === 0 || value === null || value === undefined) {
      out[key] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object' ? executeSelectionSet(item as GqlObject, selection.selections, ctx, variables) : item,
      );
      continue;
    }
    if (typeof value === 'object') {
      out[key] = executeSelectionSet(value as GqlObject, selection.selections, ctx, variables);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Resolve one field of an object; unknown fields become a GraphQL error and null. */
function resolveField(parent: GqlObject, field: FieldNode, ctx: GqlContext, variables: Record<string, unknown>): unknown {
  const typeName = parent.__typename;
  const args = argsOf(field, variables);
  const fail = (): null => {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  };

  if (typeName === 'Query') {
    if (field.name === 'viewer') return { __typename: 'User', login: VIEWER.login };
    if (field.name === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return fail();
      if (owner !== VIEWER.login) return null;
      const repo = ctx.forge.getRepo(owner, name);
      return repo === null ? null : repoObject(repo);
    }
    if (field.name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return fail();
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      for (const repo of ctx.forge.repos.values()) {
        if (decoded.kind === 'Repository' && repo.id === Number(decoded.key)) return repoObject(repo);
        if (decoded.kind === 'Issue') {
          const [repoId, number] = decoded.key.split(':');
          if (repo.id === Number(repoId)) {
            const issue = repo.issues.find((candidate) => candidate.number === Number(number));
            if (issue !== undefined) return issueObject(repo, issue);
          }
        }
        if (decoded.kind === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':');
          if (repo.id === Number(repoId)) {
            const pr = repo.pulls.find((candidate) => candidate.number === Number(number));
            if (pr !== undefined) return pullObject(repo, pr);
          }
        }
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return fail();
      const kind = TYPE_KINDS[name];
      if (kind === undefined) return null;
      return {
        __typename: '__Type',
        name,
        kind,
        fields: (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName })),
        enumValues: (ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value })),
      };
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query' } };
    }
    return fail();
  }

  if (typeName === 'Mutation') {
    return resolveMutation(parent, field, ctx, args);
  }

  if (typeName === 'Repository') {
    const repo = parent.__repo as Repo;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return repo.fullName;
      case 'owner':
        return { __typename: 'User', login: repo.owner };
      case 'defaultBranchRef': {
        const tip = repo.defaultTip();
        return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.isPrivate;
      case 'issue': {
        const number = args.number;
        if (typeof number !== 'number') return fail();
        const issue = repo.issues.find((candidate) => candidate.number === number);
        return issue === undefined ? null : issueObject(repo, issue);
      }
      case 'issues':
        return issuesConnection(repo, args);
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = repo.pulls.filter((pr) => pr.state === 'open').sort((a, b) => b.number - a.number).slice(0, first);
        return { __typename: 'PullRequestConnection', __nodes: nodes.map((pr) => pullObject(repo, pr)) };
      }
      case 'pullRequest': {
        const number = args.number;
        if (typeof number !== 'number') return fail();
        const pr = repo.pulls.find((candidate) => candidate.number === number);
        return pr === undefined ? null : pullObject(repo, pr);
      }
      default:
        return fail();
    }
  }

  if (typeName === 'Issue') {
    const issue = parent.__issue as Issue;
    const repo = parent.__repo as Repo;
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return stateOf(issue);
      case 'body':
        return issue.body;
      default:
        return fail();
    }
  }

  if (typeName === 'IssueConnection') {
    const nodes = (parent.__nodes as GqlObject[]) ?? [];
    if (field.name === 'nodes') return nodes;
    if (field.name === 'pageInfo') return parent.__pageInfo as GqlObject;
    if (field.name === 'totalCount') return nodes.length;
    return fail();
  }

  if (typeName === 'PullRequestConnection') {
    const nodes = (parent.__nodes as GqlObject[]) ?? [];
    if (field.name === 'nodes') return nodes;
    if (field.name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
    if (field.name === 'totalCount') return nodes.length;
    return fail();
  }

  if (typeName === 'PullRequest') {
    const pr = parent.__pull as PullRequest;
    const repo = parent.__repo as Repo;
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo, pr);
      case 'number':
        return pr.number;
      case 'title':
        return pr.title;
      case 'body':
        return pr.body;
      case 'state':
        return pullStateOf(pr);
      case 'merged':
        return pr.merged;
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'mergeable':
        return ctx.forge.mergeable(repo, pr);
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const headTip = repo.refCommit(`refs/heads/${pr.headRef}`) ?? pr.headSha;
        const baseTip = repo.refCommit(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
        const headObject = repo.objects.get(headTip);
        const baseObject = repo.objects.get(baseTip);
        if (headObject === undefined || baseObject === undefined) return { __typename: 'PullRequestChangedFileConnection', __nodes: [] };
        const diffs = ctx.forge.diffTrees(repo, parseCommitLocal(baseObject.data).tree, parseCommitLocal(headObject.data).tree);
        const nodes = diffs.slice(0, first).map((diff) => ({ __typename: 'PullRequestChangedFile', path: diff.path }));
        return { __typename: 'PullRequestChangedFileConnection', __nodes: nodes };
      }
      default:
        return fail();
    }
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') return (parent.__nodes as GqlObject[]) ?? [];
    return fail();
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path') return parent.path as string;
    return fail();
  }

  if (typeName === 'User') {
    if (field.name === 'login') return parent.login as string;
    if (field.name === 'name') return VIEWER.name;
    if (field.name === 'email') return VIEWER.email;
    return fail();
  }

  if (typeName === 'Ref') {
    if (field.name === 'name') return parent.name as string;
    return fail();
  }

  if (typeName === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.hasNextPage as boolean;
    if (field.name === 'endCursor') return parent.endCursor as string | null;
    return fail();
  }

  if (typeName === '__Type') {
    if (field.name === 'name') return parent.name as string;
    if (field.name === 'kind') return parent.kind as string;
    if (field.name === 'fields') return (parent.fields as GqlObject[]) ?? [];
    if (field.name === 'enumValues') return (parent.enumValues as GqlObject[]) ?? [];
    return fail();
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return parent.name as string;
    return fail();
  }

  if (typeName === '__Schema') {
    if (field.name === 'queryType') return parent.queryType as GqlObject;
    return fail();
  }

  // Mutation payloads and edge/node wrappers carry their fields as plain properties.
  if (field.name in parent && !field.name.startsWith('__')) {
    return parent[field.name];
  }

  return fail();
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = numberAfter(args.after ?? null);
  let list = [...repo.issues];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set((args.states as unknown[]).map((state) => String(state)));
    list = list.filter((issue) => wanted.has(stateOf(issue)));
  }
  const orderBy = args.orderBy as { field?: unknown; direction?: unknown } | undefined;
  // GitHub's issues connection defaults to CREATED_AT ASC; an explicit orderBy names its direction.
  const direction = orderBy === undefined ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  if (after !== null) list = list.filter((issue) => (direction === 'asc' ? issue.number > after : issue.number < after));
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]!.number);
  return {
    __typename: 'IssueConnection',
    __nodes: page.map((issue) => issueObject(repo, issue)),
    __pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function resolveMutation(parent: GqlObject, field: FieldNode, ctx: GqlContext, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const fail = (message: string): null => {
    ctx.errors.push({ message });
    return null;
  };

  if (field.name === 'createIssue') {
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') return fail('createIssue needs a repositoryId');
    const decoded = decodeGlobalId(repositoryId);
    if (decoded === null || decoded.kind !== 'Repository') return fail('createIssue needs a repositoryId');
    const repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(decoded.key));
    if (repo === undefined) return fail('createIssue: unknown repository');
    if (typeof input.title !== 'string' || input.title === '') return fail('createIssue needs a title');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: repo.id * 100000 + number,
      number,
      title: input.title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: ctx.forge.nextSeq(),
      version: 1,
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
  }

  if (field.name === 'closeIssue') {
    const issueId = input.issueId;
    if (typeof issueId !== 'string') return fail('closeIssue needs an issueId');
    const decoded = decodeGlobalId(issueId);
    if (decoded === null || decoded.kind !== 'Issue') return fail('closeIssue needs an issueId');
    const [repoId, number] = decoded.key.split(':');
    const repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(repoId));
    const issue = repo?.issues.find((candidate) => candidate.number === Number(number));
    if (repo === undefined || issue === undefined) return fail('closeIssue: unknown issue');
    issue.state = 'closed';
    issue.version += 1;
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
  }

  if (field.name === 'createPullRequest') {
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') return fail('createPullRequest needs a repositoryId');
    const decoded = decodeGlobalId(repositoryId);
    if (decoded === null || decoded.kind !== 'Repository') return fail('createPullRequest needs a repositoryId');
    const repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(decoded.key));
    if (repo === undefined) return fail('createPullRequest: unknown repository');
    const head = input.headRefName;
    const base = input.baseRefName;
    if (typeof head !== 'string' || typeof base !== 'string') return fail('createPullRequest needs headRefName and baseRefName');
    const headSha = repo.refCommit(`refs/heads/${head}`);
    const baseSha = repo.refCommit(`refs/heads/${base}`);
    if (headSha === null || baseSha === null) return fail('createPullRequest: head or base branch does not exist');
    const existing = repo.pulls.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
    if (existing !== undefined) return fail('A pull request already exists for this head and base');
    if (typeof input.title !== 'string' || input.title === '') return fail('createPullRequest needs a title');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pr: PullRequest = {
      id: repo.id * 100000 + number,
      number,
      title: input.title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      baseShaAtCreation: baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: ctx.forge.nextSeq(),
    };
    repo.pulls.push(pr);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pr) };
  }

  if (field.name === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId;
    if (typeof pullRequestId !== 'string') return fail('mergePullRequest needs a pullRequestId');
    const decoded = decodeGlobalId(pullRequestId);
    if (decoded === null || decoded.kind !== 'PullRequest') return fail('mergePullRequest needs a pullRequestId');
    const [repoId, number] = decoded.key.split(':');
    const repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(repoId));
    const pr = repo?.pulls.find((candidate) => candidate.number === Number(number));
    if (repo === undefined || pr === undefined) return fail('mergePullRequest: unknown pull request');
    if (pr.merged || pr.state !== 'open') return fail('mergePullRequest: the pull request is not open');
    if (ctx.forge.mergeable(repo, pr) === 'CONFLICTING') return fail('mergePullRequest: the pull request conflicts');
    const merged = ctx.forge.mergePull(repo, pr);
    if (merged === null) return fail('mergePullRequest: the pull request conflicts');
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pr) };
  }

  if (field.name === 'addComment') {
    const subjectId = input.subjectId;
    if (typeof subjectId !== 'string') return fail('addComment needs a subjectId');
    const decoded = decodeGlobalId(subjectId);
    if (decoded === null || decoded.kind !== 'Issue') return fail('addComment needs an issue subjectId');
    const [repoId, number] = decoded.key.split(':');
    const repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(repoId));
    const issue = repo?.issues.find((candidate) => candidate.number === Number(number));
    if (repo === undefined || issue === undefined) return fail('addComment: unknown issue');
    if (typeof input.body !== 'string') return fail('addComment needs a body');
    const id = repo.nextCommentId;
    repo.nextCommentId += 1;
    const comment = { id, body: input.body, seq: ctx.forge.nextSeq() };
    issue.comments.push(comment);
    issue.version += 1;
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: commentGlobalId(repo, comment), body: comment.body } },
    };
  }

  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

/** Execute one operation document. Returns the {data, errors} envelope. */
export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: GqlContext = { forge, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  const operation = operationName !== undefined ? operations.find((candidate) => candidate.name === operationName) : operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: operationName !== undefined ? `Unknown operation named "${operationName}".` : 'No operation in the document.' }] };
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (!(variable.name in mergedVariables) && variable.defaultValue !== null) {
      mergedVariables[variable.name] = valueOf(variable.defaultValue, variables);
    }
  }
  const root: GqlObject = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(root, operation.selections, ctx, mergedVariables);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** Handle one POST /api/graphql body (a single operation or a JSON array batch). */
export function handleGraphQL(forge: Forge, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null || typeof (entry as { query?: unknown }).query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched entry needs a query string.' }] };
      }
      const entryRecord = entry as { query: string; variables?: Record<string, unknown>; operationName?: string };
      return executeGraphQL(forge, entryRecord.query, entryRecord.variables ?? {}, entryRecord.operationName);
    });
    return { status: 200, body: results };
  }
  if (typeof body !== 'object' || body === null || typeof (body as { query?: unknown }).query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'A query string is required.' }] } };
  }
  const record = body as { query: string; variables?: Record<string, unknown>; operationName?: string };
  return { status: 200, body: executeGraphQL(forge, record.query, record.variables ?? {}, record.operationName) };
}
