# SECURITY — «Приёмка»

Extends existing Naryad controls (session, CSRF, CSP, ownership SQL). Baseline patterns live in `src/mw.js`, `src/server.js`, `src/routes.js` (`loadOwnedObject`, photo jail).

## 1. Authentication

- All `/inspection/*` mutating and private reads require `res.locals.user`.
- Reuse session cookie; no parallel login.
- Share views (P1) are token-authenticated, not session-owner impersonation.

## 2. Authorization / IDOR

Every handler that takes an id must verify ownership (or valid share), e.g.:

```sql
SELECT … FROM inspection_projects p
WHERE p.id = $1 AND p.owner_user_id = $2
```

Cascade checks for rooms, defects, photos, reports, documents:

- Resolve parent project → compare `owner_user_id` to session.
- Never trust client-supplied `owner_user_id`.
- Photo/document download: same owner check + `path.basename` + resolve under storage root (copy foreman `showPhoto` jail).

IDs are sequential integers today — **not** secrets. Authorization is mandatory on every resource.

## 3. CSRF

- Keep global `checkCsrf`.
- Multipart upload endpoints must call `csrfOk` after multer (foreman pattern).
- Share revoke / complete / delete: CSRF required.

## 4. Files

| Check | Rule |
|-------|------|
| Size | ≤ 5 MB P0 (align with foreman) or documented higher limit |
| Type | Magic-byte sniff JPEG/PNG/WebP (documents P1: PDF allowlist separately) |
| Name | Random hex; never user filename on disk |
| Path | No `..`; resolve under `PHOTO_DIR/inspection` |
| Access | No public static mount of PHOTO_DIR; only gated handlers |
| EXIF | Do not require geolocation; strip if easy later (P1) |

## 5. Sharing (P1)

- Token: `crypto.randomBytes(32).toString('base64url')` (or hex)
- Store only hash optional hardening; if store raw, DB must not be world-readable
- `expires_at`, `revoked_at`
- Default share: minimized personal data (address optional flag)
- Rate-limit token guessing via length + logging

## 6. Multi-tenancy

P0: single owner. `organization_id` nullable reserved. Never return other users’ rows in list queries.

## 7. Injection / XSS

- Parameterized SQL only (`pg` placeholders).
- EJS escapes `<%= %>`; use `<%-` only for trusted partials.
- CSP remains restrictive; avoid inline scripts.

## 8. Billing honesty

- Do not set «paid» without payment event.
- Unpaid confirm must not be labeled as successful charge (existing product rule).

## 9. Security test matrix (mandatory before Done)

| Resource | Cross-user GET | Cross-user POST | Cross-user file |
|----------|----------------|-----------------|-----------------|
| project | 404/403 | 404/403 | — |
| room | 404/403 | 404/403 | — |
| defect | 404/403 | 404/403 | — |
| photo | 404 | — | 404 body |
| report PDF | 404 | — | 404 |
| document (P1) | 404 | — | 404 |
| share (P1) | expired/revoked denied | revoke CSRF | — |

## 10. Normative / legal content

Do not ship unverified ГОСТ/СП claims. Severity ≠ legal qualification. UI copy must not invent obligations.
