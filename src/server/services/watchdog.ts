import axios from 'axios';
import { db } from '../db';
import { config } from '../config';
import { flussonicRequest } from './flussonic';
import { syncServerStreams, syncServerVods } from './sync';
import { sendTelegramNotification } from './telegram';
import { broadcastStreamsUpdate } from '../websocket';

let isChecking = false;
let watchdogTimer: NodeJS.Timeout;
let autoSyncTimer: NodeJS.Timeout;

const checkStreams = async () => {
  if (isChecking) return;
  isChecking = true;

  try {
    const streams = db.prepare('SELECT * FROM streams').all() as any[];
    const servers = db.prepare('SELECT * FROM servers').all() as any[];

    const serverMap = servers.reduce((acc, s) => { acc[s.id] = s; return acc; }, {});

    // Group streams by server
    const streamsByServer: Record<number, any[]> = {};
    for (const stream of streams) {
      if (!streamsByServer[stream.server_id]) streamsByServer[stream.server_id] = [];
      streamsByServer[stream.server_id].push(stream);
    }

    let hasUpdates = false;

    for (const serverId of Object.keys(streamsByServer)) {
      const server = serverMap[Number(serverId)];
      if (!server) continue;

      try {
        const flussonicUrl = `${server.url}/flussonic/api/v3/streams`;
        const response = await flussonicRequest('GET', flussonicUrl, server);
        const remoteStreams = Array.isArray(response.data) ? response.data : (response.data.streams || []);
        const remoteStreamMap = remoteStreams.reduce((acc: any, s: any) => { acc[s.name] = s; return acc; }, {});

        for (const stream of streamsByServer[Number(serverId)]) {
          const remoteStream = remoteStreamMap[stream.name];
          let newStatus = 'offline';
          let newInputStatus = 'offline';
          let newSourceType = 'unknown';
          let newUptime = 0;
          let newPushStatus = '[]';

          if (remoteStream) {
            const stats = remoteStream.stats;
            const isAlive = stats && stats.alive;
            newStatus = isAlive ? 'online' : 'offline';
            newInputStatus = stats?.input_alive ? 'online' : 'offline';
            newSourceType = stats?.source_type || 'unknown';
            newUptime = stats?.uptime || 0;

            if (remoteStream.pushes && remoteStream.pushes.length > 0) {
              newPushStatus = JSON.stringify(remoteStream.pushes.map((p: any) => ({
                url: p.url,
                status: p.stats?.status || 'unknown'
              })));
            }
          }

          // Notifications Consolidation
          const notifications: string[] = [];

          if (stream.status !== newStatus && stream.status !== 'unknown') {
            const emoji = newStatus === 'online' ? '✅' : '❌';
            notifications.push(`${emoji} <b>Status:</b> ${newStatus.toUpperCase()}`);

            // Send Telegram alert when stream goes offline
            if (newStatus === 'offline' && config.telegramBotToken) {
              try {
                const message = `🔴 <b>Stream Alert</b>\n\n` +
                  `<b>Stream:</b> ${stream.name}\n` +
                  `<b>Status:</b> OFFLINE\n` +
                  `<b>Time:</b> ${new Date().toLocaleString()}\n\n` +
                  `Your stream has stopped streaming. Please check your source.`;

                await axios.post(`http://localhost:${config.port}/api/telegram-alerts/send`, {
                  stream_id: stream.id,
                  alert_type: 'stream_offline',
                  message: message
                });
              } catch (error: any) {
                console.error('Failed to send Telegram alert:', error.message);
              }
            }
          }

          if (stream.input_status !== newInputStatus && stream.input_status !== 'unknown' && newStatus === 'online') {
            const emoji = newInputStatus === 'online' ? '📥' : '⚠️';
            const msg = newInputStatus === 'online' ? 'RESTORED' : 'DROPPED';
            notifications.push(`${emoji} <b>Input:</b> ${msg}`);
          }

          if (stream.source_type !== newSourceType && stream.source_type !== 'unknown' && newStatus === 'online') {
            const emoji = newSourceType === 'live' ? '📡' : (newSourceType === 'playlist' || newSourceType === 'static' ? '📁' : '❓');
            const typeLabel = newSourceType === 'live' ? 'LIVE' : (newSourceType === 'playlist' ? 'PLAYLIST' : (newSourceType === 'static' ? 'VOD' : newSourceType.toUpperCase()));
            notifications.push(`${emoji} <b>Source:</b> ${typeLabel}`);
          }

          if (newUptime < stream.uptime && newUptime > 0 && stream.uptime > 0 && newStatus === 'online' && (stream.status === newStatus)) {
            // Only notify restart if status didn't just change to online (to avoid double notification with status change)
            notifications.push(`🔄 <b>Stream Restarted</b> (Uptime: ${newUptime}s)`);
          }

          if (notifications.length > 0) {
            const header = `<b>Stream Update: ${stream.name}</b>\n<b>Server:</b> ${server.name}\n\n`;
            await sendTelegramNotification(header + notifications.join('\n'));
          }

          const result = db.prepare('UPDATE streams SET status = ?, input_status = ?, source_type = ?, uptime = ?, push_status = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run(
            newStatus,
            newInputStatus,
            newSourceType,
            newUptime,
            newPushStatus,
            stream.id
          );

          if (result.changes > 0 && (
            stream.status !== newStatus ||
            stream.input_status !== newInputStatus ||
            stream.source_type !== newSourceType ||
            stream.push_status !== newPushStatus
          )) {
            hasUpdates = true;
          }
        }
      } catch (error: any) {
        console.error(`Failed to check streams for server ${server.name}:`, error.message);
        const affectedStreams = streamsByServer[Number(serverId)].filter(s => s.status !== 'offline');

        if (affectedStreams.length > 0) {
          const streamNames = affectedStreams.map(s => s.name).join(', ');
          await sendTelegramNotification(`❌ <b>Server Unreachable</b>\n\n<b>Server:</b> ${server.name}\n<b>Error:</b> ${error.message}\n<b>Affected Streams:</b> ${streamNames}`);

          for (const stream of affectedStreams) {
            db.prepare('UPDATE streams SET status = ?, push_status = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run('offline', '[]', stream.id);
            hasUpdates = true;
          }
        }
      }
    }

    if (hasUpdates) {
      broadcastStreamsUpdate();
    }
  } finally {
    isChecking = false;
  }
};

export const startWatchdog = () => {
  if (watchdogTimer) clearInterval(watchdogTimer);
  const intervalSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('watchdog_interval') as any;
  const intervalSecs = parseInt(intervalSetting?.value || '60', 10);

  watchdogTimer = setInterval(checkStreams, intervalSecs * 1000);
  console.log(`Watchdog started with interval ${intervalSecs}s`);

  // Auto Sync
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  const autoSyncEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_sync_enabled') as any;

  if (autoSyncEnabled?.value === 'true') {
    const syncIntervalSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_sync_interval') as any;
    const syncIntervalSecs = parseInt(syncIntervalSetting?.value || '60', 10);

    autoSyncTimer = setInterval(async () => {
      console.log('Running auto-sync for all servers...');
      const servers = db.prepare('SELECT * FROM servers').all() as any[];
      let totalAdded = 0;
      let totalRemoved = 0;

      for (const server of servers) {
        try {
          const { addedCount, removedCount } = await syncServerStreams(server);
          const vodSync = await syncServerVods(server);
          totalAdded += addedCount + vodSync.addedCount;
          totalRemoved += removedCount + vodSync.removedCount;
        } catch (err: any) {
          console.error(`Auto-sync failed for server ${server.name}:`, err.message);
        }
      }

      if (totalAdded > 0 || totalRemoved > 0) {
        console.log(`Auto-sync complete: ${totalAdded} added, ${totalRemoved} removed.`);
        broadcastStreamsUpdate();
      }
    }, syncIntervalSecs * 1000);
    console.log(`Auto-sync started with interval ${syncIntervalSecs}s`);
  } else {
    console.log('Auto-sync is disabled');
  }
};
