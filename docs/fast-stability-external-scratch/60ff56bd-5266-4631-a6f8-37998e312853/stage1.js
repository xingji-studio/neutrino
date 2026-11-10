const fs = require('fs');
const path = 'seed.txt';
if (!fs.existsSync(path)) { console.error('MISSING seed.txt'); process.exit(1); }
const raw = fs.readFileSync(path, 'utf8').trim();
const seed = Number(raw);
if (!Number.isFinite(seed)) { console.error('seed.txt is not numeric: ' + JSON.stringify(raw)); process.exit(1); }
const value = seed + 2;
fs.writeFileSync('stage1.txt', String(value));
console.log(JSON.stringify({ read: raw, seed, op: 'seed + 2', value }));
