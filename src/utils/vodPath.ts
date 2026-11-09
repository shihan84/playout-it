/**
 * Builds the Flussonic playback URL for a VOD file. Synced file names already
 * include the VOD prefix (`<vod>/<file>`) while uploaded ones may not, so the
 * prefix is added only when missing.
 */
export function vodFileUrl(serverUrl: string, vodName: string, filename: string, suffix: 'index.m3u8' | 'embed.html'): string {
  const prefix = `${vodName}/`;
  const relative = filename.startsWith(prefix) ? filename : prefix + filename;
  const path = relative.split('/').map(encodeURIComponent).join('/');
  return `${serverUrl.replace(/\/+$/, '')}/${path}/${suffix}`;
}
