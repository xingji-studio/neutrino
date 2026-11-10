Step 6 complete.

I wrote `answer.json` in the fixture root, taking the region values from `verified.json` after first re-deriving them from the four source files in the same Node run, which refused to write unless every region matched the verified record and `grand_units`/`grand_weighted` equalled the sum of the region values. Only `answer.json` was created in this step; the four source files and `verified.json` were read but not modified.

Evidence — the Node run printed `sources re-checked against verified.json: all region values match` followed by the object, and reading the file back from disk shows exactly that content:

```json
{"regions":{"north":{"count":10,"units":90,"weighted":167},
"south":{"count":10,"units":94,"weighted":171},
"east":{"count":10,"units":98,"weighted":209},
"west":{"count":10,"units":85,"weighted":145}},
"grand_units":367,"grand_weighted":692}
```

Cross-check: 90+94+98+85 = 367 and 167+171+209+145 = 692, consistent with the file. The independent end-to-end re-verification of `answer.json` against the sources — schema, per-region values, grand totals, source completeness — is step 7 and has not been run yet.
