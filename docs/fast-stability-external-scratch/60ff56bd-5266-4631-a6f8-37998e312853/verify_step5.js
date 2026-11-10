'use strict';
const fs = require('fs');
const path = require('path');

const DIR = '/tmp/neutrino-fast-live-PgKqxR/parallel_analysis/standard/0';
const REGIONS = ['north', 'south', 'east', 'west'];

// Values + verbatim raw evidence exactly as reported by the four independent inspectors.
const INSPECTOR = {
  north: {
    count: 10, units: 90, weighted: 167,
    evidence: '[{"id":1,"units":4,"weight":1},{"id":2,"units":7,"weight":2},{"id":3,"units":10,"weight":3},{"id":4,"units":13,"weight":1},{"id":5,"units":16,"weight":2},{"id":6,"units":2,"weight":3},{"id":7,"units":5,"weight":1},{"id":8,"units":8,"weight":2},{"id":9,"units":11,"weight":3},{"id":10,"units":14,"weight":1}]'
  },
  south: {
    count: 10, units: 94, weighted: 171,
    evidence: '[{"id":1,"units":5,"weight":1},{"id":2,"units":9,"weight":2},{"id":3,"units":13,"weight":3},{"id":4,"units":17,"weight":1},{"id":5,"units":4,"weight":2},{"id":6,"units":8,"weight":3},{"id":7,"units":12,"weight":1},{"id":8,"units":16,"weight":2},{"id":9,"units":3,"weight":3},{"id":10,"units":7,"weight":1}]'
  },
  east: {
    count: 10, units: 98, weighted: 209,
    evidence: '[{"id":1,"units":6,"weight":1},{"id":2,"units":11,"weight":2},{"id":3,"units":16,"weight":3},{"id":4,"units":4,"weight":1},{"id":5,"units":9,"weight":2},{"id":6,"units":14,"weight":3},{"id":7,"units":2,"weight":1},{"id":8,"units":7,"weight":2},{"id":9,"units":12,"weight":3},{"id":10,"units":17,"weight":1}]'
  },
  west: {
    count: 10, units: 85, weighted: 145,
    evidence: '[{"id":1,"units":7,"weight":1},{"id":2,"units":13,"weight":2},{"id":3,"units":2,"weight":3},{"id":4,"units":8,"weight":1},{"id":5,"units":14,"weight":2},{"id":6,"units":3,"weight":3},{"id":7,"units":9,"weight":1},{"id":8,"units":15,"weight":2},{"id":9,"units":4,"weight":3},{"id":10,"units":10,"weight":1}]'
  }
};

const failures = [];
const results = {};

for (const region of REGIONS) {
  const file = path.join(DIR, region + '.json');
  if (!fs.existsSync(file)) { failures.push(`${region}: missing source ${file}`); continue; }
  const raw = fs.readFileSync(file, 'utf8');

  // --- evidence check: file bytes must equal what the inspector quoted ---
  const actualCanon = JSON.stringify(JSON.parse(raw));
  const inspCanon = JSON.stringify(JSON.parse(INSPECTOR[region].evidence));
  if (actualCanon !== inspCanon) failures.push(`${region}: evidence mismatch (file content != inspector-quoted content)`);

  const records = JSON.parse(raw);
  if (!Array.isArray(records)) { failures.push(`${region}: source is not an array`); continue; }

  // --- independent recomputation ---
  let count = 0, units = 0, weighted = 0;
  const ids = new Set();
  records.forEach((rec, i) => {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) { failures.push(`${region}[${i}]: not an object`); return; }
    const keys = Object.keys(rec).sort().join(',');
    if (keys !== 'id,units,weight') failures.push(`${region}[${i}]: unexpected keys "${keys}"`);
    if (!Number.isInteger(rec.units) || !Number.isInteger(rec.weight) || !Number.isInteger(rec.id)) {
      failures.push(`${region}[${i}]: non-integer field`); return;
    }
    if (ids.has(rec.id)) failures.push(`${region}[${i}]: duplicate id ${rec.id}`);
    ids.add(rec.id);
    count += 1;
    units += rec.units;
    weighted += rec.units * rec.weight;
  });

  // --- compare against inspector report ---
  const claim = INSPECTOR[region];
  for (const k of ['count', 'units', 'weighted']) {
    if (claim[k] !== { count, units, weighted }[k]) {
      failures.push(`${region}: ${k} mismatch — inspector=${claim[k]} node=${{ count, units, weighted }[k]}`);
    }
  }

  results[region] = { count, units, weighted };
  console.log(`${region}: count=${count} units=${units} weighted=${weighted} | inspector ${claim.count}/${claim.units}/${claim.weighted} -> ${claim.count === count && claim.units === units && claim.weighted === weighted ? 'MATCH' : 'MISMATCH'} | evidence ${actualCanon === inspCanon ? 'MATCH' : 'MISMATCH'}`);
}

const grand_units = REGIONS.reduce((s, r) => s + (results[r] ? results[r].units : 0), 0);
const grand_weighted = REGIONS.reduce((s, r) => s + (results[r] ? results[r].weighted : 0), 0);
const grand_count = REGIONS.reduce((s, r) => s + (results[r] ? results[r].count : 0), 0);

console.log('---');
console.log(JSON.stringify({ regions: results, grand_units, grand_weighted, grand_count }, null, 2));
console.log('---');
if (failures.length) {
  console.error('VERIFICATION FAILED (' + failures.length + '):');
  failures.forEach(f => console.error(' - ' + f));
  process.exit(1);
}
console.log('VERIFICATION PASSED: all 4 sources present, all records counted, every inspector value and evidence string matches Node recomputation.');
