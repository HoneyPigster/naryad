# NAR-INS-001 — Architectural audit (existing Naryad)

**Audit date:** 2026-09-25  
**Repository under work:** https://github.com/HoneyPigster/naryad  
**Local workspace:** `/Users/olegmartynov/Projects/naryad`  
**Baseline commit:** `f508172966c621612c5a9642c154d4e560d672de`  
**Baseline message:** `Sync repository with production server /opt/naryad`  
**Working branch for this audit:** `feature/inspection-audit`  
**Backup branch:** `backup/before-inspection-feature`  
**Backup tag:** `baseline-before-inspection-feature`  
**Local archive:** `backups/naryad-baseline-before-inspection-20260925-194916.tar.gz` (~588K, excludes `node_modules`/`.git`/`backups`)

**Historical audit of the pre-Приёмка baseline** (`f508172`). On current `main`, «Приёмка» is implemented (role `inspector`, routes `/inspection`, schema, PDF). Keep this file as the NAR-INS-001 snapshot; do not treat it as the live product description.

---

## 1. Product shape today

Naryad is a single Express monolith with three *historical* cabinets and two *active* acquisition surfaces:

| Surface | Status on baseline |
|---------|--------------------|
| Landing `/` | Two tiles: **Прораб**, **Мастер** (drawings + prices 690 / 490). No client CTA. |
| Registration | Only `foreman` and `master`. POST with `role=client` is rejected. |
| `/client` | Still routed; renders `views/client/closed.ejs` («Кабинет клиента закрыт»). Full client list/create handlers remain in code but unused by default entry. |
| `/foreman` | Active. Empty foreman → unpaid object paywall; else redirect to latest object. Also tasks for masters. |
| `/master` | Active. Subscription / accepting orders / offers / bookings / guarantees / dues. |

Money is **not** charged. Paywalls require explicit unpaid confirmation and show «Деньги не списываются».

---

## 2. Stack and runtime

| Layer | Fact |
|-------|------|
| Runtime | Node.js `>=22.14.0` (Docker image `node:22.14.0-bookworm-slim`) |
| HTTP | Express 4 + EJS views |
| Session | `express-session` + `connect-pg-simple` → table `session` |
| DB | PostgreSQL 16 (`pg` Pool); schema applied at boot via `src/schema.sql` |
| Uploads | `multer` memory storage → magic-byte sniff → write under `PHOTO_DIR` |
| Proxy | Caddy 2 in front (`Caddyfile`: `masterprorab.ru`, IP `109.172.37.155`) |
| Compose | `db` + `app` + `caddy`; volumes `pgdata`, `photos`, `caddy_*` |
| Package scripts | `npm start` → `node src/server.js`; `npm run verify` → `scripts/verify-flow.js` |
| Lint / typecheck | **Absent** (plain JS, no TypeScript, no ESLint in `package.json`) |
| Unit test runner | **Absent** (only integration-style HTTP verify script) |
| CI | `.github/workflows/` exists but is **empty** |

Dependencies (prod): `express`, `ejs`, `pg`, `express-session`, `connect-pg-simple`, `bcryptjs`, `multer`.

---

## 3. Backend layout

```
src/
  server.js     # createApp, security headers, session, migrate, listen
  routes.js     # ~1617 lines: all HTTP handlers + mount()
  mw.js         # loadUser, requireRole, CSRF, flash, login rate limit, password
  db.js         # Pool, migrate() reads schema.sql, withTx()
  schema.sql    # idempotent CREATE TABLE IF NOT EXISTS
  text.js       # labels, PRICES, parsers, HOME map
  components/   # empty placeholder
  lib/          # empty placeholder
  pages/        # empty placeholder
```

**Routing:** single `mount(app)` in `src/routes.js`. No routers per domain yet. Prefer adding `src/inspection/` modules and mounting from `mount()` without rewriting cabinets.

**Migrations:** there is **no** versioned migration runner. Boot runs entire `schema.sql`. New tables must be additive `CREATE TABLE IF NOT EXISTS` (and safe `ALTER` only with care). Do not delete or rewrite existing DDL.

---

## 4. Authentication and sessions

1. Login/register by phone + password (`bcryptjs`, cost 10).
2. Session stores `userId`; CSRF token regenerated with session (`crypto.randomBytes(24)`).
3. `loadUser` loads `id, role, full_name, phone, specialty, accepting_orders, orders_opened_unpaid`.
4. `requireRole(...roles)` → redirect `/login` or 403 error view.
5. CSRF: `checkCsrf` on non-GET; **multipart uploads skip body CSRF middleware** — photo posts re-check `csrfOk(req)` manually after multer.
6. Login brute-force: in-memory Map, 8 fails / 15 minutes per `phone|ip`.
7. Cookies: `httpOnly`, `sameSite=lax`, `secure` if `COOKIE_SECURE=1`, 14 days.
8. Security headers: `nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, strict CSP (self only; no inline scripts).

**Implication for Приёмка:** reuse the same session + CSRF + `requireRole` / ownership checks. Do not invent a second auth. CSP forbids client-side JS frameworks unless CSP is consciously extended (today UI is server-rendered forms only).

---

## 5. Roles and cabinets

`users.role` CHECK: `'client' | 'foreman' | 'master'`.

| Role | HOME | Notes |
|------|------|-------|
| `client` | `/client` | Registration closed; cabinet closed view. Schema + unused handlers remain. |
| `foreman` | `/foreman` | Objects, stages, purchases, photos, offers, tasks. |
| `master` | `/master` | Offers, tasks response, bookings, guarantees, dues, unpaid subscription flag. |

`HOME` / `ROLES` live in `src/text.js` and are injected into all views via `res.locals`.

**Navigation chrome:** `views/partials/head.ejs` — brand «Наряд», role label + name, logout. **No sidebar, no product switcher.** Cross-product navigation for «Приёмка» must be designed into landing + optional in-header links without inventing a new app shell.

---

## 6. Database (current tables)

Applied from `src/schema.sql`:

| Table | Purpose |
|-------|---------|
| `session` | Session store |
| `users` | Accounts |
| `requests` | Client repair requests (legacy / latent) |
| `objects` | Foreman apartment objects (`opened_unpaid`) |
| `stages` | Object work stages |
| `purchases` | Object purchases / client debt |
| `photos` | Object room photos (`stored_name` only) |
| `offers` | Master job offers from request or object |
| `tasks` | Foreman → specialty tasks |
| `task_responses` | Master responses to tasks |
| `master_bookings` | Master calendar |
| `master_guarantees` | Master warranties |
| `master_client_dues` | Master client money owed |

**No** organizations, entitlements, PDF, share tokens, or inspection entities on baseline.

Ownership pattern used today: SQL joins/`WHERE foreman_id = $userId` / `loadOwnedObject(userId, objectId)`.

---

## 7. Photos / files

- Env: `PHOTO_DIR` (container `/data/photos`, local `./data/photos`).
- Upload: max **5 MB**, one file; sniff JPEG/PNG/WebP magic bytes; random `hex.ext` name; DB row + disk; unlink on DB failure.
- Serve: `GET /photos/:id` — only if photo’s object `foreman_id` matches session user; `path.basename` + resolve jail.
- No thumbnails, no resize, no S3. Product brief explicitly leaves object storage for later.

**Reuse for Приёмка:** same sniff + size + random name + owner-gated sendFile. Prefer subdirectory `PHOTO_DIR/inspection/` and separate table (`defect_photos`) so foreman `photos` stays untouched. Optional StorageService wrapper (see proposed architecture).

---

## 8. Billing / tariffs (present)

| Product | Price | Gate |
|---------|-------|------|
| Foreman object | **690 ₽** | `objects.opened_unpaid`; confirm checkbox |
| Master incoming | **490 ₽ / month** | `users.orders_opened_unpaid` + `accepting_orders` |
| Inspection | **not present** | proposed **990 ₽ / object** (does not change 690/490) |

No ЮKassa, no entitlement table, no webhook log. Honest unpaid UX only.

---

## 9. Frontend / design system

- **No** React/Vue/Tailwind/shadcn/Bootstrap.
- Single stylesheet `public/app.css` (~1292 lines) + self-hosted fonts **Golos Text** + **Unbounded**.
- Tokens in `:root`: cool concrete greens (`--bg #e4e9e5`, `--accent #0c6b54`, `--ok`, `--warn`), radii 12/16, spacing scale, role colors via `body.role-*`.
- Reusable UI patterns (classes): `.btn` / `.btn.secondary`, `.text-btn`, `.field`, `.choice`, `.stack`, `.banner` / `.notice`, `.empty`, `.rows` / `.row`, `.page-head`, `.kicker`, `.lede`, `.back`, `.price`, `.tag`, `.photos`, `.wrap` / `.board` / `.wide`, home tiles.
- Partials: `head`, `foot`, `csrf`, `drawing`, `demo`.
- Mobile-first forms; no SPA; no sticky action bar yet (may add only if consistent with existing CSS).

**Rule for Приёмка:** additive CSS under same tokens; same EJS chrome; no new UI kit.

---

## 10. Key routes (mount)

Public: `/`, `/login`, `/login/:role`, `/register`, `/register/:role`, `/logout`, `/health`, `/photos/:id`.

Client: `/client`, `/client/requests…` (closed entry).

Foreman: `/foreman`, `/foreman/tasks…`, `/foreman/objects…` (CRUD stages/purchases/photos/offers/done/note).

Master: `/master`, bookings/guarantees/dues, `/master/subscription`, `/master/accepting`, `/master/offers…`, `/master/tasks…`.

---

## 11. Tests today

`scripts/verify-flow.js` (HTTP against running server):

- Health, landing copy (690/490, no fake charge, no client tile).
- Register foreman + masters; refuse client registration.
- Role isolation (foreman cannot open `/master`).
- Create unpaid object; stages/purchases/photos sections; offer to master; accept flow.
- Explicit unpaid confirmations.

**Not covered:** photo binary upload, CSRF negative cases beyond login, IDOR matrix, PDF, inspection.

To run: app + Postgres up, then `BASE_URL=… npm run verify`.

---

## 12. What can be reused for «Приёмка»

| Asset | Reuse |
|-------|-------|
| Session + CSRF + `requireRole` | Yes |
| `loadOwned*` ownership SQL pattern | Yes (owner_user_id) |
| Paywall EJS + unpaid confirm | Yes (990 ₽ copy) |
| Multer + sniffImage + PHOTO_DIR | Yes |
| `withTx`, `parseId`, formatters | Yes |
| `head`/`foot`/`csrf`, CSS tokens, `.rows`/`.empty`/`.field` | Yes |
| `verify-flow.js` style | Clone → `verify-inspection-flow.js` |
| Separate auth / design system / users table | **No** |

---

## 13. Gaps vs Inspection MVP needs

| Need | Gap |
|------|-----|
| Checklist engine + versioning | New tables + seed |
| Defects / measurements / progress | New domain |
| PDF report versions | New dependency (e.g. PDFKit) + storage |
| Share tokens | New |
| Offline queue | P1; P0 accept `client_operation_id` |
| Entitlement abstraction | New small billing tables (shared) |
| Thumbnails / compress | Not present; P0/P1 |
| Product nav for 3rd product | Landing + HOME extension |
| Role model | Prefer **any authenticated owner** (foreman/master) creating inspections — avoid forcing `client` revival; optional dedicated entry tile |

---

## 14. Proposed integration architecture (design only)

```
src/inspection/
  routes.js          # mount under /inspection
  service.js         # ownership + mutations
  progress.js        # pure progress counters
  report.js          # PDF generation
  billing.js         # entitlement check/grant unpaid
  storage.js         # PHOTO_DIR/inspection adapter
  schema.sql         # additive DDL included from migrate OR appended carefully
  seed.js            # checklist template v1
views/inspection/*.ejs
scripts/verify-inspection-flow.js
```

- Prefix: `/inspection` (optional alias `/priemka`).
- Tables: `inspection_*`, `checklist_*`, `defect_*`, minimal `billing_*` — no collision with `objects`/`photos`.
- Owner: `owner_user_id`; all queries scoped; share path separate.
- Billing product id `inspection_object` @ 990 ₽; unpaid confirm P0.
- Pin `checklist_template_version_id` when inspection starts.
- Extend `HOME` only if a dedicated role appears; otherwise entry from landing + `/inspection` after login as existing roles.

Details: `PRODUCT-SPEC.md`, `DATA-MODEL.md`, `UX-FLOW.md`, `SECURITY.md`, `TEST-PLAN.md`, `ROADMAP.md`.

---

## 15. Risks called out by this audit

1. **`routes.js` size** — inspection must live in its own module.
2. **No migration runner** — additive SQL only; dual-path later (DEC-006 on older docs).
3. **CSP without scripts** — auto-save / offline queue need either progressive enhancement forms (POST each step) or a deliberate CSP update.
4. **Client product soft-closed** — do not reopen client registration casually for Inspection.
5. **Prior `feature/inspection-product` branch** exists with a previous P0 attempt; baseline is production sync **without** that code. Re-implement against this audit, cherry-picking ideas carefully — do not assume old schema is deployed.
6. **Prod deploy** still requires separate server backup ritual (workspace rule) before any live change.

---

## 16. Audit conclusion

Naryad is a compact SSR Express + Postgres app with solid session/CSRF/ownership patterns and a coherent visual system. «Приёмка» should be a **fourth product surface** mounted beside existing cabinets, reusing auth, paywall honesty, photo hygiene, and CSS — not a rewrite. Implementation starts only after this documentation set is committed (NAR-INS-001 done → NAR-INS-002 next).
