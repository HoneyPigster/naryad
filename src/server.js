const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool, migrate } = require('./db');
const { mount } = require('./routes');
const { photoDir } = require('./routes');
const {
  loadUser,
  ensureCsrf,
  checkCsrf,
  takeFlash,
} = require('./mw');
const {
  formatPhone,
  formatMoney,
  formatDate,
  ROLES,
  KINDS,
  SPECIALTIES,
  REQUEST_STATUS,
  STAGE_STATUS,
  ROOMS,
  HOME,
  PRICES,
} = require('./text');

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('В production нужен SESSION_SECRET');
  }
  return 'dev-only-secret';
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
    );
    next();
  });

  app.get('/health', (req, res) => {
    res.type('text/plain').send('ok');
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use(
    session({
      store: new PgSession({
        pool,
        createTableIfMissing: true,
      }),
      name: 'connect.sid',
      secret: sessionSecret(),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === '1',
        maxAge: 14 * 24 * 60 * 60 * 1000,
        path: '/',
      },
    })
  );

  app.use((req, res, next) => {
    res.locals.formatPhone = formatPhone;
    res.locals.formatMoney = formatMoney;
    res.locals.formatDate = formatDate;
    res.locals.ROLES = ROLES;
    res.locals.KINDS = KINDS;
    res.locals.SPECIALTIES = SPECIALTIES;
    res.locals.REQUEST_STATUS = REQUEST_STATUS;
    res.locals.STAGE_STATUS = STAGE_STATUS;
    res.locals.ROOMS = ROOMS;
    res.locals.HOME = HOME;
    res.locals.PRICES = PRICES;
    next();
  });
  app.use(takeFlash);
  app.use(loadUser);
  app.use(ensureCsrf);
  app.use(checkCsrf);

  mount(app);

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Нет страницы',
      message: 'Такой страницы нет.',
    });
  });

  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    res.status(500);
    try {
      res.render('error', {
        title: 'Ошибка',
        message: 'Не получилось выполнить действие. Попробуйте ещё раз.',
      });
    } catch (renderError) {
      console.error(renderError);
      res.type('text/plain').send('Не получилось выполнить действие.');
    }
  });

  return app;
}

async function start() {
  await fsMkdir();
  await migrate();
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, '0.0.0.0', () => {
    console.log(`naryad listening on ${port}`);
  });
}

async function fsMkdir() {
  const fs = require('fs');
  await fs.promises.mkdir(photoDir, { recursive: true });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createApp, start };
