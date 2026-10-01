// HTTP + domain logic for the Vessel Class Finder API. No MCP wiring here.

export const DEFAULT_API_URL = 'https://vessel-class-finder-production.up.railway.app';
export const SIGNUP_URL = 'https://vesselclassfinder.com/#signup';

export const SOCIETIES = {
  NKK: 'ClassNK',
  BV: 'Bureau Veritas',
  ABS: 'ABS (American Bureau of Shipping)',
  NV: 'DNV',
  LRS: "Lloyd's Register",
  RINA: 'RINA',
  CCS: 'China Classification Society',
  KR: 'Korean Register',
  IRS: 'Indian Register of Shipping',
  PRS: 'Polish Register of Shipping',
  CRS: 'Croatian Register of Shipping',
  TLV: 'Türk Loydu',
};

const IN_CLASS_STATUSES = new Set(['delivered', 'reinstated', 'reassigned']);
const DISCLAIMER = 'Data is refreshed weekly from IACS and is not a substitute for class certificates.';

export class ToolError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
  }
}

/** Returns the canonical IMO string (digits only) or throws ToolError. */
export function normalizeImo(value) {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !/^\d{1,7}$/.test(s.trim())) {
    throw new ToolError(
      `Invalid IMO "${String(value)}": an IMO number must be 1-7 digits (ships normally have a 7-digit IMO such as 9321483).`
    );
  }
  return s.trim();
}

export function normalizeImos(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ToolError('Provide at least one IMO number.');
  }
  if (values.length > 100) {
    throw new ToolError(`Too many IMOs (${values.length}). The maximum is 100 per call; split the list into batches.`);
  }
  return [...new Set(values.map(normalizeImo))];
}

export function societyName(code) {
  return SOCIETIES[code] ?? code ?? null;
}

export function isInClass(status) {
  return IN_CLASS_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

export function enrichVessel(v) {
  return { ...v, society: societyName(v.class), in_class: isInClass(v.status) };
}

export function getConfig(env = process.env) {
  return {
    apiKey: (env.VESSEL_CLASS_FINDER_API_KEY || '').trim() || undefined,
    baseUrl: (env.VESSEL_CLASS_FINDER_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
  };
}

export function mapHttpError(status, data, auth = true) {
  const apiMsg = data && typeof data.error === 'string' ? data.error : undefined;
  switch (status) {
    case 400:
      return new ToolError(`The API rejected the request (400): ${apiMsg ?? 'invalid input'}.`, 400);
    case 403:
      return new ToolError(
        `The API key was rejected (403${apiMsg ? `: ${apiMsg}` : ''}). Check that VESSEL_CLASS_FINDER_API_KEY is correct and has not been revoked. Get a free key at ${SIGNUP_URL}.`,
        403
      );
    case 404:
      return new ToolError(apiMsg ?? 'Not found.', 404);
    case 429: {
      if (!auth) {
        return new ToolError(
          `Demo rate limit reached (10 requests per hour per IP). Wait before retrying, or set VESSEL_CLASS_FINDER_API_KEY and use lookup_vessels (free key: ${SIGNUP_URL}).`,
          429
        );
      }
      const parts = [];
      if (data?.plan !== undefined) parts.push(`plan: ${data.plan}`);
      if (data?.usage !== undefined && data?.limit !== undefined) parts.push(`used ${data.usage} of ${data.limit} lookups`);
      const detail = parts.length ? ` (${parts.join(', ')})` : '';
      const upgrade = data?.upgrade_url ? ` Upgrade here: ${data.upgrade_url}` : '';
      return new ToolError(`Monthly lookup limit reached${detail}.${upgrade}`, 429);
    }
    default:
      return new ToolError(`Vessel Class Finder API error (${status})${apiMsg ? `: ${apiMsg}` : ''}.`, status);
  }
}

async function request(config, path, { method = 'GET', body, auth = true } = {}) {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const headers = { Accept: 'application/json' };
  if (auth) headers['x-api-key'] = config.apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetchFn(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ToolError(`Could not reach the Vessel Class Finder API: ${err?.message ?? err}`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }

  if (res.ok) return data;
  throw mapHttpError(res.status, data, auth);
}

export function missingKeyError() {
  return new ToolError(
    `No API key configured. Set the VESSEL_CLASS_FINDER_API_KEY environment variable in your MCP server config. ` +
      `A free key (100 lookups/month) is available at ${SIGNUP_URL}. ` +
      `To check a single ship without a key, use the lookup_vessel_demo tool (limited to 10 requests/hour).`
  );
}

/** Batch lookup (needs API key). */
export async function lookupVessels(config, imos) {
  const unique = normalizeImos(imos);
  if (!config.apiKey) throw missingKeyError();
  const data = await request(config, '/vessels', { method: 'POST', body: { imos: unique } });
  const vessels = (Array.isArray(data) ? data : []).map(enrichVessel);
  const found = new Set(vessels.map((v) => String(v.imo)));
  const not_found = unique.filter((imo) => !found.has(imo));
  return {
    requested: unique.length,
    found: vessels.length,
    vessels,
    not_found,
    ...(not_found.length
      ? {
          note:
            'IMOs in not_found are absent from IACS data: the vessel is not classed by an IACS member society (or has no IACS record), or the IMO is wrong. Double-check the number before concluding anything.',
        }
      : {}),
    disclaimer: DISCLAIMER,
  };
}

/** Single-vessel demo lookup (no key). */
export async function lookupVesselDemo(config, imo) {
  const normalized = normalizeImo(imo);
  if (!/^\d{7}$/.test(normalized)) {
    throw new ToolError(`Invalid IMO "${normalized}": the demo endpoint requires exactly 7 digits.`);
  }
  try {
    const data = await request(config, `/demo/${normalized}`, { auth: false });
    const vessel = Array.isArray(data) ? data[0] : data;
    return { found: true, vessel: enrichVessel(vessel), disclaimer: DISCLAIMER };
  } catch (err) {
    if (err instanceof ToolError && err.status === 404) {
      return {
        found: false,
        imo: normalized,
        note: 'Not found in IACS data: the vessel is not IACS-classed, or the IMO is wrong.',
      };
    }
    throw err;
  }
}

/** Usage for the configured key. */
export async function checkUsage(config) {
  if (!config.apiKey) throw missingKeyError();
  const data = await request(config, '/usage');
  const used = Number(data?.used ?? 0);
  const limit = data?.limit ?? null;
  return {
    plan: data?.plan,
    month: data?.month,
    used,
    limit,
    remaining: typeof limit === 'number' ? Math.max(limit - used, 0) : null,
  };
}
