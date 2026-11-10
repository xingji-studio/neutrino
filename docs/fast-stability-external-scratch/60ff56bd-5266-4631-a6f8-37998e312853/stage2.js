const fs = require('fs');
const path = 'stage1.txt';
if (!fs.existsSync(path)) { console.error('MISSING stage1.txt'); process.exit(1); }
const raw = fs.readFileSync(path, 'utf8').trim();
const base = Number(raw);
if (!Number.isFinite(base)) { console.error('stage1.txt is not numeric: ' + JSON.stringify(raw)); process.exit(1); }
const value = base * base;
fs.writeFileSync('stage2.txt', String(value));
console.log(JSON.stringify({ read: raw, base, op: 'stage1 squared', value }));
