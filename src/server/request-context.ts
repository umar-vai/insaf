import { AsyncLocalStorage } from 'node:async_hooks';

// Facts about the request being handled, for code far from the request
// (the audit log records the address a change came from; the visits log
// needs the browser and a way to write after the answer is sent).

type RequestFacts = { ip: string; ua: string; waitUntil?: (p: Promise<unknown>) => void };
const store = new AsyncLocalStorage<RequestFacts>();

export function withRequest<T>(request: Request, run: () => T, ctx?: { waitUntil(p: Promise<unknown>): void }): T {
  const ip = (request.headers.get('CF-Connecting-IP') ?? '').slice(0, 64);
  const ua = (request.headers.get('User-Agent') ?? '').slice(0, 300);
  return store.run({ ip, ua, waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined }, run);
}

/** The visitor's address (CF-Connecting-IP), or '' outside a request. */
export const requestIp = () => store.getStore()?.ip ?? '';

/** The visitor's browser (User-Agent), or '' outside a request. */
export const requestUa = () => store.getStore()?.ua ?? '';

/** Runs work after the answer is sent when possible; otherwise waits for it. */
export async function later(p: Promise<unknown>): Promise<void> {
  const w = store.getStore()?.waitUntil;
  if (w) w(p.catch(() => {}));
  else await p.catch(() => {});
}
