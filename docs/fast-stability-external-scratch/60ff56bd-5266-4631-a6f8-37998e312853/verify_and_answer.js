const fs = require('fs');

function readNum(p) {
  if (!fs.existsSync(p)) throw new Error('MISSING required file: ' + p);
  const raw = fs.readFileSync(p, 'utf8').trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) throw new Error(p + ' is not numeric: ' + JSON.stringify(raw));
  return n;
}

const seed = readNum('seed.txt');
const stage1 = readNum('stage1.txt');
const stage2 = readNum('stage2.txt');
const stage3 = readNum('stage3.txt');

const checks = [
  { name: 'stage1 == seed + 2', got: stage1, expected: seed + 2 },
  { name: 'stage2 == stage1^2', got: stage2, expected: stage1 * stage1 },
  { name: 'stage3 == stage2 - 4', got: stage3, expected: stage2 - 4 },
];
let ok = true;
for (const c of checks) {
  const pass = c.got === c.expected;
  if (!pass) ok = false;
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + c.name + ' (got ' + c.got + ', expected ' + c.expected + ')');
}
if (!ok) { console.error('verification failed; answer.json not written'); process.exit(1); }

const answer = { stage1, stage2, stage3 };
fs.writeFileSync('answer.json', JSON.stringify(answer, null, 2) + '\n');
console.log('wrote answer.json: ' + JSON.stringify(answer));
