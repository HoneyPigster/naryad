# DATA-MODEL — «Приёмка»

**Status:** Proposed model for implementation (NAR-INS-002+)  
**Constraint:** Additive only relative to baseline `src/schema.sql`. Never drop existing Naryad tables.

## 1. Naming

Prefer clear prefixes:

- `inspection_projects`, `inspection_rooms`, `inspections`, …
- `checklist_templates`, `checklist_template_versions`, `checklist_sections`, `checklist_items`
- `defects`, `defect_photos`, `defect_measurements`, `defect_templates`
- Shared billing: `billing_products`, `billing_entitlements`, `billing_payment_events`

Avoid colliding with foreman `objects`, `photos`, `stages`.

## 2. Entity map (P0 solid / P1 stub)

```
users
  └── inspection_projects (owner_user_id)
        ├── inspection_rooms
        ├── inspections (pinned checklist_template_version_id)
        │     ├── inspection_item_results
        │     ├── defects
        │     │     ├── defect_photos
        │     │     └── defect_measurements
        │     ├── inspection_history
        │     ├── inspection_reports
        │     │     └── inspection_report_versions
        │     └── (P1) inspection_shares, follow_up links
        └── (P1) inspection_documents, plans

checklist_templates
  └── checklist_template_versions (immutable once frozen)
        ├── checklist_sections
        └── checklist_items
```

## 3. Table sketches (logical)

### billing_products / billing_entitlements / billing_payment_events

- Product row: `inspection_object`, `990`, unit `object`
- Entitlement unique `(user_id, product_id, subject_type, subject_id)`
- P0 grant: `source = 'unpaid_confirm'`
- Payment events table ready for future PSP idempotency (`provider_event_id UNIQUE`)

### inspection_projects

Key fields: `id`, `owner_user_id`, `organization_id NULL`, `title`, address parts, `declared_area` / `actual_area`, `property_type`, `finish_type`, `developer`, `contract_number`, `handover_date`, `status`, `notes`, `opened_unpaid`, `checklist_template_version_id?`, `defect_seq` (int, next defect number), `created_at`, `updated_at`, `completed_at`

### inspection_rooms

`id`, `project_id`, `name`, `kind`, `sort_order`, `unavailable BOOLEAN DEFAULT FALSE`

Kinds: hallway, kitchen, living, bedroom, kids, bathroom, wc, wardrobe, balcony, loggia, corridor, pantry, other (extend via CHECK or TEXT + app enum).

### checklist_templates / versions / sections / items

- Template: name, applicability hints
- Version: `version INT`, `frozen_at`, immutable content
- Section: title, sort_order
- Item: code, title, `scope` (`PROJECT`|`ROOM`), sort_order, help text (non-legal)

Seed v1 sections: documents, entrance door, windows, balcony, walls, ceiling, floor, interior doors, electrics, lighting, water, sewage, heating, ventilation, meters, finish, bathrooms, kitchen, summary — items as product list (see PRODUCT-SPEC / roadmap seed task).

### inspections

Runtime walkthrough: `project_id`, `parent_inspection_id?`, pinned `checklist_template_version_id`, `status`, `started_at`, `completed_at`, `prepared_at?`

### inspection_item_results

`inspection_id`, `checklist_item_id`, `room_id NULL`, `result`, `updated_at`  
Unique partial indexes for project-scoped vs room-scoped rows.

Results: `NOT_CHECKED`, `OK`, `DEFECT`, `NOT_APPLICABLE`, `NOT_ACCESSIBLE`, `BLOCKED`

### defects

`inspection_id`, `room_id`, `checklist_item_id?`, `number INT` (stable), `code` generated `D-NNN`, `title`, `description`, `severity`, `status`, `location_description`, timestamps

### defect_photos

`defect_id`, `kind` (OVERVIEW|CLOSEUP|SCALE|MEASUREMENT|OTHER), `stored_name`, `thumb_name?`, `client_operation_id?`, `created_at`  
Files under `PHOTO_DIR/inspection/…`

### defect_measurements

`defect_id`, `measurement_type`, `value`, `unit` (mm|cm|m|deg|pct|other), `comment`

### defect_templates

Seed phrases: царапина, скол, трещина, … (user may still free-type)

### inspection_history

Append-only: `action`, `entity_type`, `entity_id`, `metadata JSONB`, `user_id`, `created_at`

### inspection_reports / inspection_report_versions

Report 1:1 inspection; versions with `version`, `storage_key`, `format` (`pdf`), never overwrite

### client_operations (P0 table, P1 sync UI)

`operation_id UNIQUE`, `user_id`, `type`, `entity_type`, `entity_id`, `payload_hash`, `created_at`

## 4. P1 tables (may create empty / nullable FKs later)

- `normative_references`, `defect_normative_links`
- `inspection_documents`
- `inspection_shares` (cryptographic token, expires, revoked)
- `inspection_expected_specs` (promised vs actual)
- `inspection_plan_pages`, `plan_markers`
- `follow_up_inspections` / `defect_rechecks`
- Photo annotations store

## 5. Mapping from brief names

| Brief name | Proposed table |
|------------|----------------|
| InspectionProject | `inspection_projects` |
| InspectionRoom | `inspection_rooms` |
| ChecklistTemplate / Section / Item | `checklist_*` |
| InspectionItemResult | `inspection_item_results` |
| Defect | `defects` |
| DefectPhoto | `defect_photos` |
| DefectMeasurement | `defect_measurements` |
| NormativeReference | `normative_references` (P1) |
| InspectionDocument | `inspection_documents` (P1) |
| InspectionReport / Version | `inspection_reports`, `inspection_report_versions` |
| InspectionShare | `inspection_shares` (P1) |
| InspectionHistory | `inspection_history` |
| FollowUpInspection | `inspections.parent_inspection_id` + link table (P1) |

## 6. Migrate strategy

1. Add `src/inspection/schema.sql` and invoke from `db.migrate()` after core schema, **or** append to `src/schema.sql` in a dedicated commit.
2. All statements idempotent.
3. Seed checklist template version 1 in same migrate/seed step.
4. Do not modify existing CHECKs on `users.role` unless a product decision adds `inspector`.

## 7. Progress derivation (not stored as rating)

Computed from results + defects:

- checked = results where result ≠ NOT_CHECKED
- defects_count, critical_count
- per-room checked/total
- incomplete defects: missing photo / description / room
