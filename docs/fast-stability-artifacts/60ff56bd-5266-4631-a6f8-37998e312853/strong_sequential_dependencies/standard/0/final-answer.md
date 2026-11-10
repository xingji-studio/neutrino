Step 4 done. A node script read the three saved stage files, verified `stage2 === stage1²` and `stage3 === stage2 − 4`, and wrote `answer.json` from those values, exiting non-zero on a mismatch or on a missing/non-numeric file.

- Files changed: `answer.json` created (`{"stage1": 5, "stage2": 25, "stage3": 21}`); the stage files were only read, not rewritten.
- Evidence: verification run printed `read stage1=5 stage2=25 stage3=21` and `verified: stage2=stage1^2 and stage3=stage2-4`; a read-back printed `keys: stage1,stage2,stage3`, `types: number,number,number`, `match files: true`.

Pipeline complete: `seed.txt="3"` → `stage1.txt="5"` → `stage2.txt="25"` → `stage3.txt="21"`, and `answer.json` matches. Nothing remains open.
