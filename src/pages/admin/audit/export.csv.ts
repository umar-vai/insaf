import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ACTION_BN, auditLog, detailText } from '../../../server/audit';
import { toCsv } from '../../../lib/offline';

// The audit trail as a spreadsheet for an auditor, with the page's filters.
// Owners only (middleware: everything under /admin/audit). At most 5000 rows.
export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams;
  const filter = { actor: p.get('actor') ?? '', action: p.get('action') ?? '', from: p.get('from') ?? '', to: p.get('to') ?? '', q: (p.get('q') ?? '').trim() };
  const rows = await auditLog(env.DB, filter, 5000);
  const out: unknown[][] = [['When (UTC)', 'Who', 'Action', 'Action code', 'Record', 'Details', 'IP']];
  for (const r of rows) out.push([r.createdAt, r.actor, ACTION_BN[r.action] ?? r.action, r.action, r.target, detailText(r.detailJson), r.ip]);
  return new Response(toCsv(out), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"', 'Cache-Control': 'private, no-store' },
  });
};
