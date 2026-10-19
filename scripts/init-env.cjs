const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const target = path.join(__dirname, '..', '.env');
const values = Object.fromEntries(['ADMIN', 'REVIEWER', 'INGEST', 'INTEGRATION'].map(role => [`OSC_${role}_TOKEN`, crypto.randomBytes(32).toString('base64url')]));
Object.assign(values, { OSC_DB_PASSWORD: crypto.randomBytes(32).toString('base64url'), OSC_REVIEWER_NAME: 'Специалист', CAMERA_01_URL: '', OSC_MAX_QUEUE: '300', OSC_MIN_FREE_MB: '512', OSC_UNEVENTFUL_RETENTION_HOURS: '24' });
try {
  fs.writeFileSync(target, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created root .env. Tokens are stored there; do not commit or send them to chat.');
} catch (error) {
  if (error.code === 'EEXIST') { console.log('Existing .env preserved.'); process.exit(0); }
  throw error;
}
