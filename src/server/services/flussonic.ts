import axios from 'axios';

function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
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
  extraHeaders: any = {}
) {
  const headers = {
    'Authorization': getServerAuthHeader(server),
    ...extraHeaders
  };
  try {
    return await axios({
      method,
      url,
      data,
      headers,
      timeout: timeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  } catch (e: any) {
    // Legacy fallback: for api_key-only servers, retry with admin:<key>
    const key = server.api_key || '';
    const hasExplicitCreds = !!(server.username && server.password !== undefined);
    if (e.response && (e.response.status === 401 || e.response.status === 403) && !hasExplicitCreds && !key.includes(':')) {
      const retryHeaders = {
        'Authorization': basicAuth('admin', key),
        ...extraHeaders
      };
      return await axios({
        method,
        url,
        data,
        headers: retryHeaders,
        timeout: timeout,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
    }
    throw e;
  }
}
