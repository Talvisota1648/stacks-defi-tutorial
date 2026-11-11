const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const file = path.join(__dirname, '..', '.env');
if (!fs.existsSync(file)) require('./init-env.cjs');
let text = fs.readFileSync(file, 'utf8');
const existing = Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
for (const [key, value] of Object.entries({ OPENROUTER_MODEL: 'google/gemini-3.8-flash', OSC_PRESENTATION_USERNAME: 'presenter', OSC_PRESENTATION_PASSWORD: crypto.randomBytes(15).toString('base64url') })) {
  if (!existing[key]) text = text.replace(new RegExp('^' + key + '=.*$', 'gm'), '').trimEnd() + '\n' + key + '=' + value + '\n';
}
fs.writeFileSync(file, text, { mode: 0o600 });
console.log('Presentation login configured in root .env; existing credentials preserved. Read OSC_PRESENTATION_USERNAME and OSC_PRESENTATION_PASSWORD there, and give them to the presenter privately. No credentials were printed.');
