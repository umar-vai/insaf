import { describe, expect, it, vi } from 'vitest';
import { buildPurchaseEvent, capiConfigured, metaPhone, sendPurchase } from '../src/server/meta-capi';

const gift = { reference: 'DMP123', amountMinor: 150000, phone: '01712345678', email: ' Donor@Example.com ', paidAt: '2026-11-18T10:00:00.000Z' };
const live = { ENVIRONMENT: 'production', META_PIXEL_ID: '1270876547892049', META_CAPI_TOKEN: 'secret' };

describe('Meta Conversions API', () => {
  it('normalises Bangladesh phone numbers', () => {
    expect(metaPhone('01712345678')).toBe('8801712345678');
    expect(metaPhone('+880 1712-345678')).toBe('8801712345678');
    expect(metaPhone('12345')).toBe('');
  });

  it('builds one purchase event with the same id the browser uses and hashed contacts', async () => {
    const e = await buildPurchaseEvent(gift, 'https://madrasatulinsaf.org');
    expect(e.event_id).toBe('purchase-DMP123');
    expect(e.custom_data).toEqual({ value: 1500, currency: 'BDT' });
    expect(e.user_data.ph?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(e)).not.toContain('01712345678');
    expect(JSON.stringify(e)).not.toContain('example.com');
  });

  it('is off without the token, off on test sites, and never throws', async () => {
    const f = vi.fn();
    expect(capiConfigured({ ...live, META_CAPI_TOKEN: '' })).toBe(false);
    expect(capiConfigured({ ...live, ENVIRONMENT: 'local' })).toBe(false);
    expect(await sendPurchase({ ...live, META_CAPI_TOKEN: '' }, gift, 'https://x', f as unknown as typeof fetch)).toBe(false);
    expect(f).not.toHaveBeenCalled();
    const boom = vi.fn().mockRejectedValue(new Error('down'));
    expect(await sendPurchase(live, gift, 'https://x', boom as unknown as typeof fetch)).toBe(false);
  });

  it('posts to the pixel events endpoint when configured', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    expect(await sendPurchase(live, gift, 'https://x', f as unknown as typeof fetch)).toBe(true);
    expect(String(f.mock.calls[0]?.[0])).toContain('/1270876547892049/events?access_token=');
  });
});
