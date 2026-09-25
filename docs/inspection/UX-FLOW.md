# UX-FLOW — «Приёмка»

**Visual rule:** reuse `public/app.css` tokens and patterns (`.btn`, `.field`, `.stack`, `.rows`, `.empty`, `.banner`, `.page-head`, `.kicker`, `.price`, paywall notice). No new UI kit.

## 1. Entry

**Landing (`/`):** add a third product block «Приёмка» with price **990 ₽ за объект** and honest «Деньги не списываются», CTA Вход / Регистрация (existing foreman/master paths) or deep-link `/inspection` after auth.

**After login:** if user opens `/inspection` — list of projects. Header stays existing `partials/head` (mark «Наряд», role, logout). Optional subtle nav link «Приёмка» next to role area — only if it does not clutter mobile header; otherwise rely on landing + bookmarks + post-create redirects.

## 2. Screens (P0)

| Step | Route sketch | UI pattern |
|------|--------------|------------|
| List | `GET /inspection` | `.page-head` + `.rows` / `.empty` |
| Paywall + create | `GET/POST /inspection/new` | Clone foreman paywall: `.price`, `.notice`, `.choice` unpaid |
| Project edit | `GET/POST /inspection/:id` | `.stack` fields, short sections |
| Rooms | `GET/POST /inspection/:id/rooms` | list + add/rename/reorder/delete/unavailable |
| Prepare | `GET/POST /inspection/:id/prepare` | short checklist; «Подготовлено» |
| Run | `GET /inspection/:id/run` | room switcher + checklist items + sticky primary actions if CSS allows |
| Item result | `POST …/results` | segment buttons / radio `.choice` |
| Quick defect | `GET/POST …/defects/new` | minimal: room, title (templates), photo, comment |
| Defect detail | `GET/POST …/defects/:defectId` | add photo/measurement |
| Progress | embedded on run + project | «68% · Кухня 18/20» factual counts |
| Review | `GET /inspection/:id/review` | completeness warnings |
| Complete | `POST …/complete` | confirm |
| Report | `GET …/report` + PDF download | summary + link to versioned file |
| History | `GET …/history` | `.rows` of events |
| Resume | banner on list/project | «Продолжить приёмку?» |

## 3. Mobile checklist UX

- One room at a time
- Large tap targets for result states
- `+ Дефект` primary near bottom (`.actions` / optional sticky bar using existing colors)
- Camera via `<input type="file" accept="image/*" capture="environment">` — same as foreman photos mindset
- No multi-hundred-field single page

## 4. Empty / error states

| State | Copy style |
|-------|------------|
| No projects | «Приёмок нет.» + button (like client/foreman empties) |
| No rooms | Prompt before start |
| No defects | Neutral, not celebration of quality rating |
| Save/photo/PDF errors | `.banner.is-error` flash |
| Expired share (P1) | error.ejs style |

## 5. Autosave & resume

Under current CSP (no app JS), **autosave = synchronous form POSTs** that redirect back to the same context (PRG). Optional tiny progressive enhancement later requires CSP review.

Server stores last `updated_at`; list shows unfinished projects with resume CTA.

## 6. Report UX

- HTML summary page in cabinet (print-friendly)
- Download PDF (real file, not «print this HTML only»)
- Version label «Отчёт v1», «Отчёт v2»
- No auto legal verdict section — structured facts only

## 7. Follow-up (P1)

From completed inspection: «Повторная проверка» → child inspection linked to open defects with before/after photos.
