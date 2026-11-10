Step 1 complete — four parallel restricted inspectors returned reports. No files were created or modified (the fixture still contains only the four source JSON files).

| file | inspector count | units sum | weighted sum |
|---|---|---|---|
| north.json | 10 | 90 | 167 |
| south.json | 10 | 94 | 171 |
| east.json | 10 | 98 | 209 |
| west.json | 10 | 85 | 145 |

Each inspector ran under `read_only: true` (only `read_file`/`list_files`), reported that it never opened the other three datasets, and supplied a complete per-record evidence table (id / units / weight / units×weight) plus its running arithmetic and cross-checks — e.g. north: units 4,7,10,13,16,2,5,8,11,14 with weights 1,2,3,1,2,3,1,2,3,1; west: units 7,13,2,8,14,3,9,15,4,10. All four reported 10 records, contiguous ids 1–10, no missing or non-numeric `units`/`weight`. These are inspector claims only: nothing is verified yet, and no `answer.json` has been written. Verification against an independent Node recomputation is step 3, so I am stopping here.
