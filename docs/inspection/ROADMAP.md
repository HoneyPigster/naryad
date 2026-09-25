# ROADMAP — «Приёмка» (NAR-INS)

Baseline freeze: commit `f508172`, branch `backup/before-inspection-feature`, tag `baseline-before-inspection-feature`, archive `backups/naryad-baseline-before-inspection-20260925-194916.tar.gz`.

Working remote for this effort: `https://github.com/HoneyPigster/naryad`.

## Status

| ID | Title | Priority | Status |
|----|-------|----------|--------|
| NAR-INS-001 | Repository audit + docs + checkpoint | P0 | **DONE (docs commit)** |
| NAR-INS-002 | Domain constants + billing product seed scaffolding | P0 | NEXT |
| NAR-INS-003 | Database DDL (inspection + checklist + defects + history + reports + billing) | P0 | TODO |
| NAR-INS-004 | Inspection list + create + paywall (990 unpaid) | P0 | TODO |
| NAR-INS-005 | Project fields (property/finish/address/…) | P0 | TODO |
| NAR-INS-006 | Rooms CRUD + order + unavailable | P0 | TODO |
| NAR-INS-007 | Checklist engine + seed v1 + version pin | P0 | TODO |
| NAR-INS-008 | Checklist UI + item results | P0 | TODO |
| NAR-INS-009 | Defect quick-create + templates + stable D-NNN | P0 | TODO |
| NAR-INS-010 | Defect photos (storage + gated GET) | P0 | TODO |
| NAR-INS-011 | Measurements | P0 | TODO |
| NAR-INS-012 | Progress + prepare + resume | P0 | TODO |
| NAR-INS-013 | Review completeness + complete | P0 | TODO |
| NAR-INS-014 | PDF report + versioning | P0 | TODO |
| NAR-INS-015 | History audit log | P0 | TODO |
| NAR-INS-016 | Security IDOR suite | P0 | TODO |
| NAR-INS-017 | Landing / nav integration (third product) | P0 | TODO |
| NAR-INS-018 | Regression verify-flow + inspection E2E | P0 | TODO |
| NAR-INS-019 | Sharing (token, expiry, revoke, redaction) | P1 | TODO |
| NAR-INS-020 | Follow-up / recheck | P1 | TODO |
| NAR-INS-021 | Normative references (verified only) | P1 | TODO |
| NAR-INS-022 | Documents + promised/actual specs | P1 | TODO |
| NAR-INS-023 | Plan markers + photo annotations | P1 | TODO |
| NAR-INS-024 | Offline queue UI | P1 | TODO |
| NAR-INS-025 | Export pack (PDF+photos) | P1 | TODO |
| NAR-INS-026 | Thumbnails / compression hardening | P1 | TODO |
| NAR-INS-027 | Live billing PSP hook | P2 | TODO |
| NAR-INS-028 | AI / voice abstractions only when requested | P2 | TODO |
| NAR-INS-029 | Production hardening + deploy with backups | P0 late | TODO |

## Process

One task → implement → test → fix → regression → commit → next.  
No mega-commit «implement everything».

## Note on prior branch

`feature/inspection-product` contains an earlier P0 attempt against a pre-prod-sync tree. Treat as **reference only**. Re-apply against current baseline using this roadmap; do not assume old code is in production.
