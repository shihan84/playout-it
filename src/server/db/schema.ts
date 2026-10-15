export const schema = `
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    username TEXT,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    name TEXT NOT NULL,
    live_url TEXT NOT NULL,
    playlist_url TEXT NOT NULL,
    push_urls TEXT DEFAULT '[]',
    push_status TEXT DEFAULT '[]',
    status TEXT DEFAULT 'unknown',
    input_status TEXT DEFAULT 'unknown',
    source_type TEXT DEFAULT 'unknown',
    uptime INTEGER DEFAULT 0,
    last_checked DATETIME,
    lifecycle_state TEXT DEFAULT 'live',
    channel_group TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS stream_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    actor_id INTEGER,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_stream_events_stream ON stream_events(stream_id, created_at);

  CREATE TABLE IF NOT EXISTS vods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    name TEXT NOT NULL,
    paths TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS vod_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vod_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(vod_id) REFERENCES vods(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'client',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_stream_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stream_id INTEGER NOT NULL,
    expires_at DATETIME,
    max_sessions INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    UNIQUE(user_id, stream_id)
  );

  CREATE TABLE IF NOT EXISTS blocked_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT NOT NULL UNIQUE,
    reason TEXT,
    blocked_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(blocked_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stream_id INTEGER NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    alert_enabled INTEGER DEFAULT 1,
    downtime_threshold INTEGER DEFAULT 30,
    last_alert_sent DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    UNIQUE(user_id, stream_id)
  );

  CREATE TABLE IF NOT EXISTS channel_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    inputs TEXT NOT NULL DEFAULT '[]',
    push_urls TEXT NOT NULL DEFAULT '[]',
    vod_path TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS overlay_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    logo_path TEXT,
    logo_position TEXT DEFAULT 'tr',
    logo_x INTEGER DEFAULT 10,
    logo_y INTEGER DEFAULT 10,
    logo_width INTEGER DEFAULT 0,
    logo_opacity REAL DEFAULT 1.0,
    ticker_enabled INTEGER DEFAULT 0,
    ticker_text TEXT,
    ticker_speed INTEGER DEFAULT 100,
    ticker_position TEXT DEFAULT 'bottom',
    ticker_font_size INTEGER DEFAULT 28,
    ticker_color TEXT DEFAULT 'white',
    ticker_bg_color TEXT DEFAULT 'black@0.5',
    output_stream TEXT,
    output_url TEXT,
    enabled INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS overlay_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    stream_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    pid INTEGER,
    exit_code INTEGER,
    last_error TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    stopped_at DATETIME,
    FOREIGN KEY(profile_id) REFERENCES overlay_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_overlay_jobs_stream ON overlay_jobs(stream_id, status);

  CREATE TABLE IF NOT EXISTS telegram_alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_alert_id INTEGER NOT NULL,
    alert_type TEXT NOT NULL,
    message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    success INTEGER DEFAULT 1,
    error_message TEXT,
    FOREIGN KEY(telegram_alert_id) REFERENCES telegram_alerts(id) ON DELETE CASCADE
  );
`;
