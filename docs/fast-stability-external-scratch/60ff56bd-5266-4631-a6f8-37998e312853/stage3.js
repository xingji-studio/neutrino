const fs = require('fs');
const path = 'stage2.txt';
if (!fs.existsSync(path)) { console.error('MISSING stage2.txt'); process.exit(1); }
const raw = fs.readFileSync(path, 'utf8').trim();
const base = Number(raw);
if (!Number.isFinite(base)) { console.error('stage2.txt is not numeric: ' + JSON.stringify(raw)); process.exit(1); }
const value = base - 4;
fs.writeFileSync('stage3.txt', String(value));
console.log(JSON.stringify({ read: raw, base, op: 'stage2 - 4', value }));
