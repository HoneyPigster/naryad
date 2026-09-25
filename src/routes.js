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
  parseDateInput,
  parseTimeInput,
  monthKey,
  parseMonthKey,
  shiftMonth,
  daysInMonth,
  addMonthsToDate,
  formatMonthTitle,
  dateKey,
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

function askedRole(req) {
  const role = req.params.role || '';
  return role === 'foreman' || role === 'master' || role === 'inspector' ? role : '';
}

function roleTitle(role, kind) {
  if (role === 'foreman') return kind === 'login' ? 'Вход прораба' : 'Регистрация прораба';
  if (role === 'master') return kind === 'login' ? 'Вход мастера' : 'Регистрация мастера';
  if (role === 'inspector') return kind === 'login' ? 'Вход в приёмку' : 'Регистрация для приёмки';
  return kind === 'login' ? 'Вход' : 'Регистрация';
}

function showLogin(res, role, errors, values) {
  if (!role) return render(res, 'login-choose', { title: 'Вход', errors });
  return render(res, 'login-role', {
    title: roleTitle(role, 'login'),
    role,
    errors,
    values,
  });
}

function showRegister(res, values, errors) {
  const role =
    values.role === 'foreman' || values.role === 'master' || values.role === 'inspector'
      ? values.role
      : '';
  if (!role) return render(res, 'register-choose', { title: 'Регистрация', errors });
  return render(res, 'register-role', {
    title: roleTitle(role, 'register'),
    errors,
    values,
  });
}

function safeNext(raw) {
  const value = String(raw || '').trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if (value.startsWith('/login') || value.startsWith('/register')) return null;
  return value;
}

function loginForm(req, res) {
  if (res.locals.user) {
    const next = safeNext(req.query.next);
    return res.redirect(303, next || homeFor(res.locals.user.role));
  }
  if (req.params.role && !askedRole(req)) return res.redirect(303, '/login');
  const role = askedRole(req);
  return showLogin(res, role, {}, {
    phone: String(req.query.phone || '').trim(),
    next: safeNext(req.query.next) || '',
  });
}

async function loginPost(req, res, next) {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  const values = {
    phone: String(req.body.phone || '').trim(),
    next: safeNext(req.body.next) || '',
  };
  const role =
    askedRole(req) ||
    (req.body.role === 'foreman' || req.body.role === 'master' || req.body.role === 'inspector'
      ? req.body.role
      : '');
  const key = loginKey(phone || values.phone, req);
  if (tooManyLogins(key)) {
    return showLogin(res, role, { form: 'Слишком много попыток. Подождите четверть часа.' }, values);
  }
  if (!phone || !password) {
    markLoginFail(key);
    return showLogin(res, role, { form: 'Неверный телефон или пароль.' }, values);
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
      return showLogin(res, role, { form: 'Неверный телефон или пароль.' }, values);
    }
    if (role && user.role !== role) {
      const labels = { foreman: 'прораба', master: 'мастера', inspector: 'приёмки', client: 'клиента' };
      return showLogin(
        res,
        role,
        {
          form: `Этот телефон зарегистрирован для ${labels[user.role] || 'другого кабинета'}. Выберите свой вход.`,
        },
        values
      );
    }
    clearLoginFail(key);
    const dest = values.next || homeFor(user.role);
    return startSession(req, res, next, user.id, dest);
  } catch (error) {
    return next(error);
  }
}

function registerForm(req, res) {
  if (res.locals.user) return res.redirect(303, homeFor(res.locals.user.role));
  if (
    !req.params.role &&
    (req.query.role === 'foreman' || req.query.role === 'master' || req.query.role === 'inspector')
  ) {
    return res.redirect(303, `/register/${req.query.role}`);
  }
  if (req.params.role && !askedRole(req)) return res.redirect(303, '/register');
  const role = askedRole(req);
  if (!role) return render(res, 'register-choose', { title: 'Регистрация', errors: {} });
  return showRegister(res, { full_name: '', phone: '', role, specialty: 'plumber' }, {});
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
  if (!['foreman', 'master', 'inspector'].includes(role)) {
    errors.role = 'Выберите роль: прораб, мастер или приёмка.';
  }
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
    return showRegister(res, parsed.values, parsed.errors);
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
      return showRegister(res, parsed.values, { phone: 'Этот телефон уже зарегистрирован.' });
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

async function clientList(req, res) {
  return render(res, 'client/closed', { title: 'Кабинет закрыт' });
}

async function clientListUnused(req, res, next) {
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
    const { rows } = await pool.query(
      `SELECT id FROM objects
       WHERE foreman_id = $1
       ORDER BY CASE WHEN status = 'done' THEN 1 ELSE 0 END, created_at DESC
       LIMIT 1`,
      [res.locals.user.id]
    );
    if (!rows[0]) {
      return render(res, 'foreman/paywall', {
        title: 'Квартира',
        errors: {},
        values: { request_id: '', address: '', client_name: '', client_phone: '', confirm_unpaid: false },
        price: PRICES.objectRub,
        cabinet: true,
      });
    }
    return res.redirect(303, `/foreman/objects/${rows[0].id}`);
  } catch (error) {
    return next(error);
  }
}

function readTask(body) {
  const specialty = String(body.specialty || '');
  const address = String(body.address || '').trim();
  const summary = String(body.summary || '').trim();
  const errors = {};
  if (!SPECIALTIES[specialty]) errors.specialty = 'Выберите специальность мастера.';
  if (address.length < 5 || address.length > 200) errors.address = 'Укажите адрес.';
  if (summary.length < 5 || summary.length > 500) errors.summary = 'Опишите, что сделать: от 5 до 500 символов.';
  if (body.confirm_unpaid !== '1') errors.confirm_unpaid = 'Подтвердите, что ставите задачу без оплаты. Деньги не списываются.';
  return {
    errors,
    values: {
      specialty: specialty || 'plumber',
      address,
      summary,
      confirm_unpaid: body.confirm_unpaid === '1',
    },
  };
}

function taskForm(req, res) {
  return render(res, 'foreman/task-new', {
    title: 'Новая задача',
    errors: {},
    values: { specialty: 'plumber', address: '', summary: '', confirm_unpaid: false },
    price: PRICES.objectRub,
  });
}

async function createTask(req, res, next) {
  const parsed = readTask(req.body);
  if (Object.keys(parsed.errors).length) {
    return render(res, 'foreman/task-new', {
      title: 'Новая задача',
      errors: parsed.errors,
      values: parsed.values,
      price: PRICES.objectRub,
    });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (foreman_id, specialty, address, summary)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [res.locals.user.id, parsed.values.specialty, parsed.values.address, parsed.values.summary]
    );
    flash(req, 'ok', 'Задача поставлена. Деньги не списаны.');
    return res.redirect(303, `/foreman/tasks/${rows[0].id}`);
  } catch (error) {
    return next(error);
  }
}

async function foremanTask(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render('error', { title: 'Нет задачи', message: 'Задача не найдена.' });
  try {
    const task = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND foreman_id = $2',
      [id, res.locals.user.id]
    );
    if (!task.rows[0]) {
      return res.status(404).render('error', { title: 'Нет задачи', message: 'Задача не найдена.' });
    }
    const responses = await pool.query(
      `SELECT u.full_name, u.phone, u.specialty, r.created_at
       FROM task_responses r
       JOIN users u ON u.id = r.master_id
       WHERE r.task_id = $1
       ORDER BY r.created_at`,
      [id]
    );
    return render(res, 'foreman/task', {
      title: 'Задача',
      task: task.rows[0],
      responses: responses.rows,
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
    confirm_unpaid: req.body.confirm_unpaid === '1',
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
    const others = await pool.query(
      `SELECT id, address, status FROM objects
       WHERE foreman_id = $1 AND id <> $2
       ORDER BY created_at DESC`,
      [res.locals.user.id, id]
    );
    const primary = await pool.query(
      `SELECT id FROM objects
       WHERE foreman_id = $1
       ORDER BY CASE WHEN status = 'done' THEN 1 ELSE 0 END, created_at DESC
       LIMIT 1`,
      [res.locals.user.id]
    );
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
      others: others.rows,
      isPrimary: primary.rows[0] && primary.rows[0].id === id,
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
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const month = parseMonthKey(req.query.month) || monthKey(today);
  const day = parseDateInput(req.query.day) || todayIso;
  const [y, m] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  try {
    let incoming = [];
    if (user.orders_opened_unpaid && user.accepting_orders) {
      const { rows } = await pool.query(
        `SELECT id, address, summary, created_at, object_id, contact_name
         FROM offers
         WHERE status = 'open' AND specialty = $1
         ORDER BY created_at DESC`,
        [user.specialty]
      );
      incoming = rows;
    }
    const mine = await pool.query(
      `SELECT id, address, summary, status, job_status, status_note, accepted_at,
              contact_name, contact_phone
       FROM offers
       WHERE master_id = $1 AND status = 'accepted'
       ORDER BY accepted_at DESC`,
      [user.id]
    );
    const bookingsMonth = await pool.query(
      `SELECT id, client_name, client_phone, address, summary, visit_on, visit_time, status
       FROM master_bookings
       WHERE master_id = $1 AND visit_on >= $2::date AND visit_on <= $3::date
         AND status <> 'cancelled'
       ORDER BY visit_on, visit_time NULLS LAST, id`,
      [user.id, monthStart, monthEnd]
    );
    const dayBookings = await pool.query(
      `SELECT id, client_name, client_phone, address, summary, visit_on, visit_time, status
       FROM master_bookings
       WHERE master_id = $1 AND visit_on = $2::date AND status <> 'cancelled'
       ORDER BY visit_time NULLS LAST, id`,
      [user.id, day]
    );
    const guarantees = await pool.query(
      `SELECT id, client_name, work_title, address, months, started_on, ends_on, note,
              (ends_on >= CURRENT_DATE) AS active
       FROM master_guarantees
       WHERE master_id = $1
       ORDER BY ends_on DESC, id DESC
       LIMIT 40`,
      [user.id]
    );
    const dues = await pool.query(
      `SELECT id, client_name, title, amount_rub, settled, created_at
       FROM master_client_dues
       WHERE master_id = $1
       ORDER BY settled ASC, created_at DESC
       LIMIT 50`,
      [user.id]
    );
    const dueTotal = dues.rows
      .filter((row) => !row.settled)
      .reduce((sum, row) => sum + Number(row.amount_rub || 0), 0);
    const countsByDay = {};
    bookingsMonth.rows.forEach((row) => {
      const key = dateKey(row.visit_on);
      countsByDay[key] = (countsByDay[key] || 0) + 1;
    });
    const calendarDays = [];
    const firstWeekday = new Date(y, m - 1, 1).getDay();
    const offset = (firstWeekday + 6) % 7; // Monday-first
    for (let i = 0; i < offset; i += 1) calendarDays.push(null);
    const total = daysInMonth(month);
    for (let d = 1; d <= total; d += 1) {
      const iso = `${month}-${String(d).padStart(2, '0')}`;
      calendarDays.push({
        day: d,
        iso,
        count: countsByDay[iso] || 0,
        isToday: iso === todayIso,
        isSelected: iso === day,
      });
    }
    return render(res, 'master/home', {
      title: user.full_name,
      incoming,
      mine: mine.rows,
      price: PRICES.masterMonthRub,
      offerLabel,
      month,
      monthTitle: formatMonthTitle(month),
      prevMonth: shiftMonth(month, -1),
      nextMonth: shiftMonth(month, 1),
      day,
      calendarDays,
      dayBookings: dayBookings.rows,
      guarantees: guarantees.rows,
      dues: dues.rows,
      dueTotal,
      bookingValues: {
        visit_on: day,
        visit_time: '',
        client_name: '',
        client_phone: '',
        address: '',
        summary: '',
      },
      guaranteeValues: {
        client_name: '',
        work_title: '',
        address: '',
        months: '12',
        started_on: todayIso,
        note: '',
      },
      dueValues: {
        client_name: '',
        title: '',
        amount_rub: '',
      },
      bookingErrors: {},
      guaranteeErrors: {},
      dueErrors: {},
    });
  } catch (error) {
    return next(error);
  }
}

function bookingFromBody(body) {
  const visitOn = parseDateInput(body.visit_on);
  const visitTime = parseTimeInput(body.visit_time);
  const clientName = String(body.client_name || '').trim();
  const phoneRaw = String(body.client_phone || '').trim();
  const phone = phoneRaw ? normalizePhone(phoneRaw) : '';
  const address = String(body.address || '').trim();
  const summary = String(body.summary || '').trim();
  const errors = {};
  if (!visitOn) errors.visit_on = 'Укажите дату заявки.';
  if (body.visit_time && !visitTime) errors.visit_time = 'Время в формате ЧЧ:ММ.';
  if (clientName.length < 2) errors.client_name = 'Укажите имя клиента.';
  if (phoneRaw && !phone) errors.client_phone = 'Проверьте телефон.';
  if (summary.length < 3) errors.summary = 'Кратко опишите работу.';
  return {
    values: {
      visit_on: visitOn || String(body.visit_on || ''),
      visit_time: visitTime || '',
      client_name: clientName,
      client_phone: phoneRaw,
      address,
      summary,
    },
    data: visitOn && clientName.length >= 2 && summary.length >= 3 && (!phoneRaw || phone)
      ? {
          visit_on: visitOn,
          visit_time: visitTime,
          client_name: clientName,
          client_phone: phone || '',
          address,
          summary,
        }
      : null,
    errors,
  };
}

async function masterCreateBooking(req, res, next) {
  if (!csrfOk(req)) return rejectCsrf(req, res);
  const parsed = bookingFromBody(req.body || {});
  if (!parsed.data) {
    flash(req, 'error', Object.values(parsed.errors)[0] || 'Проверьте заявку.');
    return res.redirect(303, `/master?day=${encodeURIComponent(parsed.values.visit_on || '')}#bookings`);
  }
  try {
    await pool.query(
      `INSERT INTO master_bookings
         (master_id, client_name, client_phone, address, summary, visit_on, visit_time)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::time)`,
      [
        res.locals.user.id,
        parsed.data.client_name,
        parsed.data.client_phone,
        parsed.data.address,
        parsed.data.summary,
        parsed.data.visit_on,
        parsed.data.visit_time,
      ]
    );
    flash(req, 'ok', 'Заявка добавлена в календарь.');
    return res.redirect(303, `/master?month=${parsed.data.visit_on.slice(0, 7)}&day=${parsed.data.visit_on}#bookings`);
  } catch (error) {
    return next(error);
  }
}

async function masterBookingStatus(req, res, next) {
  if (!csrfOk(req)) return rejectCsrf(req, res);
  const id = parseId(req.params.id);
  const status = String(req.body.status || '');
  if (!id || !['planned', 'done', 'cancelled'].includes(status)) {
    return res.redirect(303, '/master#bookings');
  }
  try {
    await pool.query(
      `UPDATE master_bookings
       SET status = $1, updated_at = now()
       WHERE id = $2 AND master_id = $3`,
      [status, id, res.locals.user.id]
    );
    flash(req, 'ok', status === 'cancelled' ? 'Заявка отменена.' : 'Статус заявки обновлён.');
    return res.redirect(303, '/master#bookings');
  } catch (error) {
    return next(error);
  }
}

async function masterCreateGuarantee(req, res, next) {
  if (!csrfOk(req)) return rejectCsrf(req, res);
  const clientName = String(req.body.client_name || '').trim();
  const workTitle = String(req.body.work_title || '').trim();
  const address = String(req.body.address || '').trim();
  const startedOn = parseDateInput(req.body.started_on);
  const months = parseId(req.body.months);
  const note = String(req.body.note || '').trim();
  if (clientName.length < 2 || workTitle.length < 2 || !startedOn || !months || months > 120) {
    flash(req, 'error', 'Проверьте поля гарантии.');
    return res.redirect(303, '/master#guarantees');
  }
  try {
    const endsOn = addMonthsToDate(startedOn, months);
    await pool.query(
      `INSERT INTO master_guarantees
         (master_id, client_name, work_title, address, months, started_on, ends_on, note)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8)`,
      [res.locals.user.id, clientName, workTitle, address, months, startedOn, endsOn, note]
    );
    flash(req, 'ok', 'Гарантия добавлена.');
    return res.redirect(303, '/master#guarantees');
  } catch (error) {
    return next(error);
  }
}

async function masterDeleteGuarantee(req, res, next) {
  if (!csrfOk(req)) return rejectCsrf(req, res);
  const id = parseId(req.params.id);
  if (!id) return res.redirect(303, '/master#guarantees');
  try {
    await pool.query(
      `DELETE FROM master_guarantees WHERE id = $1 AND master_id = $2`,
      [id, res.locals.user.id]
    );
    flash(req, 'ok', 'Гарантия удалена.');
    return res.redirect(303, '/master#guarantees');
  } catch (error) {
    return next(error);
  }
}

async function masterCreateDue(req, res, next) {
  if (!csrfOk(req)) return rejectCsrf(req, res);
  const clientName = String(req.body.client_name || '').trim();
  const title = String(req.body.title || '').trim();
  const amount = parseAmount(req.body.amount_rub);
  if (clientName.length < 2 || title.length < 2 || amount === null || amount < 1) {
    flash(req, 'error', 'Укажите клиента, за что и сумму.');
    return res.redirect(303, '/master#dues');
  }
  try {
    await pool.query(
      `INSERT INTO master_client_dues (master_id, client_name, title, amount_rub)
       VALUES ($1, $2, $3, $4)`,
      [res.locals.user.id, clientName, title, amount]
    );
    flash(req, 'ok', 'Долг клиента добавлен.');
    return res.redirect(303, '/master#dues');
  } catch (error) {
    return next(error);
  }
}

async function masterSettleDue(req, res, next) {
  if (!csrfOk(req)) return rejectCsrf(req, res);
  const id = parseId(req.params.id);
  const settled = String(req.body.settled || '') === '1';
  if (!id) return res.redirect(303, '/master#dues');
  try {
    await pool.query(
      `UPDATE master_client_dues
       SET settled = $1
       WHERE id = $2 AND master_id = $3`,
      [settled, id, res.locals.user.id]
    );
    flash(req, 'ok', settled ? 'Доплата закрыта.' : 'Снова в долге.');
    return res.redirect(303, '/master#dues');
  } catch (error) {
    return next(error);
  }
}

async function masterDeleteDue(req, res, next) {
  if (!csrfOk(req)) return rejectCsrf(req, res);
  const id = parseId(req.params.id);
  if (!id) return res.redirect(303, '/master#dues');
  try {
    await pool.query(
      `DELETE FROM master_client_dues WHERE id = $1 AND master_id = $2`,
      [id, res.locals.user.id]
    );
    flash(req, 'ok', 'Запись удалена.');
    return res.redirect(303, '/master#dues');
  } catch (error) {
    return next(error);
  }
}

async function masterTask(req, res, next) {
  const id = parseId(req.params.id);
  const user = res.locals.user;
  if (!id) return res.status(404).render('error', { title: 'Нет задачи', message: 'Задача не найдена.' });
  try {
    const { rows } = await pool.query(
      `SELECT t.*, u.full_name AS foreman_name, u.phone AS foreman_phone,
              EXISTS (
                SELECT 1 FROM task_responses r WHERE r.task_id = t.id AND r.master_id = $2
              ) AS responded
       FROM tasks t
       JOIN users u ON u.id = t.foreman_id
       WHERE t.id = $1`,
      [id, user.id]
    );
    const task = rows[0];
    if (!task || task.specialty !== user.specialty) {
      return res.status(404).render('error', { title: 'Нет задачи', message: 'Задача не найдена.' });
    }
    if (!task.responded && (!user.orders_opened_unpaid || !user.accepting_orders)) {
      return res.redirect(303, '/master/subscription');
    }
    return render(res, 'master/task', { title: 'Задача', task });
  } catch (error) {
    return next(error);
  }
}

async function masterRespond(req, res, next) {
  const id = parseId(req.params.id);
  const user = res.locals.user;
  if (!id) return res.status(404).render('error', { title: 'Нет задачи', message: 'Задача не найдена.' });
  if (!user.orders_opened_unpaid || !user.accepting_orders) {
    flash(req, 'error', 'Чтобы откликнуться, откройте входящие и включите приём. Деньги не списываются.');
    return res.redirect(303, '/master/subscription');
  }
  try {
    const inserted = await pool.query(
      `INSERT INTO task_responses (task_id, master_id)
       SELECT t.id, $2
       FROM tasks t
       WHERE t.id = $1 AND t.specialty = $3
         AND NOT EXISTS (
           SELECT 1 FROM task_responses r WHERE r.task_id = t.id AND r.master_id = $2
         )
       RETURNING id`,
      [id, user.id, user.specialty]
    );
    if (!inserted.rowCount) {
      const exists = await pool.query(
        `SELECT 1 FROM task_responses WHERE task_id = $1 AND master_id = $2`,
        [id, user.id]
      );
      if (!exists.rowCount) {
        return res.status(404).render('error', { title: 'Нет задачи', message: 'Задача не найдена.' });
      }
    }
    flash(req, 'ok', 'Отклик отправлен. Деньги не списаны.');
    return res.redirect(303, `/master/tasks/${id}`);
  } catch (error) {
    return next(error);
  }
}

function masterPaywall(req, res) {
  return render(res, 'master/paywall', {
    title: 'Входящие',
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
  const accepting = req.body.accepting_orders === '1';
  try {
    if (!res.locals.user.orders_opened_unpaid && accepting) {
      await pool.query(
        'UPDATE users SET orders_opened_unpaid = TRUE, accepting_orders = TRUE WHERE id = $1 AND role = $2',
        [res.locals.user.id, 'master']
      );
      flash(req, 'ok', 'Приём включён. Деньги не списаны.');
      return res.redirect(303, '/master');
    }
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
  app.get('/login/:role', loginForm);
  app.post('/login', loginPost);
  app.post('/login/:role', loginPost);
  app.get('/register', registerForm);
  app.get('/register/:role', registerForm);
  app.post('/register', registerPost);
  app.post('/register/:role', registerPost);
  app.post('/logout', logout);

  app.get('/client', requireRole('client'), clientList);
  app.get('/client/requests/new', requireRole('client'), clientNew);
  app.post('/client/requests', requireRole('client'), clientCreate);
  app.get('/client/requests/:id', requireRole('client'), clientShow);
  app.post('/client/requests/:id/cancel', requireRole('client'), clientCancel);

  app.get('/foreman', requireRole('foreman'), foremanHome);
  app.get('/foreman/tasks/new', requireRole('foreman'), taskForm);
  app.post('/foreman/tasks', requireRole('foreman'), createTask);
  app.get('/foreman/tasks/:id', requireRole('foreman'), foremanTask);
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
  app.post('/master/bookings', requireRole('master'), masterCreateBooking);
  app.post('/master/bookings/:id/status', requireRole('master'), masterBookingStatus);
  app.post('/master/guarantees', requireRole('master'), masterCreateGuarantee);
  app.post('/master/guarantees/:id/delete', requireRole('master'), masterDeleteGuarantee);
  app.post('/master/dues', requireRole('master'), masterCreateDue);
  app.post('/master/dues/:id/settle', requireRole('master'), masterSettleDue);
  app.post('/master/dues/:id/delete', requireRole('master'), masterDeleteDue);
  app.get('/master/tasks/:id', requireRole('master'), masterTask);
  app.post('/master/tasks/:id/respond', requireRole('master'), masterRespond);
  app.get('/master/subscription', requireRole('master'), masterPaywall);
  app.post('/master/subscription/open', requireRole('master'), masterOpenUnpaid);
  app.post('/master/accepting', requireRole('master'), masterAccepting);
  app.get('/master/offers/:id', requireRole('master'), masterOffer);
  app.post('/master/offers/:id/accept', requireRole('master'), masterAccept);
  app.post('/master/offers/:id/status', requireRole('master'), masterJobStatus);

  app.get('/photos/:id', showPhoto);
}

module.exports = { mount, photoDir };
