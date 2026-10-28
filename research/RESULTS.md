# Recorded results

These runs precede the current cleanup. APFDf is higher-is-better; revealing rank
is lower-is-better. Skipping counts classes/files, not elapsed time.

| Project | Faults | Mean tests skipped by FASTER |
| --- | ---: | ---: |
| Commons CSV | 3 | 40.3% |
| Commons IO | 1 | 9.8% |
| Commons Text | 2 | 6.4% |
| Jackson Core | 5 | 24.5% |
| JavaPoet | 6 | 21.5% |
| Pinia | 13 | 76.0% |
| Zod | 5 | 79.8% |

Java: mean APFDf **0.9183**, first revealing rank **4.12**, and **23.2%** skipped.
Ekstazi plus random ordering scores 0.6268 with rank 21.03; the Vitest comparator
scores 0.6053 with rank 21.35. All 17 faults remain selected, but every fault has
an edited/unknown revealing test. This does not establish selection safety for
unchanged tests.

Pinia/Zod retain all 18 seeded faults. APFDf is 0.9480/0.9857 and rank is
1.38/1.80. Selected-run APFDf includes the benefit of omitting nonrevealing tests.
There are no new JavaScript comparator executions in this cleanup.

Known losses: JavaPoet `3829f2ca` has rank 7 versus FAST-pw mean 2.93; Commons Text
`d3051739` has rank 12 versus Ekstazi+random mean 7.17. Next: independent natural
histories with unchanged tests, then end-to-end execution cost.
