# TEST-PLAN — «Приёмка»

## 1. Baseline (existing Naryad)

| Command | Purpose |
|---------|---------|
| `npm run verify` | E2E-ish HTTP flow for landing, auth, foreman object, master accept |

**Environment:** Postgres 16 + app listening (`docker compose up` or local `npm start`).

**Note:** No lint/typecheck scripts exist on baseline — N/A until introduced.

Recorded in `CHECKPOINT.md` (2026-09-25): core flow PASS; strict `npm run verify` fails 2 landing asserts (missing «не списываются» on home; word «клиентов» trips `/клиент/i`). Do not fake PASS.

## 2. Unit (to add with implementation)

| Module | Cases |
|--------|-------|
| `progress.js` | counts, room fractions, exclude NOT_APPLICABLE policy |
| defect numbering | monotonic; delete does not reuse in a confusing way (seq never decreases) |
| status transitions | illegal transitions rejected |
| entitlement | unpaid confirm grants; missing entitlement blocks start/PDF per product rule |
| report metadata | version increments |

Runner: add minimal `node --test` (Node 22) or `node test/*.js` without new heavy framework if possible.

## 3. Integration

Flow:

`login → create project (unpaid) → rooms → prepare → start → set results → create defect → photo → measurement → review → complete → PDF → history`

Assert DB rows + HTTP 303/200 + ownership.

## 4. Security

Automated script (extend verify style):

- User A creates project; User B cannot GET/POST any nested id.
- Photo URL of A returns 404 for B.
- CSRF missing → 403 on POST.

## 5. E2E inspection script

`scripts/verify-inspection-flow.js` mirroring `verify-flow.js` conventions (cookie jar, csrfOf, assert).

## 6. Regression

After each inspection task:

1. `npm run verify` (existing)
2. Spot-check landing still two+ tiles without breaking foreman/master
3. Foreman photo upload still works
4. Master accepting still works

## 7. Mobile / responsive

Manual checklist: iPhone width, Android width, desktop — create defect with camera input, long checklist scroll, PDF download.

## 8. Performance smoke

Project with ≥50 photos: list uses thumbs or lazy links; report generation completes without OOM (limit images in PDF if needed).

## 9. Definition of test Done for P0

- Unit progress + numbering green
- verify-flow green
- verify-inspection-flow green
- IDOR matrix green
- Docs match behavior
