import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listDonations } from '../../../server/donations';
import { toCsv } from '../../../lib/offline';

// The donations list as a spreadsheet (Excel opens it), with the same filters as the page.
export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams;
  const { rows } = await listDonations(
    env.DB,
    { fundId: p.get('fund') ?? undefined, status: p.get('status') ?? 'counted', q: p.get('q') ?? undefined, from: p.get('from') ?? undefined, to: p.get('to') ?? undefined, source: p.get('source') ?? undefined },
    2000,
  );
  const body = toCsv([
    ['Date (UTC)', 'Reference', 'Fund', 'Amount (Tk)', 'Donor', 'Phone', 'Email', 'On behalf of', 'Status', 'Voided', 'Gateway', 'Method', 'Source', 'Campaign', 'Recorded by', 'Note'],
    ...rows.map((d) => [
      d.paidAt ?? d.createdAt,
      d.reference,
      d.fundTitle,
      d.amountMinor / 100,
      d.donorName,
      d.donorPhone,
      d.donorEmail,
      d.onBehalf,
      d.status,
      d.voidedAt ? `yes: ${d.voidReason}` : '',
      d.gateway,
      d.method,
      d.utmSource,
      d.utmCampaign,
      d.recordedBy ?? '',
      d.note,
    ]),
  ]);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="donations-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
};
