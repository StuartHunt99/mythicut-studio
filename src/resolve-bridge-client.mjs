const DEFAULT_URL = 'http://127.0.0.1:8787';

export class ResolveBridgeClient {
  constructor({ baseUrl = DEFAULT_URL, fetchImpl = globalThis.fetch, timeoutMs = 600_000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Resolve bridge client requires fetch');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? `Resolve bridge returned HTTP ${response.status}`);
    return body;
  }

  health() { return this.request('/health', { method: 'GET' }); }
  actions() { return this.request('/actions', { method: 'GET' }); }
  call(action, params = {}) {
    return this.request('/action', { method: 'POST', body: JSON.stringify({ action, params }) });
  }
}

export function requireBridgeSuccess(action, result) {
  if (!result || result.status !== 'ok') throw new Error(`${action} failed: ${result?.message ?? JSON.stringify(result)}`);
  return result;
}
