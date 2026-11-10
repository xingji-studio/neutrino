Implemented and independently verified in the fixture `/tmp/neutrino-fast-live-nvRjq6/multi_module_code/fast_dag/0`:

- `tax.mjs`: `export function tax(amount) { return amount * 0.2; }`
- `shipping.mjs`: `export function shipping(weight) { return 3 + 2 * weight; }`
- `answer.json`: `{"tax100": 20, "shipping2": 7}`

Verification (re-run during review):
- `node test.mjs` printed `PASS`, exit 0 (asserts tax(100)=20, shipping(2)=7, tax(0)=0, shipping(0)=3).
- `grep` found no `import`/`require` in either module, so the two modules are independent.
- A `node` check imported both modules and confirmed `answer.json` keys are exactly `tax100,shipping2`, both values are `number`, and strictly equal `tax(100)` / `shipping(2)`.

Only `node` was used; no Python, credentials or external services. All task requirements met, no unresolved issues.
