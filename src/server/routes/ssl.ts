import { Router } from 'express';
import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import { db } from '../db';
import { updateNginxConfig } from '../utils/sslNginx';
import { isValidDomain, isValidEmail } from '../utils/sslValidation';
import { authenticateToken, requireAdmin } from '../middleware/auth';

// execFile passes arguments directly to the program (no shell), so user input
// can never be interpreted as shell syntax.
const execFilePromise = util.promisify(execFile);
const router = Router();

router.get('/status', authenticateToken, requireAdmin, (req, res) => {
  try {
    const sslEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_enabled');
    const sslDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_domain');

    let status = 'not_configured';
    let expiry = null;

    if (sslEnabled?.value === 'true' && isValidDomain(sslDomain?.value)) {
      // Check if certificate exists
      const certPath = `/etc/letsencrypt/live/${sslDomain.value}/fullchain.pem`;
      if (fs.existsSync(certPath)) {
        const cert = fs.readFileSync(certPath, 'utf8');
        const certMatch = cert.match(/Not After\s*:\s*(.+)/);
        if (certMatch) {
          expiry = certMatch[1].trim();
          const expiryDate = new Date(expiry);
          const now = new Date();
          const daysUntilExpiry = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

          if (daysUntilExpiry < 0) {
            status = 'expired';
          } else if (daysUntilExpiry < 30) {
            status = 'expiring_soon';
          } else {
            status = 'active';
          }
        }
      } else {
        status = 'certificate_missing';
      }
    }

    res.json({
      enabled: sslEnabled?.value === 'true',
      domain: sslDomain?.value || '',
      expiry,
      status
    });
  } catch (error: any) {
    console.error('Failed to get SSL status:', error);
    res.status(500).json({ error: 'Failed to get SSL status' });
  }
});

router.post('/install', authenticateToken, requireAdmin, async (req, res) => {
  const { domain, email } = req.body;

  if (!domain || !email) {
    return res.status(400).json({ error: 'Domain and email are required' });
  }

  if (!isValidDomain(domain)) {
    return res.status(400).json({ error: 'Invalid domain format' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    await execFilePromise('which', ['certbot']);
  } catch {
    return res.status(400).json({ error: 'certbot is not installed on this server. Install certbot and python3-certbot-nginx, then retry.' });
  }

  try {
    // Save SSL settings to database
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_enabled', 'true');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_domain', domain);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_email', email);

    await execFilePromise('sudo', ['certbot', 'certonly', '--nginx', '-d', domain, '--non-interactive', '--agree-tos', '--email', email]);

    // Update nginx configuration
    await updateNginxConfig(domain);

    // Restart nginx
    await execFilePromise('sudo', ['systemctl', 'restart', 'nginx']);

    res.json({ success: true, message: 'SSL certificate installed successfully' });
  } catch (error: any) {
    console.error('Failed to install SSL certificate:', error);
    res.status(500).json({ error: 'Failed to install SSL certificate. Check the server logs for details.' });
  }
});

router.post('/renew', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const sslDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_domain');

    if (!sslDomain?.value) {
      return res.status(400).json({ error: 'No SSL domain configured' });
    }

    await execFilePromise('sudo', ['certbot', 'renew', '--non-interactive']);
    await execFilePromise('sudo', ['systemctl', 'restart', 'nginx']);

    res.json({ success: true, message: 'SSL certificate renewed successfully' });
  } catch (error: any) {
    console.error('Failed to renew SSL certificate:', error);
    res.status(500).json({ error: 'Failed to renew SSL certificate. Check the server logs for details.' });
  }
});

export default router;
