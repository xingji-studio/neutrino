Verification complete — both requirements hold.

**What I did (step 6 only):** re-ran the suite and re-read `answer.json` in `/tmp/neutrino-fast-live-LY3jZs/multi_module_code/standard/2`, then parsed the JSON in Node to check keys, values and types.

**Files changed:** none — this step was read-and-run only, as intended.

**Evidence:** `node test.mjs` printed `PASS` with `EXIT_CODE=0`, so all four strict assertions (`tax(100)===20`, `shipping(2)===7`, `tax(0)===0`, `shipping(0)===3`) passed. `cat answer.json` shows exactly `{"tax100":20,"shipping2":7}`, and parsing it reported `keys = tax100,shipping2`, `values = 20 7`, `types = number number`, `exact = true`, `VERIFY_EXIT=0`. The `cat` output also confirms the independence constraint: `tax.mjs` contains only `export function tax(amount) { return amount * 0.2; }` and `shipping.mjs` only `export function shipping(weight) { return 3 + 2 * weight; }`, with no `import` statements in either file. Final fixture contents: `package.json`, `test.mjs`, `tax.mjs`, `shipping.mjs`, `answer.json` — all inside the allowed directory.
