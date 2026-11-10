Global review complete — the strict file pipeline was executed and independently verified in /tmp/neutrino-fast-live-b4eG5i/strong_sequential_dependencies/fast_dag/2.

Delivered outputs (current on-disk state, re-confirmed):
- seed.txt = 3
- stage1.txt = 5 (seed + 2)
- stage2.txt = 25 (stage1²)
- stage3.txt = 21 (stage2 − 4)
- answer.json = {"stage1": 5, "stage2": 25, "stage3": 21}

Requirement coverage:
1. Order: stage1 → stage2 → stage3 were run as separate, non-overlapping commands, each downstream command opening with an `fs.existsSync("stage1.txt"/"stage2.txt")` guard that throws before any computation (records 68a0fe3d, ab860944). "Never calculate a downstream stage before its required file exists" is therefore evidenced, not merely asserted.
2. Verification: every stage was re-read from its saved file and checked against its own relationship (main: a82f15fe; independent: ab27a914, exit 0) — stage1 = seed+2, stage2 = stage1², stage3 = stage2−4, all integers.
3. answer.json provenance and shape: written only after that verification, from values read back out of stage1/2/3.txt; keys are exactly stage1, stage2, stage3, all JSON numbers (not strings), each equal to its saved stage file.
4. Constraints: all computation and tests used node; no Python, no network, no credential access, all paths inside the fixture. No helper scripts were created, so nothing needed tidying and no files were deleted.
5. Cross-task integration: my final check re-read the five files and re-evaluated all relations plus answer.json type/key/equality in one Node pass → INTEGRATION PASS (3 → 5 → 25 → 21). No conflict found between artifact:main@1 and the independent verification artifact:main.verify@1; no discrepancies, no repair needed, no new acceptance obligations invented.
