Pipeline complete and verified; no unresolved requirements.

**Results (fixture: /tmp/neutrino-fast-live-PgKqxR/strong_sequential_dependencies/fast_dag/2)**
- seed.txt = 3
- stage1.txt = 5  (3 + 2)
- stage2.txt = 25 (5², computed from the re-read stage1.txt)
- stage3.txt = 21 (25 − 4, computed from the re-read stage2.txt)
- answer.json = `{"stage1": 5, "stage2": 25, "stage3": 21}` — numeric values, exactly the three required keys, identical to the saved stage files.

**Sequential-dependency requirement:** each stage was run as its own node command with an `fs.existsSync` + numeric-parse guard on its input file (exiting non-zero otherwise), and each downstream value was taken from the saved file, not from memory. No stage was computed before its input file existed.

**Verification**
- main task: re-read all stage files, asserted stage1==seed+2, stage2==stage1², stage3==stage2−4 — 3/3 PASS; answer.json written only after those checks passed; read-back confirmed keys/numbers — "ALL READ-BACK CHECKS PASSED".
- main.verify (independent): re-read from disk and re-ran the full chain — 8/8 PASS, "INDEPENDENT VERIFICATION PASSED", exit=0.
- Global review integration check just now: re-read seed.txt, stage1.txt, stage2.txt, stage3.txt and answer.json from disk and re-ran a fresh node derivation — all 7 checks PASS, "INTEGRATION REVIEW PASSED", exit=0. Directory contains only the five expected files.

**Constraints:** node v18.19.1 used for every computation and test (no Python); only the temporary fixture was touched; no credentials or external services accessed.
