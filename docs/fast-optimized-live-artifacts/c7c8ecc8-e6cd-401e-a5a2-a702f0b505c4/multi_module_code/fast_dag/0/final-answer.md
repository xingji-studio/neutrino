All requirements are implemented and verified in /tmp/neutrino-fast-live-dgKhaU/multi_module_code/fast_dag/0.

Files:
- tax.mjs: `export function tax(amount) { return amount * 0.2; }`
- shipping.mjs: `export function shipping(weight) { return 3 + 2 * weight; }`
- answer.json: {"tax100":20,"shipping2":7}

Verification (Node v18.19.1, run from the fixture root):
- `node test.mjs` → stdout `PASS`, EXIT=0; the original 242-byte test.mjs (all four assertions: tax(100)==20, shipping(2)==7, tax(0)==0, shipping(0)==3) was unmodified.
- `node --input-type=module -e "...readFileSync('answer.json')... expect {tax100:tax(100),shipping2:shipping(2)}..."` → `match true`, both values typeof number, keys exactly shipping2,tax100.
- Dependency scan of both modules found no import/require statements; each module imported standalone and computed correctly (tax only: 20, shipping only: 7), so they are independent.
- Only tax.mjs, shipping.mjs and answer.json were written; no Python, credentials or external services were used.
