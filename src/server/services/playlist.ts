import { db } from '../db';
import { flussonicRequest, resolveCompanionVodName } from './flussonic';

const PLAYLIST_FILENAME = 'playlist.txt';

// Flussonic resolves each playlist line through the VOD prefix: `<vod>/<file>` plays, a bare
// file name does not (verified on a live server). Strips any prefix already stored in the DB.
export function playlistEntries(vodName: string, filenames: string[], stripPrefixes: string[] = []): string {
  return filenames.map(f => {
    let name = f;
    for (const p of [vodName, ...stripPrefixes]) {
      if (name.startsWith(`${p}/`)) { name = name.slice(p.length + 1); break; }
    }
    return `${vodName}/${name}`;
  }).join('\n');
}

// A playlist input must point at playlist.txt on disk (`playlist:///storage/<vod>/playlist.txt`);
// `playlist:///<vod>/playlist.txt` fails with source_timeout. Null when the storage isn't a local path.
export async function playlistInputUrl(server: any, vodName: string): Promise<string | null> {
  const res = await flussonicRequest('GET', `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`, server);
  const storage = res.data?.storages?.[0]?.url;
  if (typeof storage !== 'string' || !storage.startsWith('/')) return null;
  return `playlist://${storage.replace(/\/+$/, '')}/${PLAYLIST_FILENAME}`;
}

async function writePlaylist(server: any, vodName: string, content: string) {
  const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}/storages/0/files/${PLAYLIST_FILENAME}`;
  await flussonicRequest('PUT', uploadUrl, server, content, 30000, { 'Content-Type': 'text/plain' });
  console.log(`Playlist uploaded to Flussonic VOD: ${vodName}/${PLAYLIST_FILENAME}`);
}

export async function updatePlaylistFile(stream: any) {
  const videos = db.prepare('SELECT filename FROM videos WHERE stream_id = ? ORDER BY sort_order ASC, created_at ASC').all(stream.id) as any[];
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
  if (!server) return;

  // Resolves `_vod` first, then the legacy same-name VOD for upgraded installs
  const vodName = await resolveCompanionVodName(server, stream.name);
  try {
    await writePlaylist(server, vodName, playlistEntries(vodName, videos.map(v => v.filename as string), [stream.name]));
  } catch (e: any) {
    console.warn('Failed to upload playlist.txt to Flussonic VOD:', e.message);
    return;
  }

  // Keep the existing inputs and (re)place the playlist:// input as the last fallback
  try {
    const playlistInput = await playlistInputUrl(server, vodName);
    if (!playlistInput) {
      console.warn(`VOD ${vodName} has no local storage path; stream inputs left unchanged`);
      return;
    }
    const flussonicStreamUrl = `${server.url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
    const streamResponse = await flussonicRequest('GET', flussonicStreamUrl, server);
    const fData = streamResponse.data;
    const existingInputs: any[] = fData.config_on_disk?.inputs || fData.inputs || [];
    const primaryInputs = existingInputs.filter((inp: any) => !inp.url?.startsWith('playlist://'));
    const newInputs: any[] = [...primaryInputs, { url: playlistInput }];

    await flussonicRequest('PUT', flussonicStreamUrl, server, {
      name: stream.name,
      inputs: newInputs,
      ...(fData.config_on_disk?.pushes ? { pushes: fData.config_on_disk.pushes } : {})
    });

    const inputUrls = newInputs.map((i: any) => i.url);
    db.prepare('UPDATE streams SET inputs = ? WHERE id = ?').run(JSON.stringify(inputUrls), stream.id);
    console.log(`Stream inputs updated on Flussonic: ${stream.name} -> ${JSON.stringify(inputUrls)}`);
  } catch (e: any) {
    console.warn('Failed to update stream inputs on Flussonic:', e.message);
  }
}

export async function updateVodPlaylistFile(vod: any) {
  const files = db.prepare("SELECT filename FROM vod_files WHERE vod_id = ? AND filename NOT LIKE '%playlist.txt' ORDER BY created_at ASC").all(vod.id) as any[];
  if (files.length === 0) return; // Don't create empty playlist

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (server) await writePlaylist(server, vod.name, playlistEntries(vod.name, files.map(f => f.filename as string)));
  } catch (e: any) {
    console.warn('Failed to upload playlist to Flussonic VOD:', e.message);
  }
}
