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

/**
 * Flussonic input URL for a VOD's playlist.txt. Flussonic needs the file's disk path
 * (`playlist:///storage/<vod>/playlist.txt`), so the VOD's first local storage path is used.
 */
export function playlistInputUrl(vod: { name: string; paths?: string[] | null }): string {
  const storage = Array.isArray(vod.paths) ? vod.paths[0] : undefined;
  const dir = typeof storage === 'string' && storage.startsWith('/') ? storage.replace(/\/+$/, '') : `/storage/${vod.name}`;
  return `playlist://${dir}/playlist.txt`;
}
