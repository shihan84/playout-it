import axios from 'axios';
import { db } from '../db';

function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// Per-server health tracking
export function recordServerSuccess(serverId: number, latencyMs: number) {
  try {
    db.prepare(`UPDATE servers SET last_seen_at = CURRENT_TIMESTAMP, last_attempt_at = CURRENT_TIMESTAMP,
      last_error = NULL, consecutive_failures = 0, latency_ms = ? WHERE id = ?`).run(latencyMs, serverId);
  } catch { /* health columns may not exist on very old DBs */ }
}

export function recordServerFailure(serverId: number, message: string) {
  try {
    db.prepare(`UPDATE servers SET last_attempt_at = CURRENT_TIMESTAMP, last_error = ?,
      consecutive_failures = COALESCE(consecutive_failures, 0) + 1 WHERE id = ?`)
      .run(String(message).slice(0, 500), serverId);
  } catch { /* ignore */ }
}

// Circuit breaker: after repeated failures, skip the server for an
// exponentially increasing window (30s → cap 5min) so dead servers don't
// stall every watchdog/sync cycle.
export function serverInBackoff(server: any): boolean {
  const failures = server.consecutive_failures || 0;
  if (failures < 3 || !server.last_attempt_at) return false;
  const backoffMs = Math.min(5 * 60 * 1000, 30000 * Math.pow(2, failures - 3));
  const last = new Date(`${server.last_attempt_at}Z`).getTime();
  return Date.now() - last < backoffMs;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Classify an axios/network failure into an operator-actionable diagnostic —
// raw err.message alone ("Request failed with status code 500") doesn't say
// WHICH layer broke. Stored to servers.last_error and surfaced in alerts.
export function describeNetError(err: any): string {
  const status = err?.response?.status;
  if (status) {
    const label =
      status === 401 || status === 403 ? 'authentication rejected' :
      status === 404 ? 'endpoint not found (check Flussonic version/API path)' :
      status === 429 ? 'rate limited by remote' :
      status >= 500 ? 'remote server error' : `HTTP ${status}`;
    return `${label} (HTTP ${status})`;
  }
  const code = err?.code || '';
  if (code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) return `request timed out (${err?.timeout || 'configured'}ms)`;
  if (code === 'ECONNREFUSED') return `connection refused — Flussonic not listening at ${err?.address || 'host'}${err?.port ? ':' + err.port : ''}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `DNS resolution failed (${code}) — check server hostname`;
  if (code === 'ECONNRESET') return 'connection reset by remote (TLS mismatch or restart mid-request)';
  if (code.startsWith('UNABLE_TO_') || code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return `TLS certificate error (${code})`;
  if (code === 'ERR_BAD_RESPONSE' || err?.message?.includes('socket hang up')) return 'connection dropped mid-response';
  return err?.message || 'unknown network error';
}

// Resolve the auth header for a server. Prefers explicit username/password,
// falls back to legacy api_key formats (user:pass, or flussonic/admin password).
export function getServerAuthHeader(server: any): string {
  if (server.username && server.password !== undefined) {
    return basicAuth(server.username, server.password);
  }
  const key = server.api_key || '';
  return key.includes(':')
    ? `Basic ${Buffer.from(key).toString('base64')}`
    : basicAuth('flussonic', key);
}

// Resolve which remote VOD backs a stream's companion storage. New installs
// create `<stream>_vod`; older installs used `<stream>` itself (shared
// Flussonic namespace). Probe `_vod` first, fall back to the legacy name so
// existing videos/playlists keep working after upgrade. Defaults to `_vod`
// when neither exists (i.e. the VOD still needs to be created).
export async function resolveCompanionVodName(server: any, streamName: string): Promise<string> {
  const baseUrl = server.url.replace(/\/$/, '');
  for (const candidate of [`${streamName}_vod`, streamName]) {
    try {
      await flussonicRequest('GET', `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(candidate)}`, server);
      return candidate;
    } catch {
      // not found (or unreachable) — try next candidate
    }
  }
  return `${streamName}_vod`;
}

export async function flussonicRequest(
  method: string,
  url: string,
  server: any,
  data: any = null,
  timeout = 30000,
  extraHeaders: any = {},
  retries = 1
) {
  const headers = {
    'Authorization': getServerAuthHeader(server),
    ...extraHeaders
  };
  const doRequest = (hdrs: any) => axios({
    method,
    url,
    data,
    headers: hdrs,
    timeout: timeout,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    // Never follow redirects — a 3xx could silently forward the Basic auth
    // header to an arbitrary host. Fail loudly so the operator fixes the URL.
    maxRedirects: 0,
    validateStatus: (s: number) => s < 300
  });

  const key = server.api_key || '';
  const hasExplicitCreds = !!(server.username && server.password !== undefined);
  const canLegacyRetry = !hasExplicitCreds && !key.includes(':');

  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await doRequest(headers);
      if (server.id) recordServerSuccess(server.id, Date.now() - started);
      return res;
    } catch (e: any) {
      lastError = e;
      // Legacy fallback: for api_key-only servers, retry with admin:<key>
      if (e.response && (e.response.status === 401 || e.response.status === 403) && canLegacyRetry) {
        try {
          const res = await doRequest({
            'Authorization': basicAuth('admin', key),
            ...extraHeaders
          });
          if (server.id) recordServerSuccess(server.id, Date.now() - started);
          return res;
        } catch (e2: any) {
          lastError = e2;
        }
      }
      // Never retry client errors; retry network errors and 5xx once
      if (e.response && e.response.status < 500) {
        if (server.id) recordServerFailure(server.id, describeNetError(lastError));
        throw lastError;
      }
      if (attempt < retries) await sleep(300 * (attempt + 1));
    }
  }
  // Record one failure per request — counting each retry attempt would
  // double-count consecutive_failures and trip the circuit breaker early.
  if (server.id) recordServerFailure(server.id, describeNetError(lastError));
  throw lastError;
}
