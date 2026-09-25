# CHECKPOINT — NAR-INS-001

Recorded before any Inspection product code changes.

| Item | Value |
|------|-------|
| Date | 2026-09-25 |
| Commit SHA | `f508172966c621612c5a9642c154d4e560d672de` |
| Branch at freeze | `sync/server-production` |
| Audit working branch | `feature/inspection-audit` |
| Backup branch | `backup/before-inspection-feature` |
| Backup tag | `baseline-before-inspection-feature` |
| Local archive | `backups/naryad-baseline-before-inspection-20260925-194916.tar.gz` |
| Target GitHub | https://github.com/HoneyPigster/naryad |

## Restore

```bash
git checkout baseline-before-inspection-feature
# or
git checkout backup/before-inspection-feature
# or unpack archive (does not include .git / node_modules)
```

## Baseline verify (2026-09-25, local Docker Compose)

Environment: `docker compose up db app`, verify client on Docker network `BASE_URL=http://app:3000`.

| Check | Result |
|-------|--------|
| `node --check` on `src/*.js` + `scripts/verify-flow.js` | PASS |
| Core cabinet flow (register, unpaid object, offer, accept) | PASS |
| `scripts/verify-flow.js` strict (exit code) | **FAIL (2 asserts)** |

Known baseline mismatches (product vs verify script — **not fixed in NAR-INS-001**):

1. Landing HTML lacks substring `не списываются` (phrase exists on paywalls/register/master, not on `views/home.ejs`).
2. Assert «landing has no client» fails because home copy contains «клиентов» («Для клиентов частного мастера…»), matching `/клиент/i`.

Core Прораб/Мастер happy-path assertions beyond those two landing checks passed. Fixing landing copy vs verify expectations is a separate small task before or during NAR-INS-017/018, not part of audit-only commit.
