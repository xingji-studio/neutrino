Implemented and verified the whole request inside the fixture /tmp/neutrino-fast-live-LY3jZs/multi_module_code/fast_dag/0.

- `tax.mjs`: `export function tax(amount) { return amount * 0.2; }`
- `shipping.mjs`: `export function shipping(weight) { return 3 + 2 * weight; }` — the two modules contain no imports/requires, so they are independent.
- `answer.json`: `{"tax100":20,"shipping2":7}`, both numeric and produced by calling the implemented functions (not hardcoded by hand).
- `package.json` (`{"type":"module"}`) and the pre-existing `test.mjs` were left unchanged (242 bytes, same bytes as originally listed).

Verification (Node only, no Python, no network/credentials):
- `node test.mjs` → `PASS`, exit 0 (re-run at review time with the same result).
- Fresh Node recomputation from the modules: exports are exactly `tax` and `shipping`; `tax(100)=20`, `shipping(2)=7`; answer.json keys exactly `tax100,shipping2`, both `typeof number`, strictly equal to the function results → `VERIFY OK`.
- Formula spot-checks beyond the provided cases: tax(0)=0, tax(1)=0.2, tax(-5)=-1, tax(50)=10; shipping(0)=3, shipping(1)=5, shipping(10)=23 → all OK.

No cross-task conflicts, no unresolved issues, no requirement left out.
