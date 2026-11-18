import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listDonations } from '../../../server/donations';
import { toCsv } from '../../../lib/offline';

/** "2026-11-18 21:30" in Dhaka time; the books use Dhaka days, so the sheet must too. */
function dhakaStamp(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// The donations list as a spreadsheet (Excel opens it), with the same filters as the page.
export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams;
  const { rows } = await listDonations(
    env.DB,
    { fundId: p.get('fund') ?? undefined, status: p.get('status') ?? 'counted', q: p.get('q') ?? undefined, from: p.get('from') ?? undefined, to: p.get('to') ?? undefined, source: p.get('source') ?? undefined },
    2000,
  );
  const body = toCsv([
    ['Date (Dhaka)', 'Reference', 'Fund', 'Amount (Tk)', 'Donor', 'Phone', 'Email', 'On behalf of', 'Status', 'Voided', 'Gateway', 'Method', 'Source', 'Campaign', 'Recorded by', 'Note'],
    ...rows.map((d) => [
      dhakaStamp(d.paidAt ?? d.createdAt),
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
