// main.ts — the entrypoint. It owns the trial lifecycle and nothing else: the
// forge itself is built by createApp() in app.ts.
//
// The lifecycle, as the env expects it:
//   1. Read MAKEFUN_ENV_URL. With no env to talk to, exit 1 immediately.
//   2. Start the server on an ephemeral port (listen(0)); never 8080, the env owns it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register so the env knows where to dial.
//      The first register wins; a 409 just means someone else already registered.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then exit 0.
//      The env answers every poll at once, so this is a plain poll loop, never a
//      long-held request. Anything that fails along the way is retried with a short
//      exponential backoff; the process never exits before the env says done.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One request may take at most 30 s; a failed one waits 250 ms first, doubling
// each time up to 2 s, before it is tried again.
const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

function backoffMs(failures: number): number {
  const doubled = BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_MAX_MS, doubled);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST the bound port to the env until it is accepted (200, or 409: already registered). */
async function registerPort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
      // Any other status: the env may still be starting, so fall through and retry.
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
      // A network error or a timeout: the env is not answering yet, so retry.
    }
    failures += 1;
    await wait(backoffMs(failures));
  }
}

/** GET /done until the env answers {"done": true}. */
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: not done, poll again.
    }
    failures += 1;
    await wait(backoffMs(failures));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
