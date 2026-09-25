const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { HOME, ROLES } = require('./text');

const loginAttempts = new Map();

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'local';
}

function tooManyLogins(key) {
  const now = Date.now();
  const row = loginAttempts.get(key);
  if (!row || row.reset < now) return false;
  return row.count >= 8;
}

function markLoginFail(key) {
  const now = Date.now();
  const row = loginAttempts.get(key);
  if (!row || row.reset < now) {
    loginAttempts.set(key, { count: 1, reset: now + 15 * 60 * 1000 });
    return;
  }
  row.count += 1;
}

function clearLoginFail(key) {
  loginAttempts.delete(key);
}

async function loadUser(req, res, next) {
  res.locals.user = null;
  if (!req.session || !req.session.userId) return next();
  try {
    const { rows } = await pool.query(
      `SELECT id, role, full_name, phone, specialty, accepting_orders, orders_opened_unpaid
       FROM users WHERE id = $1`,
      [req.session.userId]
    );
    res.locals.user = rows[0] || null;
    if (!rows[0]) {
      req.session.userId = null;
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = res.locals.user;
    if (!user) return res.redirect(303, '/login');
    if (!roles.includes(user.role)) {
      return res.status(403).render('error', {
        title: 'Нет доступа',
        message: 'Этот кабинет для другой роли. Выйдите и войдите под нужным телефоном.',
      });
    }
    return next();
  };
}

function ensureCsrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  next();
}

function csrfOk(req) {
  const sent = req.body && req.body._csrf;
  return Boolean(req.session && req.session.csrf && sent === req.session.csrf);
}

function rejectCsrf(req, res) {
  return res.status(403).render('error', {
    title: 'Форма устарела',
    message: 'Обновите страницу и отправьте форму ещё раз.',
  });
}

function checkCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const type = req.headers['content-type'] || '';
  if (type.includes('multipart/form-data')) return next();
  if (!csrfOk(req)) return rejectCsrf(req, res);
  return next();
}

function flash(req, type, text) {
  req.session.flash = { type, text };
}

function takeFlash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
}

function homeFor(role) {
  return HOME[role] || '/';
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function loginKey(phone, req) {
  return `${phone || 'none'}|${clientIp(req)}`;
}

module.exports = {
  loadUser,
  requireRole,
  ensureCsrf,
  csrfOk,
  rejectCsrf,
  checkCsrf,
  flash,
  takeFlash,
  homeFor,
  hashPassword,
  checkPassword,
  tooManyLogins,
  markLoginFail,
  clearLoginFail,
  loginKey,
  ROLES,
};
