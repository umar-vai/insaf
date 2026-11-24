import { dayBn } from '../lib/offline';
import { log } from './admin';
import { parseBankStatement, matchBankStatement } from './bank-statement';
import { hmacHex, sameText } from './crypto';
import type { Result } from './ops-util';

type Delivery = { id: string; accountId: string; accountName: string; csv: string; receivedAt: string };
const SELECT = `SELECT d.id, d.account_id AS accountId, a.name AS accountName, d.csv, d.received_at AS receivedAt
  FROM bank_statement_deliveries d JOIN acc_accounts a ON a.id = d.account_id`;

async function boundedBody(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const stream = request.body.getReader();
  const decoder = new TextDecoder();
  let count = 0;
  let text = '';
  while (true) {
    const part = await stream.read();
    if (part.done) return text + decoder.decode();
    count += part.value.byteLength;
    if (count > limit) { await stream.cancel(); return null; }
    text += decoder.decode(part.value, { stream: true });
  }
}

export async function receiveBankDelivery(db: D1Database, config: { secret?: string; accounts?: string }, request: Request,
  today: string, now = Math.floor(Date.now() / 1000)): Promise<{ status: number }> {
  if (!config.secret || config.secret.length < 32 || !config.accounts) return { status: 404 };
  const timestamp = request.headers.get('X-Statement-Timestamp') ?? '';
  const event = request.headers.get('X-Statement-Id') ?? '';
  const signature = request.headers.get('X-Statement-Signature') ?? '';
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Number(timestamp) - now) > 300 ||
      !/^[A-Za-z0-9_.-]{8,90}$/.test(event) || !/^[a-f0-9]{64}$/.test(signature)) return { status: 401 };
  const body = await boundedBody(request, 20_000);
  if (body === null) return { status: 413 };
  if (!sameText(signature, await hmacHex(config.secret, `${timestamp}.${event}.${body}`))) return { status: 401 };

  let payload: { accountId?: unknown; csv?: unknown };
  try { payload = JSON.parse(body); }
  catch { return { status: 400 }; }
  if (!payload || typeof payload.accountId !== 'string' || typeof payload.csv !== 'string' ||
      !config.accounts.split(',').map((id) => id.trim()).includes(payload.accountId)) return { status: 400 };
  if (!parseBankStatement(payload.csv, today).ok) return { status: 400 };
  const inserted = await db.prepare(`INSERT INTO bank_statement_deliveries (id, account_id, csv)
    SELECT ?1, id, ?2 FROM acc_accounts WHERE id = ?3 AND status = 'active' AND kind IN ('bank','mobile')
    ON CONFLICT (id) DO NOTHING`).bind(event, payload.csv, payload.accountId).run();
  if (inserted.meta.changes) return { status: 202 };
  const seen = await bankDelivery(db, event);
  return { status: seen?.accountId === payload.accountId && seen.csv === payload.csv ? 200 : seen ? 409 : 400 };
}

export const bankDelivery = (db: D1Database, id: string) => db.prepare(`${SELECT} WHERE d.id = ?`).bind(id).first<Delivery>();

export async function bankDeliveries(db: D1Database) {
  return (await db.prepare(`${SELECT} WHERE d.reviewed_at IS NULL ORDER BY d.received_at DESC, d.id LIMIT 50`).all<Delivery>()).results;
}

export async function finishBankDelivery(db: D1Database, actor: string, id: string, today: string, note: string): Promise<Result<boolean>> {
  const item = await bankDelivery(db, id);
  if (!item || note.trim().length < 3) return { ok: false, error: 'delivery' };
  const parsed = parseBankStatement(item.csv, today);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const matches = await matchBankStatement(db, item.accountId, parsed.value);
  const result = await db.prepare(`UPDATE bank_statement_deliveries SET reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reviewed_by = ?
    WHERE id = ? AND reviewed_at IS NULL`).bind(actor, id).run();
  if (!result.meta.changes) return { ok: false, error: 'delivery' };
  await log(db, actor, 'accounts.feed.review', `account:${item.accountId}`, {
    id, lineCount: parsed.value.length, cleared: matches.ok ? matches.value.filter((line) => line.state === 'cleared').length : 0,
    date: dayBn(today), note: note.trim().slice(0, 300),
  });
  return { ok: true, value: true };
}
