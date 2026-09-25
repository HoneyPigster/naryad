const crypto = require('crypto');
const { pool, withTx } = require('../db');
const { finishAllows, PRODUCT_INSPECTION } = require('./constants');
const { computeProgress, computeProgressByRoom } = require('./progress');
const { grantUnpaidEntitlement, hasEntitlement } = require('./billing');
const storage = require('./storage');

async function history(client, inspectionId, userId, action, entityType, entityId, metadata) {
  await client.query(
    `INSERT INTO inspection_history
      (inspection_id, user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [inspectionId, userId || null, action, entityType || null, entityId || null, JSON.stringify(metadata || {})]
  );
}

async function rememberOp(client, userId, operationId, opType, entityType, entityId) {
  if (!operationId) return null;
  const existing = await client.query(
    'SELECT entity_type, entity_id FROM client_operations WHERE operation_id = $1',
    [operationId]
  );
  if (existing.rowCount) return existing.rows[0];
  await client.query(
    `INSERT INTO client_operations (operation_id, user_id, op_type, entity_type, entity_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [operationId, userId, opType, entityType, entityId]
  );
  return null;
}

async function getOwnedProject(userId, projectId, client = pool) {
  const { rows } = await client.query(
    'SELECT * FROM inspection_projects WHERE id = $1 AND owner_user_id = $2',
    [projectId, userId]
  );
  return rows[0] || null;
}

async function listProjects(userId) {
  const { rows } = await pool.query(
    `SELECT p.*,
      (
        SELECT i.id FROM inspections i
        WHERE i.project_id = p.id
        ORDER BY i.created_at DESC LIMIT 1
      ) AS latest_inspection_id,
      (
        SELECT i.status FROM inspections i
        WHERE i.project_id = p.id
        ORDER BY i.created_at DESC LIMIT 1
      ) AS latest_inspection_status
     FROM inspection_projects p
     WHERE p.owner_user_id = $1
     ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows;
}

async function createProject(userId, data) {
  const { rows } = await pool.query(
    `INSERT INTO inspection_projects
      (owner_user_id, title, address, building, apartment_number, floor, total_floors,
       area_m2, rooms_count_declared, property_type, finish_type, developer,
       residential_complex, contract_number, inspection_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'DRAFT')
     RETURNING *`,
    [
      userId,
      data.title,
      data.address,
      data.building || '',
      data.apartment_number || '',
      data.floor || '',
      data.total_floors || '',
      data.area_m2,
      data.rooms_count_declared,
      data.property_type,
      data.finish_type,
      data.developer || '',
      data.residential_complex || '',
      data.contract_number || '',
      data.inspection_date || null,
    ]
  );
  return rows[0];
}

async function openUnpaid(userId, projectId) {
  return withTx(async (client) => {
    const project = await getOwnedProject(userId, projectId, client);
    if (!project) return null;
    await client.query(
      `UPDATE inspection_projects
       SET opened_unpaid = TRUE, updated_at = now()
       WHERE id = $1`,
      [projectId]
    );
    await grantUnpaidEntitlement(userId, projectId, client);
    return getOwnedProject(userId, projectId, client);
  });
}

async function listRooms(projectId) {
  const { rows } = await pool.query(
    'SELECT * FROM inspection_rooms WHERE project_id = $1 ORDER BY sort_order, id',
    [projectId]
  );
  return rows;
}

async function addRoom(userId, projectId, { name, kind }) {
  const project = await getOwnedProject(userId, projectId);
  if (!project) return null;
  const { rows } = await pool.query(
    `INSERT INTO inspection_rooms (project_id, name, kind, sort_order)
     VALUES (
       $1, $2, $3,
       COALESCE((SELECT MAX(sort_order) + 1 FROM inspection_rooms WHERE project_id = $1), 0)
     )
     RETURNING *`,
    [projectId, name, kind]
  );
  return rows[0];
}

async function deleteRoom(userId, projectId, roomId) {
  const project = await getOwnedProject(userId, projectId);
  if (!project) return false;
  if (project.status === 'COMPLETED' || project.status === 'ARCHIVED') return false;
  await pool.query('DELETE FROM inspection_rooms WHERE id = $1 AND project_id = $2', [roomId, projectId]);
  return true;
}

async function latestActiveVersionId(client = pool) {
  const { rows } = await client.query(
    `SELECT v.id
     FROM checklist_template_versions v
     JOIN checklist_templates t ON t.id = v.template_id
     WHERE t.is_active AND t.name = 'Квартира — базовая приёмка'
     ORDER BY v.version DESC
     LIMIT 1`
  );
  return rows[0] ? rows[0].id : null;
}

async function loadVersionItems(versionId, client = pool) {
  const { rows } = await client.query(
    `SELECT i.*, s.name AS section_name, s.sort_order AS section_sort
     FROM checklist_items i
     JOIN checklist_sections s ON s.id = i.section_id
     WHERE s.version_id = $1
     ORDER BY s.sort_order, i.sort_order, i.id`,
    [versionId]
  );
  return rows;
}

async function startInspection(userId, projectId) {
  return withTx(async (client) => {
    const project = await getOwnedProject(userId, projectId, client);
    if (!project) return { error: 'missing' };
    if (!(await hasEntitlement(userId, projectId, client)) && !project.opened_unpaid) {
      return { error: 'paywall' };
    }
    const rooms = (
      await client.query(
        'SELECT * FROM inspection_rooms WHERE project_id = $1 ORDER BY sort_order, id',
        [projectId]
      )
    ).rows;
    if (!rooms.length) return { error: 'rooms' };

    const existing = await client.query(
      `SELECT * FROM inspections
       WHERE project_id = $1 AND status IN ('IN_PROGRESS', 'PAUSED', 'DRAFT')
       ORDER BY created_at DESC LIMIT 1`,
      [projectId]
    );
    if (existing.rowCount) {
      return { inspection: existing.rows[0], project, resumed: true };
    }

    const versionId = project.checklist_template_version_id || (await latestActiveVersionId(client));
    if (!versionId) return { error: 'template' };
    const items = await loadVersionItems(versionId, client);
    const applicable = items.filter((item) => finishAllows(project.finish_type, item.finish_tags));

    const insp = await client.query(
      `INSERT INTO inspections
        (project_id, checklist_template_version_id, status, started_at)
       VALUES ($1, $2, 'IN_PROGRESS', now())
       RETURNING *`,
      [projectId, versionId]
    );
    const inspection = insp.rows[0];

    for (const item of applicable) {
      if (item.scope === 'PROJECT') {
        await client.query(
          `INSERT INTO inspection_item_results (inspection_id, checklist_item_id, room_id, result)
           VALUES ($1, $2, NULL, 'UNCHECKED')
           ON CONFLICT DO NOTHING`,
          [inspection.id, item.id]
        );
      } else {
        for (const room of rooms) {
          if (item.section_name === 'Балкон / лоджия' && !['balcony', 'loggia'].includes(room.kind)) {
            continue;
          }
          if (item.section_name === 'Кухонная зона' && room.kind !== 'kitchen') continue;
          if (item.section_name === 'Санузлы' && !['bathroom', 'wc'].includes(room.kind)) continue;
          if (
            ['Сантехника и вода', 'Канализация'].includes(item.section_name) &&
            !['bathroom', 'wc', 'kitchen'].includes(room.kind)
          ) {
            continue;
          }
          await client.query(
            `INSERT INTO inspection_item_results (inspection_id, checklist_item_id, room_id, result)
             VALUES ($1, $2, $3, 'UNCHECKED')
             ON CONFLICT DO NOTHING`,
            [inspection.id, item.id, room.id]
          );
        }
      }
    }

    await client.query(
      `UPDATE inspection_projects
       SET status = 'IN_PROGRESS',
           checklist_template_version_id = $2,
           updated_at = now()
       WHERE id = $1`,
      [projectId, versionId]
    );
    await history(client, inspection.id, userId, 'inspection_started', 'inspection', inspection.id, {});
    return { inspection, project: await getOwnedProject(userId, projectId, client), resumed: false };
  });
}

async function getInspectionForUser(userId, inspectionId, client = pool) {
  const { rows } = await client.query(
    `SELECT i.*, p.owner_user_id, p.title, p.address, p.finish_type, p.property_type,
            p.residential_complex, p.apartment_number, p.area_m2, p.opened_unpaid, p.id AS project_id
     FROM inspections i
     JOIN inspection_projects p ON p.id = i.project_id
     WHERE i.id = $1 AND p.owner_user_id = $2`,
    [inspectionId, userId]
  );
  return rows[0] || null;
}

async function loadResults(inspectionId) {
  const { rows } = await pool.query(
    `SELECT r.*, i.title, i.instruction, i.scope, i.requires_measurement,
            i.severity_default, s.name AS section_name, s.sort_order AS section_sort,
            i.sort_order AS item_sort
     FROM inspection_item_results r
     JOIN checklist_items i ON i.id = r.checklist_item_id
     JOIN checklist_sections s ON s.id = i.section_id
     WHERE r.inspection_id = $1
     ORDER BY s.sort_order, i.sort_order, r.id`,
    [inspectionId]
  );
  return rows;
}

async function setResult(userId, inspectionId, resultId, result, operationId) {
  return withTx(async (client) => {
    const insp = await getInspectionForUser(userId, inspectionId, client);
    if (!insp) return { error: 'missing' };
    if (!['IN_PROGRESS', 'PAUSED'].includes(insp.status)) return { error: 'locked' };
    if (!['UNCHECKED', 'OK', 'DEFECT', 'NA'].includes(result)) return { error: 'bad_result' };

    const prior = await rememberOp(client, userId, operationId, 'UPDATE_CHECK_ITEM', 'item_result', resultId);
    if (prior && prior.entity_type === 'item_result') {
      const { rows } = await client.query('SELECT * FROM inspection_item_results WHERE id = $1', [
        prior.entity_id,
      ]);
      return { row: rows[0], duplicate: true };
    }

    const updated = await client.query(
      `UPDATE inspection_item_results r
       SET result = $1, updated_at = now()
       FROM inspections i
       JOIN inspection_projects p ON p.id = i.project_id
       WHERE r.id = $2 AND r.inspection_id = i.id AND i.id = $3 AND p.owner_user_id = $4
       RETURNING r.*`,
      [result, resultId, inspectionId, userId]
    );
    if (!updated.rowCount) return { error: 'missing' };
    if (operationId) {
      await client.query(
        `INSERT INTO client_operations (operation_id, user_id, op_type, entity_type, entity_id)
         VALUES ($1,$2,'UPDATE_CHECK_ITEM','item_result',$3)
         ON CONFLICT (operation_id) DO NOTHING`,
        [operationId, userId, updated.rows[0].id]
      );
    }
    await history(client, inspectionId, userId, 'item_result_set', 'item_result', resultId, { result });
    return { row: updated.rows[0] };
  });
}

async function createDefect(userId, inspectionId, data, operationId) {
  return withTx(async (client) => {
    const insp = await getInspectionForUser(userId, inspectionId, client);
    if (!insp) return { error: 'missing' };
    if (!['IN_PROGRESS', 'PAUSED'].includes(insp.status)) return { error: 'locked' };

    if (operationId) {
      const prior = await client.query(
        'SELECT entity_id FROM client_operations WHERE operation_id = $1 AND user_id = $2',
        [operationId, userId]
      );
      if (prior.rowCount) {
        const { rows } = await client.query('SELECT * FROM defects WHERE id = $1', [prior.rows[0].entity_id]);
        return { defect: rows[0], duplicate: true };
      }
    }

    const inserted = await client.query(
      `INSERT INTO defects
        (inspection_id, room_id, checklist_item_id, item_result_id, title, description, severity, location_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        inspectionId,
        data.room_id || null,
        data.checklist_item_id || null,
        data.item_result_id || null,
        data.title,
        data.description || '',
        data.severity || 'MINOR',
        data.location_description || '',
      ]
    );
    const defect = inserted.rows[0];
    if (data.item_result_id) {
      await client.query(
        `UPDATE inspection_item_results SET result = 'DEFECT', updated_at = now()
         WHERE id = $1 AND inspection_id = $2`,
        [data.item_result_id, inspectionId]
      );
    }
    if (operationId) {
      await client.query(
        `INSERT INTO client_operations (operation_id, user_id, op_type, entity_type, entity_id)
         VALUES ($1,$2,'CREATE_DEFECT','defect',$3)`,
        [operationId, userId, defect.id]
      );
    }
    await history(client, inspectionId, userId, 'defect_created', 'defect', defect.id, {
      title: defect.title,
    });
    return { defect };
  });
}

async function listDefects(inspectionId, filters = {}) {
  const params = [inspectionId];
  let sql = `SELECT d.*, r.name AS room_name
             FROM defects d
             LEFT JOIN inspection_rooms r ON r.id = d.room_id
             WHERE d.inspection_id = $1`;
  if (filters.severity) {
    params.push(filters.severity);
    sql += ` AND d.severity = $${params.length}`;
  }
  if (filters.status) {
    params.push(filters.status);
    sql += ` AND d.status = $${params.length}`;
  }
  if (filters.room_id) {
    params.push(Number(filters.room_id));
    sql += ` AND d.room_id = $${params.length}`;
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    sql += ` AND (d.title ILIKE $${params.length} OR d.description ILIKE $${params.length})`;
  }
  sql += ' ORDER BY d.created_at';
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getDefectForUser(userId, defectId) {
  const { rows } = await pool.query(
    `SELECT d.*, p.owner_user_id, i.id AS inspection_id
     FROM defects d
     JOIN inspections i ON i.id = d.inspection_id
     JOIN inspection_projects p ON p.id = i.project_id
     WHERE d.id = $1 AND p.owner_user_id = $2`,
    [defectId, userId]
  );
  return rows[0] || null;
}

async function addPhoto(userId, defectId, buffer, kind, operationId) {
  return withTx(async (client) => {
    const defect = await getDefectForUser(userId, defectId);
    if (!defect) return { error: 'missing' };
    if (operationId) {
      const prior = await client.query(
        'SELECT entity_id FROM client_operations WHERE operation_id = $1 AND user_id = $2',
        [operationId, userId]
      );
      if (prior.rowCount) {
        const { rows } = await client.query('SELECT * FROM defect_photos WHERE id = $1', [
          prior.rows[0].entity_id,
        ]);
        return { photo: rows[0], duplicate: true };
      }
    }
    let uploaded;
    try {
      uploaded = await storage.uploadImage(buffer);
    } catch (error) {
      return { error: error.code || 'upload' };
    }
    const { rows } = await client.query(
      `INSERT INTO defect_photos (defect_id, kind, stored_name, client_operation_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [defectId, kind || 'OTHER', uploaded.storedName, operationId || null]
    );
    if (operationId) {
      await client.query(
        `INSERT INTO client_operations (operation_id, user_id, op_type, entity_type, entity_id)
         VALUES ($1,$2,'UPLOAD_PHOTO','defect_photo',$3)
         ON CONFLICT DO NOTHING`,
        [operationId, userId, rows[0].id]
      );
    }
    await history(client, defect.inspection_id, userId, 'photo_added', 'defect_photo', rows[0].id, {
      defect_id: defectId,
    });
    return { photo: rows[0] };
  });
}

async function addMeasurement(userId, defectId, data) {
  const defect = await getDefectForUser(userId, defectId);
  if (!defect) return { error: 'missing' };
  const value = Number(data.value_numeric);
  if (!Number.isFinite(value)) return { error: 'bad_value' };
  const { rows } = await pool.query(
    `INSERT INTO defect_measurements (defect_id, measure_type, value_numeric, unit, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [defectId, data.measure_type, value, data.unit, data.note || '']
  );
  await history(pool, defect.inspection_id, userId, 'measurement_added', 'measurement', rows[0].id, {});
  return { measurement: rows[0] };
}

async function listPhotos(defectId) {
  const { rows } = await pool.query(
    'SELECT * FROM defect_photos WHERE defect_id = $1 ORDER BY created_at',
    [defectId]
  );
  return rows;
}

async function listMeasurements(defectId) {
  const { rows } = await pool.query(
    'SELECT * FROM defect_measurements WHERE defect_id = $1 ORDER BY created_at',
    [defectId]
  );
  return rows;
}

async function pauseInspection(userId, inspectionId) {
  return withTx(async (client) => {
    const insp = await getInspectionForUser(userId, inspectionId, client);
    if (!insp) return null;
    if (insp.status !== 'IN_PROGRESS') return insp;
    const { rows } = await client.query(
      `UPDATE inspections SET status = 'PAUSED' WHERE id = $1 RETURNING *`,
      [inspectionId]
    );
    await history(client, inspectionId, userId, 'inspection_paused', 'inspection', inspectionId, {});
    return rows[0];
  });
}

async function completeInspection(userId, inspectionId, { force }) {
  return withTx(async (client) => {
    const insp = await getInspectionForUser(userId, inspectionId, client);
    if (!insp) return { error: 'missing' };
    if (!['IN_PROGRESS', 'PAUSED'].includes(insp.status)) return { error: 'locked' };
    const results = (
      await client.query('SELECT result FROM inspection_item_results WHERE inspection_id = $1', [
        inspectionId,
      ])
    ).rows;
    const progress = computeProgress(results);
    if (progress.unchecked > 0 && !force) {
      return { error: 'unchecked', progress };
    }
    await client.query(
      `UPDATE inspections SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
      [inspectionId]
    );
    await client.query(
      `UPDATE inspection_projects SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
      [insp.project_id]
    );
    await history(client, inspectionId, userId, 'inspection_completed', 'inspection', inspectionId, {
      progress,
    });
    return { ok: true, progress };
  });
}

async function getHistory(inspectionId) {
  const { rows } = await pool.query(
    `SELECT h.*, u.full_name
     FROM inspection_history h
     LEFT JOIN users u ON u.id = h.user_id
     WHERE h.inspection_id = $1
     ORDER BY h.created_at`,
    [inspectionId]
  );
  return rows;
}

async function defectTemplates() {
  const { rows } = await pool.query(
    'SELECT * FROM defect_templates WHERE is_active ORDER BY sort_order, id'
  );
  return rows;
}

async function createShare(userId, inspectionId, days = 14) {
  const insp = await getInspectionForUser(userId, inspectionId);
  if (!insp) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO inspection_shares (inspection_id, token, expires_at)
     VALUES ($1, $2, now() + ($3::text || ' days')::interval)
     RETURNING *`,
    [inspectionId, token, String(days)]
  );
  await history(pool, inspectionId, userId, 'share_created', 'share', rows[0].id, {});
  return rows[0];
}

async function getShare(token) {
  const { rows } = await pool.query(
    `SELECT s.*, i.id AS inspection_id, p.title, p.address
     FROM inspection_shares s
     JOIN inspections i ON i.id = s.inspection_id
     JOIN inspection_projects p ON p.id = i.project_id
     WHERE s.token = $1`,
    [token]
  );
  const share = rows[0];
  if (!share) return null;
  if (share.revoked_at) return { error: 'revoked' };
  if (share.expires_at && new Date(share.expires_at) < new Date()) return { error: 'expired' };
  return { share };
}

async function revokeShare(userId, shareId) {
  const { rows } = await pool.query(
    `UPDATE inspection_shares s
     SET revoked_at = now()
     FROM inspections i
     JOIN inspection_projects p ON p.id = i.project_id
     WHERE s.id = $1 AND s.inspection_id = i.id AND p.owner_user_id = $2
     RETURNING s.*`,
    [shareId, userId]
  );
  return rows[0] || null;
}

async function createFollowUp(userId, inspectionId) {
  return withTx(async (client) => {
    const parent = await getInspectionForUser(userId, inspectionId, client);
    if (!parent) return { error: 'missing' };
    if (parent.status !== 'COMPLETED' && parent.status !== 'FOLLOW_UP') return { error: 'not_complete' };

    const child = await client.query(
      `INSERT INTO inspections
        (project_id, parent_inspection_id, checklist_template_version_id, status, started_at)
       VALUES ($1, $2, $3, 'IN_PROGRESS', now())
       RETURNING *`,
      [parent.project_id, parent.id, parent.checklist_template_version_id]
    );
    const childId = child.rows[0].id;

    // Copy open defects as RECHECK_REQUIRED snapshots via status update + link
    await client.query(
      `UPDATE defects SET status = 'RECHECK_REQUIRED', updated_at = now()
       WHERE inspection_id = $1 AND status IN ('OPEN', 'CONFIRMED', 'FIXED')`,
      [inspectionId]
    );

    // Materialize results again for child from parent version + rooms
    const project = await getOwnedProject(userId, parent.project_id, client);
    const rooms = (
      await client.query('SELECT * FROM inspection_rooms WHERE project_id = $1', [parent.project_id])
    ).rows;
    const items = await loadVersionItems(parent.checklist_template_version_id, client);
    const applicable = items.filter((item) => finishAllows(project.finish_type, item.finish_tags));
    for (const item of applicable) {
      if (item.scope === 'PROJECT') {
        await client.query(
          `INSERT INTO inspection_item_results (inspection_id, checklist_item_id, room_id, result)
           VALUES ($1,$2,NULL,'UNCHECKED') ON CONFLICT DO NOTHING`,
          [childId, item.id]
        );
      } else {
        for (const room of rooms) {
          await client.query(
            `INSERT INTO inspection_item_results (inspection_id, checklist_item_id, room_id, result)
             VALUES ($1,$2,$3,'UNCHECKED') ON CONFLICT DO NOTHING`,
            [childId, item.id, room.id]
          );
        }
      }
    }

    await client.query(
      `INSERT INTO follow_up_links (parent_inspection_id, child_inspection_id) VALUES ($1,$2)`,
      [inspectionId, childId]
    );
    await client.query(
      `UPDATE inspections SET status = 'FOLLOW_UP' WHERE id = $1`,
      [inspectionId]
    );
    await client.query(
      `UPDATE inspection_projects SET status = 'FOLLOW_UP', updated_at = now() WHERE id = $1`,
      [parent.project_id]
    );
    await history(client, childId, userId, 'followup_created', 'inspection', childId, {
      parent: inspectionId,
    });
    return { inspection: child.rows[0] };
  });
}

async function setDefectStatus(userId, defectId, status) {
  const defect = await getDefectForUser(userId, defectId);
  if (!defect) return { error: 'missing' };
  const allowed = ['OPEN', 'CONFIRMED', 'FIXED', 'RECHECK_REQUIRED', 'CLOSED', 'WONT_FIX'];
  if (!allowed.includes(status)) return { error: 'bad_status' };
  const { rows } = await pool.query(
    `UPDATE defects SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [status, defectId]
  );
  await history(pool, defect.inspection_id, userId, 'defect_status', 'defect', defectId, { status });
  return { defect: rows[0] };
}

async function progressFor(inspectionId) {
  const results = await loadResults(inspectionId);
  const rooms = await pool.query(
    `SELECT r.* FROM inspection_rooms r
     JOIN inspections i ON i.project_id = r.project_id
     WHERE i.id = $1 ORDER BY r.sort_order, r.id`,
    [inspectionId]
  );
  const defects = await listDefects(inspectionId);
  const overall = computeProgress(results);
  const byRoom = computeProgressByRoom(results, rooms.rows);
  const severity = { INFO: 0, MINOR: 0, MAJOR: 0, CRITICAL: 0 };
  for (const d of defects) {
    if (severity[d.severity] != null) severity[d.severity] += 1;
  }
  return { overall, byRoom, rooms: rooms.rows, defectsCount: defects.length, severity, results };
}

module.exports = {
  listProjects,
  createProject,
  getOwnedProject,
  openUnpaid,
  listRooms,
  addRoom,
  deleteRoom,
  startInspection,
  getInspectionForUser,
  loadResults,
  setResult,
  createDefect,
  listDefects,
  getDefectForUser,
  addPhoto,
  addMeasurement,
  listPhotos,
  listMeasurements,
  pauseInspection,
  completeInspection,
  getHistory,
  defectTemplates,
  createShare,
  getShare,
  revokeShare,
  createFollowUp,
  setDefectStatus,
  progressFor,
  computeProgress,
  hasEntitlement,
  PRODUCT_INSPECTION,
};
