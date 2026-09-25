const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { pool, withTx } = require('./db');
const {
  requireRole,
  csrfOk,
  rejectCsrf,
  flash,
  homeFor,
  hashPassword,
  checkPassword,
  tooManyLogins,
  markLoginFail,
  clearLoginFail,
  loginKey,
} = require('./mw');
const {
  PRICES,
  KINDS,
  SPECIALTIES,
  ROOMS,
  REQUEST_STATUS,
  normalizePhone,
  formatPhone,
  parseId,
  parseAmount,
  offerLabel,
} = require('./text');

const photoDir = process.env.PHOTO_DIR || path.join(process.cwd(), 'data', 'photos');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function render(res, view, data) {
  res.render(view, data);
}

function startSession(req, res, next, userId, location) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    return req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      return res.redirect(303, location);
    });
  });
}

async function publicHome(req, res) {
  if (res.locals.user) return res.redirect(303, homeFor(res.locals.user.role));
  return render(res, 'home', { title: 'Заявки на ремонт' });
}

function loginForm(req, res) {
  if (res.locals.user) return res.redirect(303, homeFor(res.locals.user.role));
  return render(res, 'login', { title: 'Вход', errors: {}, values: { phone: '' } });
}

async function loginPost(req, res, next) {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  const values = { phone: String(req.body.phone || '').trim() };
  const key = loginKey(phone || values.phone, req);
  if (tooManyLogins(key)) {
    return render(res, 'login', {
      title: 'Вход',
      errors: { form: 'Слишком много попыток. Подождите четверть часа.' },
      values,
    });
  }
  if (!phone || !password) {
    markLoginFail(key);
    return render(res, 'login', {
      title: 'Вход',
      errors: { form: 'Неверный телефон или пароль.' },
      values,
    });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, role, password_hash FROM users WHERE phone = $1',
      [phone]
    );
    const user = rows[0];
    const ok = user && (await checkPassword(password, user.password_hash));
    if (!ok) {
      markLoginFail(key);
      return render(res, 'login', {
        title: 'Вход',
        errors: { form: 'Неверный телефон или пароль.' },
        values,
      });
    }
    clearLoginFail(key);
    return startSession(req, res, next, user.id, homeFor(user.role));
  } catch (error) {
    return next(error);
  }
}

function registerForm(req, res) {
  if (res.locals.user) return res.redirect(303, homeFor(res.locals.user.role));
  return render(res, 'register', {
    title: 'Регистрация',
    errors: {},
    values: { full_name: '', phone: '', role: 'client', specialty: 'plumber' },
  });
}

function readAccount(body) {
  const errors = {};
  const fullName = String(body.full_name || '').trim().replace(/\s+/g, ' ');
  const phoneRaw = String(body.phone || '').trim();
  const phone = normalizePhone(phoneRaw);
  const password = String(body.password || '');
  const role = String(body.role || '');
  const specialty = String(body.specialty || '');
  if (fullName.length < 2 || fullName.length > 80) errors.full_name = 'Имя — от 2 до 80 символов.';
  if (!phone) errors.phone = 'Телефон в формате +7 900 000-00-00.';
  if (password.length < 8 || password.length > 72) errors.password = 'Пароль не короче 8 символов.';
  if (!['client', 'foreman', 'master'].includes(role)) errors.role = 'Выберите роль.';
  if (role === 'master' && !SPECIALTIES[specialty]) errors.specialty = 'Выберите специальность.';
  return {
    errors,
    values: { full_name: fullName, phone: phoneRaw, role, specialty: specialty || 'plumber' },
    data: {
      fullName,
      phone,
      password,
      role,
      specialty: role === 'master' ? specialty : null,
    },
  };
}

async function registerPost(req, res, next) {
  const parsed = readAccount(req.body);
  if (Object.keys(parsed.errors).length) {
    return render(res, 'register', { title: 'Регистрация', errors: parsed.errors, values: parsed.values });
  }
  try {
    const passwordHash = await hashPassword(parsed.data.password);
    const { rows } = await pool.query(
      `INSERT INTO users (role, full_name, phone, password_hash, specialty)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, role`,
      [parsed.data.role, parsed.data.fullName, parsed.data.phone, passwordHash, parsed.data.specialty]
    );
    const user = rows[0];
    return startSession(req, res, next, user.id, homeFor(user.role));
  } catch (error) {
    if (error.code === '23505') {
      return render(res, 'register', {
        title: 'Регистрация',
        errors: { phone: 'Этот телефон уже зарегистрирован.' },
        values: parsed.values,
      });
    }
    return next(error);
  }
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie('connect.sid', { path: '/' });
    res.redirect(303, '/');
  });
}

async function clientList(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id, kind, address, status, created_at
       FROM requests WHERE client_id = $1
       ORDER BY created_at DESC`,
      [res.locals.user.id]
    );
    return render(res, 'client/list', { title: 'Заявки', requests: rows });
  } catch (error) {
    return next(error);
  }
}

function clientNew(req, res) {
  return render(res, 'client/form', {
    title: 'Новая заявка',
    errors: {},
    values: { kind: 'apartment', address: '', description: '' },
  });
}

async function clientCreate(req, res, next) {
  const kind = String(req.body.kind || '');
  const address = String(req.body.address || '').trim();
  const description = String(req.body.description || '').trim();
  const errors = {};
  if (!KINDS[kind]) errors.kind = 'Выберите тип заявки.';
  if (address.length < 5 || address.length > 200) errors.address = 'Укажите адрес: улица, дом, квартира.';
  if (description.length < 10 || description.length > 2000) {
    errors.description = 'Опишите задачу хотя бы в нескольких словах.';
  }
  const values = { kind, address, description };
  if (Object.keys(errors).length) {
    return render(res, 'client/form', { title: 'Новая заявка', errors, values });
  }
  try {
    const requestId = await withTx(async (client) => {
      const status = kind === 'apartment' ? 'new' : 'offered';
      const note = kind === 'apartment' ? '' : 'Заявка предложена мастерам этой специальности.';
      const inserted = await client.query(
        `INSERT INTO requests (client_id, kind, address, description, status, status_note)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [res.locals.user.id, kind, address, description, status, note]
      );
      const id = inserted.rows[0].id;
      if (kind !== 'apartment') {
        await client.query(
          `INSERT INTO offers
            (specialty, request_id, summary, address, contact_name, contact_phone, status, job_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'open', 'pending')`,
          [kind, id, description, address, res.locals.user.full_name, res.locals.user.phone]
        );
      }
      return id;
    });
    return res.redirect(303, `/client/requests/${requestId}`);
  } catch (error) {
    return next(error);
  }
}

async function clientShow(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render('error', { title: 'Нет заявки', message: 'Заявка не найдена.' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM requests WHERE id = $1 AND client_id = $2',
      [id, res.locals.user.id]
    );
    const request = rows[0];
    if (!request) return res.status(404).render('error', { title: 'Нет заявки', message: 'Заявка не найдена.' });
    const offers = await pool.query(
      `SELECT o.*, m.full_name AS master_name, m.phone AS master_phone
       FROM offers o
       LEFT JOIN users m ON m.id = o.master_id
       WHERE o.request_id = $1
       ORDER BY o.created_at`,
      [id]
    );
    return render(res, 'client/show', {
      title: `Заявка № ${request.id}`,
      request,
      offers: offers.rows,
      offerLabel,
      statusLabel: REQUEST_STATUS[request.status] || request.status,
    });
  } catch (error) {
    return next(error);
  }
}

async function clientCancel(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render('error', { title: 'Нет заявки', message: 'Заявка не найдена.' });
  try {
    const result = await withTx(async (client) => {
      const current = await client.query(
        'SELECT id, status FROM requests WHERE id = $1 AND client_id = $2 FOR UPDATE',
        [id, res.locals.user.id]
      );
      const request = current.rows[0];
      if (!request) return 'missing';
      if (!['new', 'offered'].includes(request.status)) return 'locked';
      const taken = await client.query(
        `SELECT 1 FROM offers WHERE request_id = $1 AND status = 'accepted' LIMIT 1`,
        [id]
      );
      if (taken.rowCount) return 'locked';
      await client.query(
        `UPDATE requests
         SET status = 'cancelled', status_note = 'Клиент отменил заявку.', updated_at = now()
         WHERE id = $1`,
        [id]
      );
      await client.query(
        `UPDATE offers SET status = 'cancelled', job_status = 'pending'
         WHERE request_id = $1 AND status = 'open'`,
        [id]
      );
      return 'ok';
    });
    if (result === 'missing') {
      return res.status(404).render('error', { title: 'Нет заявки', message: 'Заявка не найдена.' });
    }
    if (result === 'locked') {
      flash(req, 'error', 'Эту заявку уже нельзя отменить.');
    }
    return res.redirect(303, `/client/requests/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function foremanHome(req, res, next) {
  try {
    const openRequests = await pool.query(
      `SELECT r.id, r.address, r.description, r.created_at, u.full_name, u.phone
       FROM requests r
       JOIN users u ON u.id = r.client_id
       WHERE r.kind = 'apartment' AND r.status = 'new'
         AND NOT EXISTS (SELECT 1 FROM objects o WHERE o.request_id = r.id)
       ORDER BY r.created_at DESC`
    );
    const objects = await pool.query(
      `SELECT o.id, o.address, o.client_name, o.status, o.created_at,
              COALESCE((
                SELECT SUM(p.amount_rub) FROM purchases p
                WHERE p.object_id = o.id AND p.charged_to_client AND NOT p.settled
              ), 0)::int AS debt
       FROM objects o
       WHERE o.foreman_id = $1
       ORDER BY o.created_at DESC`,
      [res.locals.user.id]
    );
    return render(res, 'foreman/home', {
      title: 'Объекты',
      openRequests: openRequests.rows,
      objects: objects.rows,
      price: PRICES.objectRub,
    });
  } catch (error) {
    return next(error);
  }
}

async function foremanPaywall(req, res, next) {
  const requestId = parseId(req.query.request);
  const values = {
    request_id: requestId ? String(requestId) : '',
    address: '',
    client_name: '',
    client_phone: '',
  };
  try {
    if (requestId) {
      const { rows } = await pool.query(
        `SELECT r.id, r.address, r.status, r.kind, u.full_name, u.phone
         FROM requests r
         JOIN users u ON u.id = r.client_id
         WHERE r.id = $1`,
        [requestId]
      );
      const request = rows[0];
      if (!request || request.kind !== 'apartment' || request.status !== 'new') {
        return res.status(404).render('error', {
          title: 'Нет заявки',
          message: 'Эту заявку уже нельзя взять в объект.',
        });
      }
      const taken = await pool.query('SELECT 1 FROM objects WHERE request_id = $1', [requestId]);
      if (taken.rowCount) {
        return res.status(404).render('error', {
          title: 'Нет заявки',
          message: 'Эту заявку уже взял другой прораб.',
        });
      }
      values.address = request.address;
      values.client_name = request.full_name;
      values.client_phone = formatPhone(request.phone);
    }
    return render(res, 'foreman/paywall', {
      title: 'Новый объект',
      errors: {},
      values,
      price: PRICES.objectRub,
    });
  } catch (error) {
    return next(error);
  }
}

async function foremanCreateObject(req, res, next) {
  const requestId = parseId(req.body.request_id);
  const address = String(req.body.address || '').trim();
  const clientName = String(req.body.client_name || '').trim().replace(/\s+/g, ' ');
  const phoneRaw = String(req.body.client_phone || '').trim();
  const phone = normalizePhone(phoneRaw);
  const confirm = req.body.confirm_unpaid === '1';
  const errors = {};
  if (!confirm) errors.confirm_unpaid = 'Подтвердите, что открываете объект без оплаты. Деньги не списываются.';
  if (address.length < 5 || address.length > 200) errors.address = 'Укажите адрес квартиры.';
  if (clientName.length < 2 || clientName.length > 80) errors.client_name = 'Укажите, как зовут клиента.';
  if (!phone) errors.client_phone = 'Телефон клиента в формате +7 900 000-00-00.';
  const values = {
    request_id: requestId ? String(requestId) : '',
    address,
    client_name: clientName,
    client_phone: phoneRaw,
  };
  if (Object.keys(errors).length) {
    return render(res, 'foreman/paywall', { title: 'Новый объект', errors, values, price: PRICES.objectRub });
  }
  try {
    const objectId = await withTx(async (client) => {
      let linkedId = null;
      if (requestId) {
        const current = await client.query(
          `SELECT id, kind, status FROM requests WHERE id = $1 FOR UPDATE`,
          [requestId]
        );
        const request = current.rows[0];
        if (!request || request.kind !== 'apartment' || request.status !== 'new') {
          const err = new Error('request-taken');
          err.code = 'REQUEST_TAKEN';
          throw err;
        }
        const exists = await client.query('SELECT 1 FROM objects WHERE request_id = $1', [requestId]);
        if (exists.rowCount) {
          const err = new Error('request-taken');
          err.code = 'REQUEST_TAKEN';
          throw err;
        }
        linkedId = requestId;
      }
      const inserted = await client.query(
        `INSERT INTO objects (foreman_id, request_id, address, client_name, client_phone, opened_unpaid)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id`,
        [res.locals.user.id, linkedId, address, clientName, phone]
      );
      const id = inserted.rows[0].id;
      if (linkedId) {
        await client.query(
          `UPDATE requests
           SET status = 'in_progress',
               status_note = 'Прораб ведёт объект. Оплата сервису не проводилась.',
               updated_at = now()
           WHERE id = $1`,
          [linkedId]
        );
      }
      return id;
    });
    return res.redirect(303, `/foreman/objects/${objectId}`);
  } catch (error) {
    if (error.code === 'REQUEST_TAKEN' || error.code === '23505') {
      return render(res, 'foreman/paywall', {
        title: 'Новый объект',
        errors: { form: 'Эту заявку уже взял другой прораб.' },
        values,
        price: PRICES.objectRub,
      });
    }
    return next(error);
  }
}

async function loadOwnedObject(userId, objectId) {
  const { rows } = await pool.query(
    'SELECT * FROM objects WHERE id = $1 AND foreman_id = $2',
    [objectId, userId]
  );
  return rows[0] || null;
}

async function foremanObject(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
  try {
    const object = await loadOwnedObject(res.locals.user.id, id);
    if (!object) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
    const [stages, purchases, counts, photos, offers, debtRow] = await Promise.all([
      pool.query(
        'SELECT * FROM stages WHERE object_id = $1 ORDER BY sort_order, id',
        [id]
      ),
      pool.query(
        'SELECT * FROM purchases WHERE object_id = $1 ORDER BY created_at, id',
        [id]
      ),
      pool.query(
        'SELECT room, COUNT(*)::int AS n FROM photos WHERE object_id = $1 GROUP BY room',
        [id]
      ),
      pool.query(
        'SELECT * FROM photos WHERE object_id = $1 AND room = $2 ORDER BY created_at DESC',
        [id, ROOMS[req.query.room] ? req.query.room : 'kitchen']
      ),
      pool.query(
        `SELECT o.*, m.full_name AS master_name, m.phone AS master_phone
         FROM offers o
         LEFT JOIN users m ON m.id = o.master_id
         WHERE o.object_id = $1
         ORDER BY o.created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount_rub), 0)::int AS debt
         FROM purchases
         WHERE object_id = $1 AND charged_to_client AND NOT settled`,
        [id]
      ),
    ]);
    const room = ROOMS[req.query.room] ? req.query.room : 'kitchen';
    const roomCounts = Object.fromEntries(counts.rows.map((row) => [row.room, row.n]));
    let linked = null;
    if (object.request_id) {
      const linkedRow = await pool.query(
        'SELECT status, status_note FROM requests WHERE id = $1',
        [object.request_id]
      );
      linked = linkedRow.rows[0] || null;
    }
    return render(res, 'foreman/object', {
      title: `Объект № ${object.id}`,
      object,
      linked,
      stages: stages.rows,
      purchases: purchases.rows,
      photos: photos.rows,
      offers: offers.rows,
      debt: debtRow.rows[0].debt,
      room,
      roomCounts,
      price: PRICES.objectRub,
      offerLabel,
    });
  } catch (error) {
    return next(error);
  }
}

async function addStage(req, res, next) {
  const id = parseId(req.params.id);
  const title = String(req.body.title || '').trim();
  if (!id) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
  if (title.length < 2 || title.length > 120) {
    flash(req, 'error', 'Название этапа — от 2 до 120 символов.');
    return res.redirect(303, `/foreman/objects/${id}`);
  }
  try {
    const object = await loadOwnedObject(res.locals.user.id, id);
    if (!object) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
    await pool.query(
      `INSERT INTO stages (object_id, title, sort_order)
       VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM stages WHERE object_id = $1), 0))`,
      [id, title]
    );
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function updateStage(req, res, next) {
  const id = parseId(req.params.id);
  const stageId = parseId(req.params.stageId);
  const status = String(req.body.status || '');
  if (!id || !stageId) return res.status(404).render('error', { title: 'Нет этапа', message: 'Этап не найден.' });
  if (!['planned', 'in_progress', 'done'].includes(status)) {
    flash(req, 'error', 'Неизвестный статус этапа.');
    return res.redirect(303, `/foreman/objects/${id}`);
  }
  try {
    const result = await pool.query(
      `UPDATE stages s SET status = $1
       FROM objects o
       WHERE s.id = $2 AND s.object_id = o.id AND o.id = $3 AND o.foreman_id = $4`,
      [status, stageId, id, res.locals.user.id]
    );
    if (!result.rowCount) return res.status(404).render('error', { title: 'Нет этапа', message: 'Этап не найден.' });
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function deleteStage(req, res, next) {
  const id = parseId(req.params.id);
  const stageId = parseId(req.params.stageId);
  if (!id || !stageId) return res.status(404).render('error', { title: 'Нет этапа', message: 'Этап не найден.' });
  try {
    await pool.query(
      `DELETE FROM stages s USING objects o
       WHERE s.id = $1 AND s.object_id = o.id AND o.id = $2 AND o.foreman_id = $3`,
      [stageId, id, res.locals.user.id]
    );
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function addPurchase(req, res, next) {
  const id = parseId(req.params.id);
  const title = String(req.body.title || '').trim();
  const amount = parseAmount(req.body.amount_rub);
  const charged = req.body.charged_to_client === '1';
  if (!id) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
  if (title.length < 2 || title.length > 160 || amount === null) {
    flash(req, 'error', 'Укажите название закупки и сумму в рублях.');
    return res.redirect(303, `/foreman/objects/${id}`);
  }
  try {
    const object = await loadOwnedObject(res.locals.user.id, id);
    if (!object) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
    await pool.query(
      `INSERT INTO purchases (object_id, title, amount_rub, charged_to_client)
       VALUES ($1, $2, $3, $4)`,
      [id, title, amount, charged]
    );
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function settlePurchase(req, res, next) {
  const id = parseId(req.params.id);
  const purchaseId = parseId(req.params.purchaseId);
  const settled = req.body.settled === '1';
  if (!id || !purchaseId) return res.status(404).render('error', { title: 'Нет закупки', message: 'Закупка не найдена.' });
  try {
    await pool.query(
      `UPDATE purchases p SET settled = $1
       FROM objects o
       WHERE p.id = $2 AND p.object_id = o.id AND o.id = $3 AND o.foreman_id = $4`,
      [settled, purchaseId, id, res.locals.user.id]
    );
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function deletePurchase(req, res, next) {
  const id = parseId(req.params.id);
  const purchaseId = parseId(req.params.purchaseId);
  if (!id || !purchaseId) return res.status(404).render('error', { title: 'Нет закупки', message: 'Закупка не найдена.' });
  try {
    await pool.query(
      `DELETE FROM purchases p USING objects o
       WHERE p.id = $1 AND p.object_id = o.id AND o.id = $2 AND o.foreman_id = $3`,
      [purchaseId, id, res.locals.user.id]
    );
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

function receivePhoto(req, res, next) {
  upload.single('photo')(req, res, (error) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') {
      const id = parseId(req.params.id);
      flash(req, 'error', 'Фото больше 5 МБ.');
      return res.redirect(303, `/foreman/objects/${id || ''}`);
    }
    if (error) return next(error);
    return next();
  });
}

async function addPhoto(req, res, next) {
  const id = parseId(req.params.id);
  if (!csrfOk(req)) return rejectCsrf(req, res);
  const room = String(req.body.room || '');
  if (!id || !ROOMS[room]) {
    return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
  }
  if (!req.file) {
    flash(req, 'error', 'Выберите файл JPEG, PNG или WebP.');
    return res.redirect(303, `/foreman/objects/${id}?room=${room}`);
  }
  const ext = sniffImage(req.file.buffer);
  if (!ext) {
    flash(req, 'error', 'Нужен файл JPEG, PNG или WebP.');
    return res.redirect(303, `/foreman/objects/${id}?room=${room}`);
  }
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  try {
    const object = await loadOwnedObject(res.locals.user.id, id);
    if (!object) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
    await fs.promises.mkdir(photoDir, { recursive: true });
    await fs.promises.writeFile(path.join(photoDir, storedName), req.file.buffer);
    try {
      await pool.query(
        'INSERT INTO photos (object_id, room, stored_name) VALUES ($1, $2, $3)',
        [id, room, storedName]
      );
    } catch (error) {
      await fs.promises.unlink(path.join(photoDir, storedName)).catch(() => {});
      throw error;
    }
    return res.redirect(303, `/foreman/objects/${id}?room=${room}`);
  } catch (error) {
    return next(error);
  }
}

async function deletePhoto(req, res, next) {
  const id = parseId(req.params.id);
  const photoId = parseId(req.params.photoId);
  if (!id || !photoId) return res.status(404).render('error', { title: 'Нет фото', message: 'Фото не найдено.' });
  try {
    const { rows } = await pool.query(
      `DELETE FROM photos p USING objects o
       WHERE p.id = $1 AND p.object_id = o.id AND o.id = $2 AND o.foreman_id = $3
       RETURNING p.stored_name, p.room`,
      [photoId, id, res.locals.user.id]
    );
    if (rows[0]) {
      await fs.promises.unlink(path.join(photoDir, path.basename(rows[0].stored_name))).catch(() => {});
      return res.redirect(303, `/foreman/objects/${id}?room=${rows[0].room}`);
    }
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function showPhoto(req, res, next) {
  const id = parseId(req.params.id);
  if (!id || !res.locals.user) return res.status(404).end();
  try {
    const { rows } = await pool.query(
      `SELECT p.stored_name
       FROM photos p
       JOIN objects o ON o.id = p.object_id
       WHERE p.id = $1 AND o.foreman_id = $2`,
      [id, res.locals.user.id]
    );
    if (!rows[0]) return res.status(404).end();
    const stored = path.basename(rows[0].stored_name);
    const root = path.resolve(photoDir);
    const filePath = path.resolve(root, stored);
    if (filePath !== path.join(root, stored)) return res.status(404).end();
    return res.sendFile(filePath, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  } catch (error) {
    return next(error);
  }
}

async function createOffer(req, res, next) {
  const id = parseId(req.params.id);
  const specialty = String(req.body.specialty || '');
  const summary = String(req.body.summary || '').trim();
  if (!id) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
  if (!SPECIALTIES[specialty] || summary.length < 5 || summary.length > 2000) {
    flash(req, 'error', 'Выберите специальность и коротко напишите, что сделать.');
    return res.redirect(303, `/foreman/objects/${id}`);
  }
  try {
    const created = await withTx(async (client) => {
      const objectRow = await client.query(
        'SELECT * FROM objects WHERE id = $1 AND foreman_id = $2 FOR UPDATE',
        [id, res.locals.user.id]
      );
      const object = objectRow.rows[0];
      if (!object) return 'missing';
      const dup = await client.query(
        `SELECT 1 FROM offers
         WHERE object_id = $1 AND specialty = $2 AND status = 'open' LIMIT 1`,
        [id, specialty]
      );
      if (dup.rowCount) return 'dup';
      await client.query(
        `INSERT INTO offers
          (specialty, request_id, object_id, summary, address, contact_name, contact_phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [specialty, object.request_id, object.id, summary, object.address, object.client_name, object.client_phone]
      );
      if (object.request_id) {
        await client.query(
          `UPDATE requests
           SET status_note = $2, updated_at = now()
           WHERE id = $1 AND status <> 'cancelled'`,
          [object.request_id, `Прораб вызвал мастера: ${SPECIALTIES[specialty]}.`]
        );
      }
      return 'ok';
    });
    if (created === 'missing') {
      return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
    }
    if (created === 'dup') flash(req, 'error', 'Такой вызов уже открыт.');
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function cancelOffer(req, res, next) {
  const id = parseId(req.params.id);
  const offerId = parseId(req.params.offerId);
  if (!id || !offerId) return res.status(404).render('error', { title: 'Нет вызова', message: 'Вызов не найден.' });
  try {
    await pool.query(
      `UPDATE offers o SET status = 'cancelled'
       FROM objects b
       WHERE o.id = $1 AND o.object_id = b.id AND b.id = $2 AND b.foreman_id = $3 AND o.status = 'open'`,
      [offerId, id, res.locals.user.id]
    );
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function finishObject(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
  try {
    await withTx(async (client) => {
      const updated = await client.query(
        `UPDATE objects SET status = 'done'
         WHERE id = $1 AND foreman_id = $2
         RETURNING request_id`,
        [id, res.locals.user.id]
      );
      const requestId = updated.rows[0] && updated.rows[0].request_id;
      if (requestId) {
        await client.query(
          `UPDATE requests
           SET status = 'done', status_note = 'Прораб отметил объект готовым.', updated_at = now()
           WHERE id = $1`,
          [requestId]
        );
      }
    });
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function saveObjectNote(req, res, next) {
  const id = parseId(req.params.id);
  const note = String(req.body.status_note || '').trim();
  if (!id) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
  if (note.length > 500) {
    flash(req, 'error', 'Заметка к статусу — до 500 символов.');
    return res.redirect(303, `/foreman/objects/${id}`);
  }
  try {
    const object = await loadOwnedObject(res.locals.user.id, id);
    if (!object) return res.status(404).render('error', { title: 'Нет объекта', message: 'Объект не найден.' });
    if (!object.request_id) {
      flash(req, 'error', 'У этого объекта нет заявки клиента — заметку к статусу сохранять некуда.');
      return res.redirect(303, `/foreman/objects/${id}`);
    }
    await pool.query(
      'UPDATE requests SET status_note = $2, updated_at = now() WHERE id = $1',
      [object.request_id, note]
    );
    flash(req, 'ok', 'Заметка к статусу сохранена. Её видит клиент.');
    return res.redirect(303, `/foreman/objects/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function masterHome(req, res, next) {
  const user = res.locals.user;
  try {
    let incoming = [];
    if (user.orders_opened_unpaid && user.accepting_orders) {
      const { rows } = await pool.query(
        `SELECT id, address, summary, created_at, object_id, request_id
         FROM offers
         WHERE status = 'open' AND specialty = $1
         ORDER BY created_at DESC`,
        [user.specialty]
      );
      incoming = rows;
    }
    const mine = await pool.query(
      `SELECT id, address, summary, status, job_status, accepted_at, specialty
       FROM offers
       WHERE master_id = $1 AND status = 'accepted'
       ORDER BY accepted_at DESC`,
      [user.id]
    );
    return render(res, 'master/home', {
      title: 'Заказы',
      incoming,
      mine: mine.rows,
      price: PRICES.masterMonthRub,
      offerLabel,
    });
  } catch (error) {
    return next(error);
  }
}

function masterPaywall(req, res) {
  return render(res, 'master/paywall', {
    title: 'Входящие заказы',
    price: PRICES.masterMonthRub,
    opened: res.locals.user.orders_opened_unpaid,
  });
}

async function masterOpenUnpaid(req, res, next) {
  if (req.body.confirm_unpaid !== '1') {
    flash(req, 'error', 'Подтвердите, что открываете входящие без оплаты.');
    return res.redirect(303, '/master/subscription');
  }
  try {
    await pool.query(
      'UPDATE users SET orders_opened_unpaid = TRUE WHERE id = $1 AND role = $2',
      [res.locals.user.id, 'master']
    );
    return res.redirect(303, '/master');
  } catch (error) {
    return next(error);
  }
}

async function masterAccepting(req, res, next) {
  if (!res.locals.user.orders_opened_unpaid) {
    flash(req, 'error', 'Сначала откройте входящие. Оплата при этом не проводится.');
    return res.redirect(303, '/master/subscription');
  }
  const accepting = req.body.accepting_orders === '1';
  try {
    await pool.query('UPDATE users SET accepting_orders = $2 WHERE id = $1', [
      res.locals.user.id,
      accepting,
    ]);
    return res.redirect(303, '/master');
  } catch (error) {
    return next(error);
  }
}

async function masterOffer(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render('error', { title: 'Нет заказа', message: 'Заказ не найден.' });
  const user = res.locals.user;
  try {
    const { rows } = await pool.query(
      `SELECT o.*, m.full_name AS master_name
       FROM offers o
       LEFT JOIN users m ON m.id = o.master_id
       WHERE o.id = $1`,
      [id]
    );
    const offer = rows[0];
    const visible =
      offer &&
      ((offer.master_id === user.id && offer.status === 'accepted') ||
        (offer.status === 'open' && offer.specialty === user.specialty));
    if (!visible) return res.status(404).render('error', { title: 'Нет заказа', message: 'Заказ не найден.' });
    if (offer.status === 'open' && (!user.orders_opened_unpaid || !user.accepting_orders)) {
      return res.redirect(303, '/master/subscription');
    }
    return render(res, 'master/offer', { title: 'Заказ', offer, offerLabel });
  } catch (error) {
    return next(error);
  }
}

async function masterAccept(req, res, next) {
  const id = parseId(req.params.id);
  const user = res.locals.user;
  if (!id) return res.status(404).render('error', { title: 'Нет заказа', message: 'Заказ не найден.' });
  if (!user.orders_opened_unpaid || !user.accepting_orders) {
    flash(req, 'error', 'Чтобы принять заказ, откройте входящие и включите приём. Деньги не списываются.');
    return res.redirect(303, '/master/subscription');
  }
  try {
    const result = await withTx(async (client) => {
      const updated = await client.query(
        `UPDATE offers
         SET status = 'accepted',
             job_status = 'accepted',
             master_id = $1,
             accepted_at = now(),
             status_note = $2
         WHERE id = $3 AND status = 'open' AND specialty = $4
         RETURNING id, request_id, object_id`,
        [user.id, `Мастер ${user.full_name} принял заказ.`, id, user.specialty]
      );
      const offer = updated.rows[0];
      if (!offer) return null;
      if (offer.request_id) {
        const current = await client.query('SELECT kind, status FROM requests WHERE id = $1 FOR UPDATE', [
          offer.request_id,
        ]);
        const request = current.rows[0];
        if (request && request.status !== 'cancelled' && request.status !== 'done') {
          const nextStatus = request.kind === 'apartment' ? 'in_progress' : 'accepted';
          await client.query(
            `UPDATE requests
             SET status = $2,
                 status_note = $3,
                 updated_at = now()
             WHERE id = $1`,
            [offer.request_id, nextStatus, `Мастер ${user.full_name} принял заказ.`]
          );
        }
      }
      return offer;
    });
    if (!result) {
      flash(req, 'error', 'Этот заказ уже забрали.');
      return res.redirect(303, '/master');
    }
    return res.redirect(303, `/master/offers/${id}`);
  } catch (error) {
    return next(error);
  }
}

async function masterJobStatus(req, res, next) {
  const id = parseId(req.params.id);
  const jobStatus = String(req.body.job_status || '');
  const note = String(req.body.status_note || '').trim();
  if (!id) return res.status(404).render('error', { title: 'Нет заказа', message: 'Заказ не найден.' });
  if (!['accepted', 'in_progress', 'done'].includes(jobStatus)) {
    flash(req, 'error', 'Выберите статус работы.');
    return res.redirect(303, `/master/offers/${id}`);
  }
  if (note.length > 500) {
    flash(req, 'error', 'Заметка к статусу — до 500 символов.');
    return res.redirect(303, `/master/offers/${id}`);
  }
  try {
    const updated = await withTx(async (client) => {
      const result = await client.query(
        `UPDATE offers
         SET job_status = $2, status_note = $3
         WHERE id = $1 AND master_id = $4 AND status = 'accepted'
         RETURNING request_id`,
        [id, jobStatus, note, res.locals.user.id]
      );
      const offer = result.rows[0];
      if (!offer) return null;
      if (offer.request_id) {
        const current = await client.query('SELECT kind, status FROM requests WHERE id = $1', [offer.request_id]);
        const request = current.rows[0];
        const noteText =
          note ||
          (jobStatus === 'done'
            ? 'Мастер отметил работу готовой.'
            : jobStatus === 'in_progress'
              ? 'Мастер ведёт работу.'
              : 'Мастер принял заказ.');
        if (request && request.kind !== 'apartment' && request.status !== 'cancelled') {
          const requestStatus =
            jobStatus === 'done' ? 'done' : jobStatus === 'in_progress' ? 'in_progress' : 'accepted';
          await client.query(
            `UPDATE requests SET status = $2, status_note = $3, updated_at = now() WHERE id = $1`,
            [offer.request_id, requestStatus, noteText]
          );
        } else if (request && request.status !== 'cancelled' && request.status !== 'done') {
          await client.query(
            'UPDATE requests SET status_note = $2, updated_at = now() WHERE id = $1',
            [offer.request_id, noteText]
          );
        }
      }
      return offer;
    });
    if (!updated) return res.status(404).render('error', { title: 'Нет заказа', message: 'Заказ не найден.' });
    return res.redirect(303, `/master/offers/${id}`);
  } catch (error) {
    return next(error);
  }
}

function mount(app) {
  app.get('/', publicHome);
  app.get('/login', loginForm);
  app.post('/login', loginPost);
  app.get('/register', registerForm);
  app.post('/register', registerPost);
  app.post('/logout', logout);

  app.get('/client', requireRole('client'), clientList);
  app.get('/client/requests/new', requireRole('client'), clientNew);
  app.post('/client/requests', requireRole('client'), clientCreate);
  app.get('/client/requests/:id', requireRole('client'), clientShow);
  app.post('/client/requests/:id/cancel', requireRole('client'), clientCancel);

  app.get('/foreman', requireRole('foreman'), foremanHome);
  app.get('/foreman/objects/new', requireRole('foreman'), foremanPaywall);
  app.post('/foreman/objects', requireRole('foreman'), foremanCreateObject);
  app.get('/foreman/objects/:id', requireRole('foreman'), foremanObject);
  app.post('/foreman/objects/:id/stages', requireRole('foreman'), addStage);
  app.post('/foreman/objects/:id/stages/:stageId', requireRole('foreman'), updateStage);
  app.post('/foreman/objects/:id/stages/:stageId/delete', requireRole('foreman'), deleteStage);
  app.post('/foreman/objects/:id/purchases', requireRole('foreman'), addPurchase);
  app.post('/foreman/objects/:id/purchases/:purchaseId', requireRole('foreman'), settlePurchase);
  app.post('/foreman/objects/:id/purchases/:purchaseId/delete', requireRole('foreman'), deletePurchase);
  app.post('/foreman/objects/:id/photos', requireRole('foreman'), receivePhoto, addPhoto);
  app.post('/foreman/objects/:id/photos/:photoId/delete', requireRole('foreman'), deletePhoto);
  app.post('/foreman/objects/:id/offers', requireRole('foreman'), createOffer);
  app.post('/foreman/objects/:id/offers/:offerId/cancel', requireRole('foreman'), cancelOffer);
  app.post('/foreman/objects/:id/done', requireRole('foreman'), finishObject);
  app.post('/foreman/objects/:id/note', requireRole('foreman'), saveObjectNote);

  app.get('/master', requireRole('master'), masterHome);
  app.get('/master/subscription', requireRole('master'), masterPaywall);
  app.post('/master/subscription/open', requireRole('master'), masterOpenUnpaid);
  app.post('/master/accepting', requireRole('master'), masterAccepting);
  app.get('/master/offers/:id', requireRole('master'), masterOffer);
  app.post('/master/offers/:id/accept', requireRole('master'), masterAccept);
  app.post('/master/offers/:id/status', requireRole('master'), masterJobStatus);

  app.get('/photos/:id', showPhoto);
}

module.exports = { mount, photoDir };
