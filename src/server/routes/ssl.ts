import { Router } from 'express';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import { db } from '../db';
import { updateNginxConfig } from '../utils/sslNginx';
import { authenticateToken, requireAdmin } from '../middleware/auth';

const execPromise = util.promisify(exec);
const router = Router();

router.get('/status', authenticateToken, requireAdmin, (req, res) => {
  try {
    const sslEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_enabled');
    const sslDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_domain');

    let status = 'not_configured';
    let expiry = null;

    if (sslEnabled?.value === 'true' && sslDomain?.value) {
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

  try {
    // Validate domain format
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    if (!domainRegex.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    // Save SSL settings to database
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_enabled', 'true');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_domain', domain);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_email', email);

    // Use certbot to obtain certificate
    // First, ensure certbot is installed
    try {
      await execPromise('which certbot');
    } catch {
      await execPromise('sudo apt install -y certbot python3-certbot-nginx');
    }

    // Obtain certificate using certbot
    const certbotCommand = `sudo certbot certonly --nginx -d ${domain} --non-interactive --agree-tos --email ${email}`;
    await execPromise(certbotCommand);

    // Update nginx configuration
    await updateNginxConfig(domain);

    // Restart nginx
    await execPromise('sudo systemctl restart nginx');

    res.json({ success: true, message: 'SSL certificate installed successfully' });
  } catch (error: any) {
    console.error('Failed to install SSL certificate:', error);
    res.status(500).json({ error: error.message || 'Failed to install SSL certificate' });
  }
});

router.post('/renew', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const sslDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_domain');

    if (!sslDomain?.value) {
      return res.status(400).json({ error: 'No SSL domain configured' });
    }

    // Renew certificate
    await execPromise('sudo certbot renew --non-interactive');

    // Restart nginx
    await execPromise('sudo systemctl restart nginx');

    res.json({ success: true, message: 'SSL certificate renewed successfully' });
  } catch (error: any) {
    console.error('Failed to renew SSL certificate:', error);
    res.status(500).json({ error: error.message || 'Failed to renew SSL certificate' });
  }
});

export default router;
