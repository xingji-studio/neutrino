// Fixed benchmark inputs and external acceptance shared by the harness and independent auditor.
export function fastLiveCases() {
const cases = [
  { name: "multi_source_retrieval", files: { "a.txt": "Alpha population: 12\n", "b.txt": "Beta population: 18\n", "c.txt": "Gamma population: 30\n" },
    prompt: "Read all three original sources a.txt, b.txt and c.txt. Cross-check each population and calculate their sum. Write answer.json with the numeric key total. Cite the three source paths in your final answer.", expected: { total: 60 } },
  { name: "multi_dimension_comparison", files: { "products.json": JSON.stringify([{ name: "A", cost: 10, latency: 7 }, { name: "B", cost: 13, latency: 4 }, { name: "C", cost: 9, latency: 8 }]) },
    prompt: "Compare every product in products.json by cost, latency, and score=cost+2*latency. Independently verify each score. Write answer.json containing scores (an object keyed by product name) and winner (the lowest-score product name).", expected: { scores: { A: 24, B: 21, C: 25 }, winner: "B" } },
  { name: "complex_logic", files: { "constraints.txt": "Integers a,b,c are positive, a<b<c, a+b+c=12, a*b=8. Find the unique solution.\n" },
    prompt: "Read constraints.txt. Derive the unique solution and verify uniqueness by enumerating all positive integer triples satisfying every constraint. Write answer.json with numeric keys a, b, c and solutions (the count of valid triples).", expected: { a: 2, b: 4, c: 6, solutions: 1 } },
  { name: "multi_module_code", files: { "package.json": "{\"type\":\"module\"}", "test.mjs": "import assert from 'node:assert/strict'; import {tax} from './tax.mjs'; import {shipping} from './shipping.mjs'; assert.equal(tax(100),20); assert.equal(shipping(2),7); assert.equal(tax(0),0); assert.equal(shipping(0),3); console.log('PASS');" },
    prompt: "Implement tax.mjs exporting tax(amount)=amount*0.2 and shipping.mjs exporting shipping(weight)=3+2*weight. Run node test.mjs and ensure all tests pass. Write answer.json with numeric keys tax100 and shipping2 from the implemented functions. Keep the two modules independent.", expected: { tax100: 20, shipping2: 7 }, command: "test.mjs", outputs: ["tax.mjs", "shipping.mjs", "answer.json"] },
  { name: "multi_agent_collaboration", files: { "east.txt": "East: 3, 5, 7\n", "west.txt": "West: 2, 4, 6\n" },
    prompt: "Use at least two independent sub-agents or scheduled Agent workers to inspect east.txt and west.txt separately. Verify the reports against both original files, integrate them, and write answer.json containing east and west (their sums) and combined (the overall sum).", expected: { east: 15, west: 12, combined: 27 } },
  { name: "long_tool_sequence", files: { "input.json": "[1,2,3,4,5]" },
    prompt: "Read input.json, write doubled.json containing the doubled values, read that saved file and write evens.json with values greater than 5, then read evens.json and write answer.json with values (that saved array) and sum. Verify every saved intermediate file and the final sum.", expected: { values: [6, 8, 10], sum: 24 } },
  { name: "iterative_correction", files: { "package.json": "{\"type\":\"module\"}", "math.mjs": "export const sum = xs => xs.reduce((a,b)=>a-b,0); export const mean = xs => sum(xs)/(xs.length+1);", "test.mjs": "import assert from 'node:assert/strict'; import {sum,mean} from './math.mjs'; assert.equal(sum([2,4,6]),12); assert.equal(mean([2,4,6]),4); assert.equal(sum([]),0); console.log('PASS');" },
    prompt: "Run node test.mjs to observe the real initial failure. Diagnose and fix all math.mjs bugs without modifying tests. Rerun the tests until every assertion passes. Write answer.json with sum and mean for [2,4,6] from the implemented functions.", expected: { sum: 12, mean: 4 }, command: "test.mjs" },
  { name: "strong_sequential_dependencies", files: { "seed.txt": "3" },
    prompt: "Execute this strict file pipeline in order: read seed.txt, add 2 and write stage1.txt; read stage1.txt, square its value and write stage2.txt; read stage2.txt, subtract 4 and write stage3.txt; read and verify every stage, then write answer.json containing the numeric keys stage1, stage2 and stage3 from the saved files. Never calculate a downstream stage before its required file exists.", expected: { stage1: 5, stage2: 25, stage3: 21 }, outputs: ["stage1.txt", "stage2.txt", "stage3.txt", "answer.json"] },
];
const regions = ["north", "south", "east", "west"];
const parallelData = Object.fromEntries(regions.map((region, index) => [region,
  Array.from({ length: 10 }, (_, row) => ({ id: row + 1, units: ((index + 3) * (row + 1)) % 17 + 1, weight: row % 3 + 1 }))]));
const expectedRegions = Object.fromEntries(regions.map(region => [region, { count: parallelData[region].length,
  units: parallelData[region].reduce((sum, row) => sum + row.units, 0),
  weighted: parallelData[region].reduce((sum, row) => sum + row.units * row.weight, 0) }]));
cases.push({ name: "parallel_analysis", minimumInspectors: 4,
  files: Object.fromEntries(regions.map(region => [`${region}.json`, JSON.stringify(parallelData[region])])),
  prompt: "Use at least four independent read-only Agent inspectors, one for each of north.json, south.json, east.json and west.json. Each inspector must read only its own source using read_file/list_files (no shell or edits), report its count, sum of units, and sum of units*weight with original evidence. Inspectors may reason about these values; the coordinator must independently recompute ALL four original datasets with Node and verify the inspectors' results before integration. Write answer.json with regions (an object keyed by north/south/east/west; each entry has count, units, weighted), grand_units, and grand_weighted. Do not build a reusable framework or test unrelated inputs; verify all requested values and source completeness.",
  common: "Work only inside this fixture. Read-only inspectors must preserve their restricted scope; the coordinator must use Node for deterministic global verification and output. Preserve all original requirements. Do not access credentials or external services from tools.",
  expected: { regions: expectedRegions, grand_units: regions.reduce((sum, name) => sum + expectedRegions[name].units, 0),
    grand_weighted: regions.reduce((sum, name) => sum + expectedRegions[name].weighted, 0) } });
  return cases;
}
