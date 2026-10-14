import { db } from '../db';
import { flussonicRequest, resolveCompanionVodName } from './flussonic';

export async function updatePlaylistFile(stream: any) {
  const videos = db.prepare('SELECT filename FROM videos WHERE stream_id = ? ORDER BY sort_order ASC, created_at ASC').all(stream.id) as any[];
  // VOD named `khabar70` has storage /storage/khabar70.
  // Playlist entries are BARE filenames (e.g. video.mp4), because Flussonic resolves them
  // as <vod_storage_root>/<entry> = /storage/khabar70/video.mp4.
  // Adding the vodname/ prefix would double-resolve: /storage/khabar70/khabar70/video.mp4 (wrong).
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
  if (!server) return;

  // Resolves `_vod` first, then the legacy same-name VOD for upgraded installs
  const vodName = await resolveCompanionVodName(server, stream.name);
  const playlistContent = videos.map(v => {
    const fname = v.filename as string;
    // Strip any accidental streamname/ prefix that may have been stored in DB
    if (fname.startsWith(`${stream.name}/`)) return fname.slice(stream.name.length + 1);
    return fname;
  }).join('\n');

  // 1. Upload playlist.txt to Flussonic VOD storage (standard Flussonic filename)
  const playlistFilename = 'playlist.txt';
  try {
    const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}/storages/0/files/${playlistFilename}`;
    await flussonicRequest('PUT', uploadUrl, server, playlistContent, 30000, { 'Content-Type': 'text/plain' });
    console.log(`Playlist uploaded to Flussonic VOD: ${vodName}/playlist.txt`);
  } catch (e: any) {
    console.warn('Failed to upload playlist.txt to Flussonic VOD:', e.message);
    return;
  }

  // 2. Update stream inputs to use playlist:// as fallback
  // playlist:///devin-test_vod/playlist.txt — triple slash = Flussonic resolves via VOD named devin-test_vod
  const playlistInputUrl = `playlist:///${vodName}/playlist.txt`;
  try {
    const flussonicStreamUrl = `${server.url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
    const streamResponse = await flussonicRequest('GET', flussonicStreamUrl, server);
    const fData = streamResponse.data;
    const existingInputs: any[] = fData.config_on_disk?.inputs || fData.inputs || [];

    // Keep the primary input, replace/add the playlist:// fallback
    let newInputs: any[];
    if (existingInputs.length === 0) {
      newInputs = [{ url: playlistInputUrl }];
    } else {
      // Keep all non-playlist:// inputs, then append playlist:// as last fallback
      const primaryInputs = existingInputs.filter((inp: any) => !inp.url?.startsWith('playlist://'));
      newInputs = [...primaryInputs, { url: playlistInputUrl }];
    }

    await flussonicRequest('PUT', flussonicStreamUrl, server, {
      name: stream.name,
      inputs: newInputs,
      ...(fData.config_on_disk?.pushes ? { pushes: fData.config_on_disk.pushes } : {})
    });

    // Persist the updated inputs in our DB
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

  const firstPart = vod.name.split('/')[0];
  const playlistContent = files.map(v => {
    if (v.filename.startsWith(`${firstPart}/`)) return v.filename;
    return `${firstPart}/${v.filename}`;
  }).join('\n');

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (server) {
      // Try to find the first storage that is not a read-only one if possible, but default to 0
      const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/playlist.txt`;
      await flussonicRequest('PUT', uploadUrl, server, playlistContent, 30000, { 'Content-Type': 'text/plain' });
      console.log(`Playlist uploaded to Flussonic VOD: ${vod.name}`);
    }
  } catch (e: any) {
    console.warn('Failed to upload playlist to Flussonic VOD:', e.message);
  }
}
