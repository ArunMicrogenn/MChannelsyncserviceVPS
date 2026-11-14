import crypto from 'node:crypto';

export const CONTRACT_VERSION = '1.3.0';

export interface MChannelResponse<T = any> {
  status: number;
  data: T | null;
  error: string | null;
  requestId: string;
}

export async function mchannelRequest<T = any>(params: {
  baseUrl: string;
  apiKey?: string | null;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, any> | null;
}): Promise<MChannelResponse<T>> {
  const requestId = crypto.randomUUID();
  const payload = params.body ? { contract_version: CONTRACT_VERSION, ...params.body } : null;
  const cleanBase = params.baseUrl.replace(/\/+$/, '');

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-Id': requestId,
  };
  if (params.apiKey) {
    headers['X-MChannel-Key'] = params.apiKey;
  }
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(`${cleanBase}${params.path}`, {
      method: params.method,
      headers,
      body: payload !== null ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(30000),
    });

    const raw = await res.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = { raw: raw.slice(0, 500) };
    }

    return { status: res.status, data: parsed, error: null, requestId };
  } catch (err: any) {
    return { status: 0, data: null, error: err?.message || 'Network failure', requestId };
  }
}
