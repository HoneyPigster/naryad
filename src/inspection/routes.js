const multer = require('multer');
const { flash, csrfOk, rejectCsrf } = require('../mw');
const { formatMoney, formatDate, parseId } = require('../text');
const constants = require('./constants');
const service = require('./service');
const report = require('./report');
const storage = require('./storage');
const { processPaymentEvent } = require('./billing');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

function requireInspector(req, res, next) {
  if (!res.locals.user) {
    const nextUrl = encodeURIComponent(req.originalUrl || '/inspection');
    return res.redirect(303, `/login/inspector?next=${nextUrl}`);
  }
  if (res.locals.user.role !== 'inspector') {
    return res.status(403).render('error', {
      title: 'Нет доступа',
      message:
        'Приёмка — отдельный кабинет. Выйдите и войдите или зарегистрируйтесь как «Приёмка».',
    });
  }
  return next();
}

function localsExtra(res) {
  Object.assign(res.locals, {
    PROPERTY_TYPES: constants.PROPERTY_TYPES,
    FINISH_TYPES: constants.FINISH_TYPES,
    ROOM_KINDS: constants.ROOM_KINDS,
    PROJECT_STATUS: constants.PROJECT_STATUS,
    INSPECTION_STATUS: constants.INSPECTION_STATUS,
    ITEM_RESULTS: constants.ITEM_RESULTS,
    SEVERITIES: constants.SEVERITIES,
    DEFECT_STATUSES: constants.DEFECT_STATUSES,
    MEASURE_TYPES: constants.MEASURE_TYPES,
    MEASURE_UNITS: constants.MEASURE_UNITS,
    PHOTO_KINDS: constants.PHOTO_KINDS,
    INSPECTION_PRICE_RUB: constants.INSPECTION_PRICE_RUB,
    formatMoney,
    formatDate,
  });
}

async function dashboard(req, res, next) {
  try {
    localsExtra(res);
    const projects = await service.listProjects(res.locals.user.id);
    const withProgress = [];
    for (const p of projects) {
      let progress = null;
      if (p.latest_inspection_id) {
        progress = (await service.progressFor(p.latest_inspection_id)).overall;
      }
      withProgress.push({ ...p, progress });
    }
    return res.render('inspection/list', {
      title: 'Мои приёмки',
      projects: withProgress,
    });
  } catch (error) {
    return next(error);
  }
}

function newForm(req, res) {
  localsExtra(res);
  return res.render('inspection/new', {
    title: 'Новая приёмка',
    errors: {},
    values: {
      title: '',
      address: '',
      residential_complex: '',
      apartment_number: '',
      property_type: 'APARTMENT',
      finish_type: 'FINISHED',
      area_m2: '',
      developer: '',
    },
  });
}

async function createProject(req, res, next) {
  localsExtra(res);
  const title = String(req.body.title || '').trim();
  const address = String(req.body.address || '').trim();
  const property_type = String(req.body.property_type || '');
  const finish_type = String(req.body.finish_type || '');
  const errors = {};
  if (title.length < 2 || title.length > 120) errors.title = 'Название — от 2 до 120 символов.';
  if (address.length < 5 || address.length > 200) errors.address = 'Укажите адрес.';
  if (!constants.PROPERTY_TYPES[property_type]) errors.property_type = 'Выберите тип.';
  if (!constants.FINISH_TYPES[finish_type]) errors.finish_type = 'Выберите отделку.';
  let area = null;
  if (String(req.body.area_m2 || '').trim()) {
    area = Number(String(req.body.area_m2).replace(',', '.'));
    if (!Number.isFinite(area) || area <= 0) errors.area_m2 = 'Площадь — положительное число.';
  }
  const values = {
    title,
    address,
    residential_complex: String(req.body.residential_complex || '').trim(),
    apartment_number: String(req.body.apartment_number || '').trim(),
    property_type,
    finish_type,
    area_m2: String(req.body.area_m2 || '').trim(),
    developer: String(req.body.developer || '').trim(),
  };
  if (Object.keys(errors).length) {
    return res.render('inspection/new', { title: 'Новая приёмка', errors, values });
  }
  try {
    const project = await service.createProject(res.locals.user.id, {
      ...values,
      area_m2: area,
      building: '',
      floor: '',
      total_floors: '',
      rooms_count_declared: null,
      contract_number: '',
      inspection_date: null,
    });
    return res.redirect(303, `/inspection/projects/${project.id}/paywall`);
  } catch (error) {
    return next(error);
  }
}

async function paywall(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const project = await service.getOwnedProject(res.locals.user.id, id);
    if (!project) {
      return res.status(404).render('error', { title: 'Нет объекта', message: 'Приёмка не найдена.' });
    }
    localsExtra(res);
    return res.render('inspection/paywall', {
      title: 'Оплата приёмки',
      project,
      price: constants.INSPECTION_PRICE_RUB,
    });
  } catch (error) {
    return next(error);
  }
}

async function openUnpaid(req, res, next) {
  const id = parseId(req.params.id);
  if (req.body.confirm_unpaid !== '1') {
    flash(req, 'error', 'Подтвердите, что открываете приёмку без оплаты.');
    return res.redirect(303, `/inspection/projects/${id}/paywall`);
  }
  try {
    const project = await service.openUnpaid(res.locals.user.id, id);
    if (!project) {
      return res.status(404).render('error', { title: 'Нет объекта', message: 'Приёмка не найдена.' });
    }
    flash(req, 'ok', 'Приёмка открыта. Деньги не списаны.');
    return res.redirect(303, `/inspection/projects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function projectShow(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const project = await service.getOwnedProject(res.locals.user.id, id);
    if (!project) {
      return res.status(404).render('error', { title: 'Нет объекта', message: 'Приёмка не найдена.' });
    }
    if (!project.opened_unpaid && !(await service.hasEntitlement(res.locals.user.id, id))) {
      return res.redirect(303, `/inspection/projects/${id}/paywall`);
    }
    const rooms = await service.listRooms(id);
    const projects = await service.listProjects(res.locals.user.id);
    const mine = projects.find((p) => p.id === id);
    let progress = null;
    let inspection = null;
    if (mine && mine.latest_inspection_id) {
      inspection = await service.getInspectionForUser(res.locals.user.id, mine.latest_inspection_id);
      progress = (await service.progressFor(mine.latest_inspection_id)).overall;
    }
    localsExtra(res);
    return res.render('inspection/project', {
      title: project.title,
      project,
      rooms,
      progress,
      inspection,
    });
  } catch (error) {
    return next(error);
  }
}

async function addRoom(req, res, next) {
  const id = parseId(req.params.id);
  const name = String(req.body.name || '').trim();
  const kind = String(req.body.kind || '');
  if (!constants.ROOM_KINDS[kind] || name.length < 1 || name.length > 80) {
    flash(req, 'error', 'Укажите название и тип помещения.');
    return res.redirect(303, `/inspection/projects/${id}`);
  }
  try {
    const room = await service.addRoom(res.locals.user.id, id, { name, kind });
    if (!room) {
      return res.status(404).render('error', { title: 'Нет объекта', message: 'Приёмка не найдена.' });
    }
    return res.redirect(303, `/inspection/projects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function deleteRoom(req, res, next) {
  const id = parseId(req.params.id);
  const roomId = parseId(req.params.roomId);
  try {
    await service.deleteRoom(res.locals.user.id, id, roomId);
    return res.redirect(303, `/inspection/projects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function start(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const result = await service.startInspection(res.locals.user.id, id);
    if (result.error === 'missing') {
      return res.status(404).render('error', { title: 'Нет объекта', message: 'Приёмка не найдена.' });
    }
    if (result.error === 'paywall') {
      return res.redirect(303, `/inspection/projects/${id}/paywall`);
    }
    if (result.error === 'rooms') {
      flash(req, 'error', 'Добавьте хотя бы одно помещение.');
      return res.redirect(303, `/inspection/projects/${id}`);
    }
    if (result.error === 'template') {
      flash(req, 'error', 'Чек-лист ещё не загружен. Перезапустите приложение.');
      return res.redirect(303, `/inspection/projects/${id}`);
    }
    return res.redirect(303, `/inspection/runs/${result.inspection.id}`);
  } catch (error) {
    return next(error);
  }
}

async function runShow(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const inspection = await service.getInspectionForUser(res.locals.user.id, id);
    if (!inspection) {
      return res.status(404).render('error', { title: 'Нет приёмки', message: 'Осмотр не найден.' });
    }
    const progress = await service.progressFor(id);
    const roomId = parseId(req.query.room);
    const results = progress.results.filter((r) =>
      roomId ? r.room_id === roomId : r.room_id == null || !req.query.room
    );
    const viewResults = req.query.room
      ? progress.results.filter((r) => r.room_id === roomId)
      : progress.results.filter((r) => r.room_id == null);
    const defects = await service.listDefects(id);
    localsExtra(res);
    return res.render('inspection/run', {
      title: inspection.title,
      inspection,
      progress: progress.overall,
      byRoom: progress.byRoom,
      rooms: progress.rooms,
      results: req.query.room ? viewResults : progress.results.filter((r) => r.room_id == null),
      allResults: progress.results,
      roomId,
      defects,
      severity: progress.severity,
    });
  } catch (error) {
    return next(error);
  }
}

async function setResult(req, res, next) {
  const id = parseId(req.params.id);
  const resultId = parseId(req.params.resultId);
  const result = String(req.body.result || '');
  const op = String(req.body.client_operation_id || '') || null;
  try {
    const out = await service.setResult(res.locals.user.id, id, resultId, result, op);
    if (out.error) {
      flash(req, 'error', 'Не удалось сохранить пункт.');
    }
    const room = req.body.room_id ? `?room=${req.body.room_id}` : '';
    if (result === 'DEFECT') {
      return res.redirect(303, `/inspection/runs/${id}/defects/new?result=${resultId}${room ? `&room=${req.body.room_id}` : ''}`);
    }
    return res.redirect(303, `/inspection/runs/${id}${room}`);
  } catch (error) {
    return next(error);
  }
}

async function defectNew(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const inspection = await service.getInspectionForUser(res.locals.user.id, id);
    if (!inspection) {
      return res.status(404).render('error', { title: 'Нет приёмки', message: 'Осмотр не найден.' });
    }
    const rooms = await service.listRooms(inspection.project_id);
    const templates = await service.defectTemplates();
    const resultId = parseId(req.query.result);
    const tplId = parseId(req.query.tpl);
    let preset = { room_id: parseId(req.query.room), checklist_item_id: null, item_result_id: resultId };
    let title = '';
    let description = '';
    if (resultId) {
      const results = await service.loadResults(id);
      const row = results.find((r) => r.id === resultId);
      if (row) {
        preset = {
          room_id: row.room_id,
          checklist_item_id: row.checklist_item_id,
          item_result_id: row.id,
        };
        title = row.title;
      }
    }
    if (tplId) {
      const tpl = templates.find((t) => t.id === tplId);
      if (tpl) {
        title = title || tpl.title;
        description = tpl.body;
      }
    }
    localsExtra(res);
    return res.render('inspection/defect-form', {
      title: 'Новый дефект',
      inspection,
      rooms,
      templates,
      errors: {},
      values: {
        title,
        description,
        severity: 'MINOR',
        room_id: preset.room_id ? String(preset.room_id) : '',
        location_description: '',
        checklist_item_id: preset.checklist_item_id || '',
        item_result_id: preset.item_result_id || '',
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function defectCreate(req, res, next) {
  const id = parseId(req.params.id);
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const severity = String(req.body.severity || 'MINOR');
  if (title.length < 2) {
    flash(req, 'error', 'Укажите заголовок замечания.');
    return res.redirect(303, `/inspection/runs/${id}/defects/new`);
  }
  if (!constants.SEVERITIES[severity]) {
    flash(req, 'error', 'Выберите критичность.');
    return res.redirect(303, `/inspection/runs/${id}/defects/new`);
  }
  try {
    const out = await service.createDefect(
      res.locals.user.id,
      id,
      {
        title,
        description,
        severity,
        room_id: parseId(req.body.room_id),
        checklist_item_id: parseId(req.body.checklist_item_id),
        item_result_id: parseId(req.body.item_result_id),
        location_description: String(req.body.location_description || '').trim(),
      },
      String(req.body.client_operation_id || '') || null
    );
    if (out.error) {
      flash(req, 'error', 'Не удалось создать дефект.');
      return res.redirect(303, `/inspection/runs/${id}`);
    }
    return res.redirect(303, `/inspection/defects/${out.defect.id}`);
  } catch (error) {
    return next(error);
  }
}

async function defectShow(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const defect = await service.getDefectForUser(res.locals.user.id, id);
    if (!defect) {
      return res.status(404).render('error', { title: 'Нет дефекта', message: 'Дефект не найден.' });
    }
    const photos = await service.listPhotos(id);
    const measurements = await service.listMeasurements(id);
    const inspection = await service.getInspectionForUser(res.locals.user.id, defect.inspection_id);
    localsExtra(res);
    return res.render('inspection/defect', {
      title: `Дефект № ${defect.id}`,
      defect,
      photos,
      measurements,
      inspection,
    });
  } catch (error) {
    return next(error);
  }
}

function receivePhoto(req, res, next) {
  upload.single('photo')(req, res, (error) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') {
      flash(req, 'error', 'Фото больше 5 МБ.');
      return res.redirect(303, `/inspection/defects/${req.params.id}`);
    }
    if (error) return next(error);
    return next();
  });
}

async function defectPhoto(req, res, next) {
  const id = parseId(req.params.id);
  if (!csrfOk(req)) return rejectCsrf(req, res);
  if (!req.file) {
    flash(req, 'error', 'Выберите JPEG, PNG или WebP.');
    return res.redirect(303, `/inspection/defects/${id}`);
  }
  try {
    const out = await service.addPhoto(
      res.locals.user.id,
      id,
      req.file.buffer,
      String(req.body.kind || 'OTHER'),
      String(req.body.client_operation_id || '') || null
    );
    if (out.error === 'INVALID_IMAGE') flash(req, 'error', 'Нужен файл JPEG, PNG или WebP.');
    else if (out.error === 'FILE_TOO_LARGE') flash(req, 'error', 'Фото больше 5 МБ.');
    else if (out.error) flash(req, 'error', 'Не удалось сохранить фото.');
    return res.redirect(303, `/inspection/defects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function defectMeasure(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const out = await service.addMeasurement(res.locals.user.id, id, {
      measure_type: String(req.body.measure_type || ''),
      value_numeric: req.body.value_numeric,
      unit: String(req.body.unit || ''),
      note: String(req.body.note || '').trim(),
    });
    if (out.error) flash(req, 'error', 'Проверьте тип, число и единицу замера.');
    return res.redirect(303, `/inspection/defects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function defectStatus(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const out = await service.setDefectStatus(res.locals.user.id, id, String(req.body.status || ''));
    if (out.error) flash(req, 'error', 'Недопустимый статус.');
    return res.redirect(303, `/inspection/defects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function showDefectPhoto(req, res, next) {
  const id = parseId(req.params.id);
  try {
    if (!res.locals.user) return res.status(404).end();
    const { rows } = await require('../db').pool.query(
      `SELECT ph.stored_name
       FROM defect_photos ph
       JOIN defects d ON d.id = ph.defect_id
       JOIN inspections i ON i.id = d.inspection_id
       JOIN inspection_projects p ON p.id = i.project_id
       WHERE ph.id = $1 AND p.owner_user_id = $2`,
      [id, res.locals.user.id]
    );
    if (!rows[0]) return res.status(404).end();
    const full = storage.resolveStored(rows[0].stored_name);
    if (!full) return res.status(404).end();
    return res.sendFile(full, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  } catch (error) {
    return next(error);
  }
}

async function review(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const inspection = await service.getInspectionForUser(res.locals.user.id, id);
    if (!inspection) {
      return res.status(404).render('error', { title: 'Нет приёмки', message: 'Осмотр не найден.' });
    }
    const progress = await service.progressFor(id);
    localsExtra(res);
    return res.render('inspection/review', {
      title: 'Завершение приёмки',
      inspection,
      progress: progress.overall,
      severity: progress.severity,
      defectsCount: progress.defectsCount,
    });
  } catch (error) {
    return next(error);
  }
}

async function complete(req, res, next) {
  const id = parseId(req.params.id);
  const force = req.body.force === '1';
  try {
    const out = await service.completeInspection(res.locals.user.id, id, { force });
    if (out.error === 'unchecked') {
      flash(req, 'error', `Осталось непроверенных пунктов: ${out.progress.unchecked}. Можно вернуться или завершить всё равно.`);
      return res.redirect(303, `/inspection/runs/${id}/review`);
    }
    if (out.error) {
      flash(req, 'error', 'Не удалось завершить.');
      return res.redirect(303, `/inspection/runs/${id}`);
    }
    return res.redirect(303, `/inspection/runs/${id}/summary`);
  } catch (error) {
    return next(error);
  }
}

async function summary(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const inspection = await service.getInspectionForUser(res.locals.user.id, id);
    if (!inspection) {
      return res.status(404).render('error', { title: 'Нет приёмки', message: 'Осмотр не найден.' });
    }
    const progress = await service.progressFor(id);
    const defects = await service.listDefects(id);
    const history = await service.getHistory(id);
    const reportVersion = await report.latestReportVersion(id);
    localsExtra(res);
    return res.render('inspection/summary', {
      title: 'Итоги приёмки',
      inspection,
      progress: progress.overall,
      severity: progress.severity,
      defects,
      history,
      reportVersion,
    });
  } catch (error) {
    return next(error);
  }
}

async function makeReport(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const inspection = await service.getInspectionForUser(res.locals.user.id, id);
    if (!inspection) {
      return res.status(404).render('error', { title: 'Нет приёмки', message: 'Осмотр не найден.' });
    }
    await report.generateReportVersion(inspection, res.locals.user);
    flash(req, 'ok', 'Отчёт сформирован (новая версия).');
    return res.redirect(303, `/inspection/runs/${id}/summary`);
  } catch (error) {
    return next(error);
  }
}

async function openReport(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const inspection = await service.getInspectionForUser(res.locals.user.id, id);
    if (!inspection) return res.status(404).end();
    const version = await report.latestReportVersion(id);
    if (!version) {
      flash(req, 'error', 'Сначала сформируйте отчёт.');
      return res.redirect(303, `/inspection/runs/${id}/summary`);
    }
    const full = storage.resolveReportKey(version.storage_key);
    if (!full) return res.status(404).end();
    if (version.format === 'pdf') {
      res.type('application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="naryad-inspection-${id}-v${version.version}.pdf"`);
    } else {
      res.type('html');
    }
    return res.sendFile(full);
  } catch (error) {
    return next(error);
  }
}

async function shareCreate(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const share = await service.createShare(res.locals.user.id, id, 14);
    if (!share) {
      return res.status(404).render('error', { title: 'Нет приёмки', message: 'Осмотр не найден.' });
    }
    flash(req, 'ok', `Ссылка: /inspection/share/${share.token}`);
    return res.redirect(303, `/inspection/runs/${id}/summary`);
  } catch (error) {
    return next(error);
  }
}

async function shareView(req, res, next) {
  try {
    const out = await service.getShare(String(req.params.token || ''));
    if (!out || out.error === 'revoked' || out.error === 'expired') {
      return res.status(404).render('error', {
        title: 'Ссылка недоступна',
        message: out && out.error === 'expired' ? 'Срок ссылки истёк.' : 'Ссылка отозвана или не существует.',
      });
    }
    const progress = await service.progressFor(out.share.inspection_id);
    const defects = await service.listDefects(out.share.inspection_id);
    localsExtra(res);
    return res.render('inspection/share', {
      title: 'Отчёт приёмки',
      share: out.share,
      progress: progress.overall,
      defects,
      severity: progress.severity,
    });
  } catch (error) {
    return next(error);
  }
}

async function followUp(req, res, next) {
  const id = parseId(req.params.id);
  try {
    const out = await service.createFollowUp(res.locals.user.id, id);
    if (out.error) {
      flash(req, 'error', 'Повторную проверку можно начать после завершения.');
      return res.redirect(303, `/inspection/runs/${id}/summary`);
    }
    return res.redirect(303, `/inspection/runs/${out.inspection.id}`);
  } catch (error) {
    return next(error);
  }
}

async function pause(req, res, next) {
  const id = parseId(req.params.id);
  try {
    await service.pauseInspection(res.locals.user.id, id);
    flash(req, 'ok', 'Приёмка на паузе. Можно продолжить позже.');
    return res.redirect(303, '/inspection');
  } catch (error) {
    return next(error);
  }
}

async function testPaymentWebhook(req, res) {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_PAYMENTS !== '1') {
    return res.status(404).json({ ok: false, error: 'disabled' });
  }
  const userId = parseId(req.body.user_id);
  const projectId = parseId(req.body.project_id);
  const eventId = String(req.body.provider_event_id || '');
  if (!userId || !projectId || !eventId) return res.status(400).json({ ok: false });
  const result = await processPaymentEvent({
    provider: 'test',
    providerEventId: eventId,
    userId,
    projectId,
    payload: req.body,
  });
  return res.json({ ok: true, ...result });
}

function mount(app) {
  app.get('/priemka', (req, res) => res.redirect(303, '/inspection'));
  app.get('/inspection', requireInspector, dashboard);
  app.get('/inspection/new', requireInspector, newForm);
  app.post('/inspection/projects', requireInspector, createProject);
  app.get('/inspection/projects/:id/paywall', requireInspector, paywall);
  app.post('/inspection/projects/:id/open', requireInspector, openUnpaid);
  app.get('/inspection/projects/:id', requireInspector, projectShow);
  app.post('/inspection/projects/:id/rooms', requireInspector, addRoom);
  app.post('/inspection/projects/:id/rooms/:roomId/delete', requireInspector, deleteRoom);
  app.post('/inspection/projects/:id/start', requireInspector, start);

  app.get('/inspection/runs/:id', requireInspector, runShow);
  app.post('/inspection/runs/:id/results/:resultId', requireInspector, setResult);
  app.get('/inspection/runs/:id/defects/new', requireInspector, defectNew);
  app.post('/inspection/runs/:id/defects', requireInspector, defectCreate);
  app.get('/inspection/runs/:id/review', requireInspector, review);
  app.post('/inspection/runs/:id/complete', requireInspector, complete);
  app.get('/inspection/runs/:id/summary', requireInspector, summary);
  app.post('/inspection/runs/:id/report', requireInspector, makeReport);
  app.get('/inspection/runs/:id/report', requireInspector, openReport);
  app.post('/inspection/runs/:id/share', requireInspector, shareCreate);
  app.post('/inspection/runs/:id/follow-up', requireInspector, followUp);
  app.post('/inspection/runs/:id/pause', requireInspector, pause);

  app.get('/inspection/defects/:id', requireInspector, defectShow);
  app.post('/inspection/defects/:id/photos', requireInspector, receivePhoto, defectPhoto);
  app.post('/inspection/defects/:id/measurements', requireInspector, defectMeasure);
  app.post('/inspection/defects/:id/status', requireInspector, defectStatus);
  app.get('/inspection/defect-photos/:id', requireInspector, showDefectPhoto);

  app.get('/inspection/share/:token', shareView);
  app.post('/inspection/test/payment-event', testPaymentWebhook);
}

module.exports = { mount };
