# Drift → rebuild → fast again

Generated 2026-10-26 by `packages/agent/scripts/drift-demo.ts`, on the mock site, with recorded model responses replayed at their recorded latency. Nobody visits the page: the scheduled keeper notices the change.

| Step | Result |
| --- | --- |
| Agent on layout A, maps current | usher agent: completed · 3 pages in 2.79s (knock 0.02s, model 0.00s, fill 0.59s) · maps from registry 3/3 · 0/0 tokens · $0.0000 · http |
| Layout switched to B; keeper (every 6 s) rebuilt /quote/driver | 16.2 s after the switch (check took 13.2 s, rebuilt: All 13 questions are retained with only reordering and synonymous rewording (Last name/Surname, Occupation/Main occupation, First line of address/House number and street) and the Continue button renamed to Next. Rebuilt: recompiled with muse-spark-1.3.) |
| First agent after the change | usher agent: completed · 3 pages in 10.12s (knock 0.02s, model 7.36s, fill 0.56s) · maps from registry 1/3 · 8394/1846 tokens · $0.0183 · http |
| Next agent | usher agent: completed · 3 pages in 2.69s (knock 0.01s, model 0.00s, fill 0.53s) · maps from registry 3/3 · 0/0 tokens · $0.0000 · http |

The keeper only checks forms it can reach without submitting anything, so on the mock site it rebuilds step 1; steps 2 and 3 sit behind earlier answers. The first agent after the change re-reads those two with the model and shares the maps, so every agent after that is fast on all three.
