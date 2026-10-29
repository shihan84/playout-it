import { db } from '../db';
import { config } from '../config';
import { flussonicRequest, serverInBackoff } from './flussonic';
import { syncServerStreams, syncServerVods } from './sync';
import { sendTelegramNotification, dispatchStreamAlerts } from './telegram';
import { recordStreamEvent } from './lifecycle';
import { broadcastStreamsUpdate } from '../websocket';
import { mapLimit } from '../utils/concurrency';

let isChecking = false;
let isSyncing = false;
let watchdogTimer: NodeJS.Timeout;
let autoSyncTimer: NodeJS.Timeout;

// A server is due for a sync cycle when at least its effective interval has
// elapsed since last_synced_at. Effective interval = per-server
// sync_interval_secs override, else the global interval. A server that has
// never synced is always due. The 1s slack absorbs whole-second timestamp
// rounding plus tick drift when tick == interval.
export function serverDueForSync(server: any, globalSecs: number, nowMs: number): boolean {
  if (!server.last_synced_at) return true;
  const eff = server.sync_interval_secs || globalSecs;
  const elapsed = nowMs - new Date(`${server.last_synced_at}Z`).getTime();
  return elapsed >= eff * 1000 - 1000;
}

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

    // Check servers with bounded concurrency so one hung/slow server cannot
    // stall the whole watchdog cycle.
    await mapLimit(Object.keys(streamsByServer), 4, async (serverId) => {
      const server = serverMap[Number(serverId)];
      if (!server) return;

      // Circuit breaker: skip servers in failure backoff
      if (serverInBackoff(server)) return;

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
            // input_alive is not in the OpenAPI spec; per-input state lives
            // under stats.inputs[].active. Keep input_alive for servers that
            // do emit it, fall back to the documented field.
            newInputStatus = (stats?.input_alive === true || stats?.inputs?.some((i: any) => i?.active === true)) ? 'online' : 'offline';
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

          // Health timeline (Phase 2 P4): persist real status transitions so
          // the per-channel event history shows watchdog observations, not
          // just admin lifecycle transitions. 'unknown' baselines are skipped
          // to avoid a one-event-per-stream flood on first pass.
          if (stream.status !== newStatus && stream.status !== 'unknown') {
            recordStreamEvent(stream.id, stream.status, newStatus, null,
              `watchdog: status ${stream.status} → ${newStatus} (input: ${stream.input_status} → ${newInputStatus}, source: ${stream.source_type} → ${newSourceType})`);
          }

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

                await dispatchStreamAlerts(stream.id, 'stream_offline', message);
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
            if (stream.status !== 'unknown' && stream.status !== 'offline') {
              recordStreamEvent(stream.id, stream.status, 'offline', null, `watchdog: server '${server.name}' unreachable — marked offline`);
            }
            hasUpdates = true;
          }
        }
      }
    });

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
    // Tick at the shortest configured interval so per-server overrides shorter
    // than the global interval actually take effect (restart required if a
    // shorter override is added later).
    const minOverride = (db.prepare('SELECT MIN(sync_interval_secs) m FROM servers WHERE sync_interval_secs IS NOT NULL').get() as any)?.m;
    const tickSecs = Math.max(10, Math.min(syncIntervalSecs, minOverride ?? syncIntervalSecs));

    autoSyncTimer = setInterval(async () => {
      if (isSyncing) {
        console.warn('Auto-sync skipped — previous sync cycle still running');
        return;
      }
      isSyncing = true;
      try {
        console.log('Running auto-sync for all servers...');
        const servers = db.prepare('SELECT * FROM servers').all() as any[];
        let totalAdded = 0;
        let totalRemoved = 0;

        // Bounded parallelism + per-server circuit breaker
        await mapLimit(servers, 4, async (server) => {
          if (serverInBackoff(server)) {
            console.log(`Auto-sync skipping ${server.name} (in failure backoff)`);
            return;
          }
          // Per-server interval: the elapsed check applies to EVERY server —
          // the tick can fire faster than the global interval whenever any
          // server's override is shorter, so servers without an override must
          // still wait for the global interval to elapse.
          if (!serverDueForSync(server, syncIntervalSecs, Date.now())) return;
          try {
            const { addedCount, removedCount } = await syncServerStreams(server);
            const vodSync = await syncServerVods(server);
            totalAdded += addedCount + vodSync.addedCount;
            totalRemoved += removedCount + vodSync.removedCount;
            db.prepare('UPDATE servers SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(server.id);
          } catch (err: any) {
            console.error(`Auto-sync failed for server ${server.name}:`, err.message);
          }
        });

        if (totalAdded > 0 || totalRemoved > 0) {
          console.log(`Auto-sync complete: ${totalAdded} added, ${totalRemoved} removed.`);
          broadcastStreamsUpdate();
        }
      } finally {
        isSyncing = false;
      }
    }, syncIntervalSecs * 1000);
    console.log(`Auto-sync started with interval ${syncIntervalSecs}s`);
  } else {
    console.log('Auto-sync is disabled');
  }
};

export const stopWatchdog = () => {
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (autoSyncTimer) clearInterval(autoSyncTimer);
};
