Step 4 complete and verified.

**Total: 60**

Sources (each read with node, one population figure per file, digit round-trip checked):
- `/tmp/neutrino-fast-live-Kjebr5/multi_source_retrieval/standard/1/a.txt` → Alpha population: 12
- `/tmp/neutrino-fast-live-Kjebr5/multi_source_retrieval/standard/1/b.txt` → Beta population: 18
- `/tmp/neutrino-fast-live-Kjebr5/multi_source_retrieval/standard/1/c.txt` → Gamma population: 30

12 + 18 + 30 = **60**, written to `/tmp/neutrino-fast-live-Kjebr5/multi_source_retrieval/standard/1/answer.json` as `{"total": 60}`.

**Verification evidence (node, exit code 0):** the verification script re-read all three sources, required exactly one finite numeric population per file, cross-checked with two summation paths (both 60), then parsed `answer.json` and asserted `typeof total === "number"`, integral, `total === 60`, and `total` is the only key — printed `ASSERT PASS: typeof total === "number" && total === 60 && keys = [total]`. An in-memory negative control confirms the assertion is not vacuous: it rejects `{"total":"60"}` ("not a number"), `{"total":360}` ("MISMATCH 360 != 60") and `{}`, while the valid case passes. Directory listing shows the fixture holds only `a.txt`, `b.txt`, `c.txt` and `answer.json`; the three source files are unmodified (byte sizes unchanged, no helper scripts left behind).

**Files changed:** only `answer.json` was created. The task requirements are met: all three original sources read, each population cross-checked, sum computed with node, numeric `total` written, and all three source paths cited above.
