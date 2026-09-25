# PRODUCT-SPEC — «Приёмка» inside Naryad

**Status:** Spec for NAR-INS-001 (no implementation in this commit)  
**Baseline:** `f508172` (production-synced tree)

## 1. Positioning

«Приёмка» is a full product direction inside the existing Naryad site: accept a finished apartment/unit, walk checklists, capture defects with photos and measurements, produce a versioned report.

It must feel like a natural sibling of **Прораб** and **Мастер**, not a separate brand or app.

Current active acquisition surfaces are Прораб + Мастер (client registration closed). Inspection entry should be added as another landing tile / path without reopening client registration by default.

## 2. Non-goals (MVP / P0)

- AI photo analysis, voice input, auto ГОСТ claims
- Separate auth, design system, or user store
- Changing foreman **690 ₽** or master **490 ₽**
- Live payment provider (honest unpaid confirm only)
- Full offline-first / service worker (architecture hooks only)
- Plan markers, photo annotations (P1)
- Rewriting existing cabinets

## 3. Actors

| Actor | Access |
|-------|--------|
| Authenticated Naryad user (foreman or master on baseline) | Owns inspections (`owner_user_id`) |
| Share-link viewer (P1) | Read-only report via opaque token |
| Anonymous | Landing + login/register only |

P0 recommendation: **do not** add a mandatory new DB role. Any logged-in foreman/master may open `/inspection`. Optional later: dedicated `inspector` role if product wants a third registration path.

## 4. Core user journey (P0)

1. Enter **Приёмка** from landing or after login → `/inspection`
2. Paywall / create project (**990 ₽**, unpaid confirm)
3. Fill object fields (type, finish, address, areas, developer…)
4. Preparation screen (checklist of tools/docs) → mark prepared
5. Add/reorder rooms
6. Start inspection → pin checklist template version
7. Walk checklist (project-scoped + per-room items)
8. Quick defect: room → title/template → photo → comment → save
9. Optional measurement
10. Progress visible continuously
11. Review completeness → complete
12. Generate PDF report (versioned)
13. History of key events

P1: share link, follow-up recheck, norms, plan pins, document pack, richer offline.

## 5. Business rules

- Price: **990 ₽ per InspectionProject** (billing product `inspection_object`).
- Until PSP: `opened_unpaid` / entitlement `source=unpaid_confirm` with clear copy.
- Checklist templates are versioned; starting freezes version for that inspection.
- Defect numbers `D-001…` are stable per inspection (monotonic counter; never renumber on delete).
- Severity and measurements are observational — **no** automatic legal conclusions.
- Normative text only from curated verified rows (P1); UI otherwise says «норма не определена» / «требует проверки».

## 6. Status machines

**Project:** `DRAFT | SCHEDULED | IN_PROGRESS | COMPLETED | FOLLOW_UP | ARCHIVED`

**Inspection run:** `DRAFT → IN_PROGRESS ↔ PAUSED → COMPLETED` (+ `FOLLOW_UP`, `ARCHIVED`)

**Checklist item result:** `NOT_CHECKED | OK | DEFECT | NOT_APPLICABLE | NOT_ACCESSIBLE | BLOCKED`  
(Map to DB enums carefully; older draft used shorter codes — prefer explicit names matching this spec.)

**Defect severity:** `INFO | MINOR | MAJOR | CRITICAL`

**Defect status:** `OPEN | CONFIRMED | FIXED | RECHECK_REQUIRED | CLOSED | WONT_FIX`

## 7. Property / finish enums

**Property:** квартира, студия, частный дом, офис, коммерческое, другое  
**Finish:** без отделки, white box, предчистовая, чистовая, дизайнерская, другое  

Stored as stable TEXT codes; labels in `src/text.js` (or inspection constants). Adding a type = code + label, not a product rewrite.

## 8. UX principles (aligned with Naryad)

- Short steps, not 100-field pages
- Mobile one-hand: large `.btn`, existing `.field` / `.stack`
- Empty states via `.empty`
- Errors via `.banner.is-error` / `.field-error`
- Autosave = each significant POST persists immediately (SSR-friendly under current CSP)
- Resume banner if unfinished inspection exists for owner

## 9. Integration points

| Area | Change |
|------|--------|
| Landing | Add Приёмка tile (price 990, register/login path or post-login CTA) |
| `text.js` | `PRICES.inspectionObjectRub = 990`, labels, HOME if needed |
| `server.js` / `routes.js` | Mount inspection router |
| `schema.sql` or `src/inspection/schema.sql` | Additive DDL |
| `app.css` | Additive classes only |
| Docs | Keep `docs/inspection/*` + product-brief mention |

## 10. Success (Definition of Done — product)

User can complete P0 journey; existing verify-flow for Прораб/Мастер still passes; IDOR blocked; PDF stored as immutable version; docs updated.
