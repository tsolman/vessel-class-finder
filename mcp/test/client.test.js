import { describe, it, expect, vi } from 'vitest';
import {
  normalizeImo,
  normalizeImos,
  isInClass,
  societyName,
  lookupVessels,
  lookupVesselDemo,
  checkUsage,
  ToolError,
} from '../src/client.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const cfg = (fetchImpl, apiKey = 'k') => ({ apiKey, baseUrl: 'https://api.test', fetch: fetchImpl });
const vessel = (imo, status, cls = 'ABS') => ({ imo, vessel_name: 'X', class: cls, status });

describe('IMO validation', () => {
  it('accepts numbers and digit strings up to 7 digits', () => {
    expect(normalizeImo(9321483)).toBe('9321483');
    expect(normalizeImo(' 123 ')).toBe('123');
  });
  it.each(['', 'abc', '12345678', '93-21', '9321483.5', null, {}])('rejects %j', (v) => {
    expect(() => normalizeImo(v)).toThrow(ToolError);
  });
  it('dedupes and enforces 1-100', () => {
    expect(normalizeImos(['1', 1, '2'])).toEqual(['1', '2']);
    expect(() => normalizeImos([])).toThrow(/at least one/);
    expect(() => normalizeImos(Array.from({ length: 101 }, (_, i) => i + 1))).toThrow(/maximum is 100/);
  });
  it('does not call fetch for invalid IMOs', async () => {
    const f = vi.fn();
    await expect(lookupVessels(cfg(f), ['abc'])).rejects.toThrow(/Invalid IMO/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('derivations', () => {
  it('derives in_class from status', () => {
    for (const s of ['Delivered', 'Reinstated', 'Reassigned']) expect(isInClass(s)).toBe(true);
    for (const s of ['Suspended', 'Withdrawn', '', undefined]) expect(isInClass(s)).toBe(false);
  });
  it('maps society codes', () => {
    expect(societyName('NV')).toBe('DNV');
    expect(societyName('XYZ')).toBe('XYZ');
  });
});

describe('lookupVessels', () => {
  it('posts deduped IMOs with key, enriches results and lists not found', async () => {
    const f = vi.fn().mockResolvedValue(json(200, [vessel(9321483, 'Delivered', 'ABS'), vessel(1234567, 'Suspended', 'NV')]));
    const r = await lookupVessels(cfg(f), ['9321483', 9321483, '1234567', '7654321']);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.test/vessels');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('k');
    expect(JSON.parse(init.body)).toEqual({ imos: ['9321483', '1234567', '7654321'] });
    expect(r.vessels.map((v) => [v.society, v.in_class])).toEqual([
      ['ABS (American Bureau of Shipping)', true],
      ['DNV', false],
    ]);
    expect(r.not_found).toEqual(['7654321']);
    expect(r.note).toMatch(/not classed|wrong/);
  });
  it('omits note when everything is found', async () => {
    const f = vi.fn().mockResolvedValue(json(200, [vessel(9321483, 'Delivered')]));
    const r = await lookupVessels(cfg(f), ['9321483']);
    expect(r.not_found).toEqual([]);
    expect(r.note).toBeUndefined();
  });
  it('errors helpfully without an API key', async () => {
    const f = vi.fn();
    const p = lookupVessels(cfg(f, null), ['9321483']);
    await expect(p).rejects.toThrow(/vesselclassfinder\.com\/#signup/);
    await expect(p).rejects.toThrow(/lookup_vessel_demo/);
    expect(f).not.toHaveBeenCalled();
  });
  it('maps 429 with upgrade url', async () => {
    const f = vi.fn().mockResolvedValue(
      json(429, { error: 'limit', upgrade_url: 'https://up.example', usage: 100, limit: 100, plan: 'free' })
    );
    await expect(lookupVessels(cfg(f), ['1'])).rejects.toThrow(/limit reached.*used 100 of 100.*https:\/\/up\.example/);
  });
  it('maps 403', async () => {
    const f = vi.fn().mockResolvedValue(json(403, { error: 'Invalid API key' }));
    await expect(lookupVessels(cfg(f), ['1'])).rejects.toThrow(/key was rejected \(403.*Invalid API key/);
  });
  it('maps 400 and network failures', async () => {
    await expect(lookupVessels(cfg(vi.fn().mockResolvedValue(json(400, { error: 'bad' }))), ['1'])).rejects.toThrow(/400.*bad/);
    await expect(lookupVessels(cfg(vi.fn().mockRejectedValue(new Error('boom'))), ['1'])).rejects.toThrow(/Could not reach.*boom/);
  });
});

describe('lookupVesselDemo', () => {
  it('calls /demo without a key header', async () => {
    const f = vi.fn().mockResolvedValue(json(200, vessel(9321483, 'Delivered', 'ABS')));
    const r = await lookupVesselDemo(cfg(f, null), '9321483');
    expect(f.mock.calls[0][0]).toBe('https://api.test/demo/9321483');
    expect(f.mock.calls[0][1].headers['x-api-key']).toBeUndefined();
    expect(r.found).toBe(true);
    expect(r.vessel.in_class).toBe(true);
  });
  it('requires exactly 7 digits', async () => {
    const f = vi.fn();
    await expect(lookupVesselDemo(cfg(f), '123')).rejects.toThrow(/exactly 7 digits/);
    expect(f).not.toHaveBeenCalled();
  });
  it('returns found:false on 404', async () => {
    const f = vi.fn().mockResolvedValue(json(404, { error: 'Vessel not found' }));
    const r = await lookupVesselDemo(cfg(f), '1234567');
    expect(r).toMatchObject({ found: false, imo: '1234567' });
  });
  it('mentions the hourly limit on 429', async () => {
    const f = vi.fn().mockResolvedValue(json(429, { error: 'rate' }));
    await expect(lookupVesselDemo(cfg(f), '1234567')).rejects.toThrow(/10 requests per hour/);
  });
});

describe('checkUsage', () => {
  it('computes remaining', async () => {
    const f = vi.fn().mockResolvedValue(json(200, { month: '2026-10', used: 30, limit: 100, plan: 'free' }));
    expect(await checkUsage(cfg(f))).toEqual({ plan: 'free', month: '2026-10', used: 30, limit: 100, remaining: 70 });
    expect(f.mock.calls[0][0]).toBe('https://api.test/usage');
  });
  it('needs a key', async () => {
    await expect(checkUsage(cfg(vi.fn(), null))).rejects.toThrow(/No API key/);
  });
});
