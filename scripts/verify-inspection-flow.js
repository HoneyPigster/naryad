const base = process.env.BASE_URL || 'http://127.0.0.1:3000';
const token = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
  console.log(`ok ${message}`);
}

function jar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = new Headers(opts.headers || {});
      if (cookies.size) {
        headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
      }
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const line of list) {
        const pair = line.split(';')[0];
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!value) cookies.delete(name);
        else cookies.set(name, value);
      }
      return res;
    },
  };
}

async function page(client, url, opts) {
  let current = new URL(url, base).toString();
  let res = await client.fetch(current, opts);
  for (let hop = 0; hop < 8 && [301, 302, 303, 307, 308].includes(res.status); hop += 1) {
    const loc = res.headers.get('location');
    assert(loc, `redirect from ${current}`);
    current = new URL(loc, current).toString();
    res = await client.fetch(current);
  }
  const body = await res.text();
  return { res, body, url: current };
}

function csrfOf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert(match, 'csrf token');
  return match[1];
}

let phoneSeq = 3000000 + Math.floor(Math.random() * 5000000);
function nextPhone() {
  phoneSeq += 1;
  return `7900${String(phoneSeq).slice(-7)}`;
}
function pretty(phone) {
  return `+7 ${phone.slice(1, 4)} ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9)}`;
}

async function register(name) {
  const client = jar();
  const phone = nextPhone();
  const first = await page(client, '/register/foreman');
  const body = new URLSearchParams({
    _csrf: csrfOf(first.body),
    role: 'foreman',
    specialty: 'plumber',
    full_name: name,
    phone: pretty(phone),
    password: 'parol-naryad-1',
  });
  const done = await page(client, '/register/foreman', { method: 'POST', body });
  assert(done.res.status === 200, 'registered');
  assert(done.body.includes(name) || done.url.includes('/foreman') || done.url.includes('/inspection'), 'cabinet');
  return { client, phone, name };
}

async function main() {
  const health = await fetch(`${base}/health`);
  assert((await health.text()) === 'ok', 'health');

  const landing = await (await fetch(`${base}/`)).text();
  assert(landing.includes('Приёмка'), 'landing has inspection');
  assert(landing.includes('990'), 'landing inspection price');

  const owner = await register(`Приёмка ${token}`);
  const stranger = await register(`Чужой ${token}`);

  const dash = await page(owner.client, '/inspection');
  assert(dash.body.includes('Мои приёмки'), 'dashboard');

  const form = await page(owner.client, '/inspection/new');
  const created = await page(owner.client, '/inspection/projects', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(form.body),
      title: `ЖК Тест ${token}`,
      address: `улица Приёмки ${token}, 1`,
      residential_complex: 'Тест',
      apartment_number: '12',
      area_m2: '45',
      property_type: 'APARTMENT',
      finish_type: 'FINISHED',
      developer: 'ТестСтрой',
    }),
  });
  assert(created.url.includes('/paywall'), 'paywall redirect');
  assert(created.body.includes('990'), 'paywall price');
  assert(created.body.includes('не списываются'), 'paywall honesty');

  const projectMatch = created.url.match(/\/inspection\/projects\/(\d+)/);
  assert(projectMatch, 'project id');
  const projectId = projectMatch[1];

  const openPost = await page(owner.client, `/inspection/projects/${projectId}/open`, {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(created.body),
      confirm_unpaid: '1',
    }),
  });
  assert(openPost.body.includes('Деньги не списаны') || openPost.body.includes('Помещения'), 'opened project');

  for (const [name, kind] of [
    ['Кухня', 'kitchen'],
    ['Коридор', 'hallway'],
    ['Санузел', 'wc'],
    ['Спальня', 'bedroom'],
  ]) {
    const proj = await page(owner.client, `/inspection/projects/${projectId}`);
    const add = await page(owner.client, `/inspection/projects/${projectId}/rooms`, {
      method: 'POST',
      body: new URLSearchParams({ _csrf: csrfOf(proj.body), name, kind }),
    });
    assert(add.body.includes(name), `room ${name}`);
  }

  const beforeStart = await page(owner.client, `/inspection/projects/${projectId}`);
  const started = await page(owner.client, `/inspection/projects/${projectId}/start`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(beforeStart.body) }),
  });
  const runMatch = started.url.match(/\/inspection\/runs\/(\d+)/);
  assert(runMatch, 'run started');
  const runId = runMatch[1];
  assert(started.body.includes('Осмотр') || started.body.includes('Прогресс'), 'run page');

  const resultMatch = started.body.match(/\/inspection\/runs\/\d+\/results\/(\d+)/);
  assert(resultMatch, 'has result action');
  const resultId = resultMatch[1];

  const okSet = await page(owner.client, `/inspection/runs/${runId}/results/${resultId}`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(started.body), result: 'OK' }),
  });
  assert(okSet.body.includes('Всё в порядке') || okSet.res.status === 200, 'set OK');

  const run2 = await page(owner.client, `/inspection/runs/${runId}`);
  const result2 = run2.body.match(/\/inspection\/runs\/\d+\/results\/(\d+)/);
  const defectKick = await page(owner.client, `/inspection/runs/${runId}/results/${result2[1]}`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(run2.body), result: 'DEFECT' }),
  });
  assert(defectKick.url.includes('/defects/new'), 'defect form');

  const defectCreated = await page(owner.client, `/inspection/runs/${runId}/defects`, {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(defectKick.body),
      title: `Царапина ${token}`,
      description: 'На раме окна царапина',
      severity: 'MAJOR',
      room_id: '',
      location_description: 'Левое окно',
      item_result_id: result2[1],
    }),
  });
  const defectMatch = defectCreated.url.match(/\/inspection\/defects\/(\d+)/);
  assert(defectMatch, 'defect created');
  const defectId = defectMatch[1];

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const defectPage = await page(owner.client, `/inspection/defects/${defectId}`);
  const upload = new FormData();
  upload.set('_csrf', csrfOf(defectPage.body));
  upload.set('kind', 'CLOSEUP');
  upload.set('photo', new Blob([png], { type: 'image/png' }), 'x.png');
  const uploaded = await page(owner.client, `/inspection/defects/${defectId}/photos`, {
    method: 'POST',
    body: upload,
  });
  assert(uploaded.body.includes('/inspection/defect-photos/'), 'photo rendered');

  const measured = await page(owner.client, `/inspection/defects/${defectId}/measurements`, {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(uploaded.body),
      measure_type: 'LENGTH',
      value_numeric: '120',
      unit: 'mm',
      note: 'длина царапины',
    }),
  });
  assert(measured.body.includes('120'), 'measurement saved');

  // more defects quickly
  for (let i = 0; i < 4; i += 1) {
    const run = await page(owner.client, `/inspection/runs/${runId}/defects/new`);
    const d = await page(owner.client, `/inspection/runs/${runId}/defects`, {
      method: 'POST',
      body: new URLSearchParams({
        _csrf: csrfOf(run.body),
        title: `Дефект ${i} ${token}`,
        description: `описание ${i}`,
        severity: i === 0 ? 'CRITICAL' : 'MINOR',
        room_id: '',
        location_description: '',
      }),
    });
    assert(d.url.includes('/defects/'), `defect ${i}`);
  }

  const review = await page(owner.client, `/inspection/runs/${runId}/review`);
  assert(review.body.includes('непроверенными') || review.body.includes('Заверш'), 'review');

  const completed = await page(owner.client, `/inspection/runs/${runId}/complete`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(review.body), force: '1' }),
  });
  assert(completed.url.includes('/summary'), 'summary');
  assert(completed.body.includes('Итоги') || completed.body.includes('Сводка'), 'summary copy');

  const reported = await page(owner.client, `/inspection/runs/${runId}/report`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(completed.body) }),
  });
  assert(reported.body.includes('Отчёт') || reported.body.includes('Версия'), 'report version');

  const reportGet = await owner.client.fetch(new URL(`/inspection/runs/${runId}/report`, base));
  assert(reportGet.status === 200, 'report http');
  const ctype = reportGet.headers.get('content-type') || '';
  assert(ctype.includes('pdf') || ctype.includes('html'), 'report content type');
  const reportBuf = Buffer.from(await reportGet.arrayBuffer());
  assert(reportBuf.length > 100, 'report body');
  if (ctype.includes('pdf')) {
    assert(reportBuf.slice(0, 4).toString() === '%PDF', 'pdf magic');
  } else {
    assert(reportBuf.toString('utf8').includes('Дефект'), 'report content');
  }

  const shared = await page(owner.client, `/inspection/runs/${runId}/share`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(reported.body) }),
  });
  const shareMatch = shared.body.match(/\/inspection\/share\/([a-f0-9]+)/);
  assert(shareMatch, 'share token');
  const sharePage = await page(jar(), `/inspection/share/${shareMatch[1]}`);
  assert(sharePage.body.includes('Общий доступ') || sharePage.body.includes('просмотр'), 'share view');

  const forbidden = await stranger.client.fetch(new URL(`/inspection/runs/${runId}`, base));
  const forbiddenBody = await forbidden.text();
  assert(forbidden.status === 404 || forbiddenBody.includes('не найден'), 'idor run blocked');

  const forbiddenPhoto = await stranger.client.fetch(
    new URL(uploaded.body.match(/src="(\/inspection\/defect-photos\/\d+)"/)[1], base)
  );
  assert(forbiddenPhoto.status === 404, 'idor photo blocked');

  const follow = await page(owner.client, `/inspection/runs/${runId}/follow-up`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(shared.body) }),
  });
  assert(follow.url.includes('/inspection/runs/'), 'follow-up started');

  // payment idempotency (test provider)
  const eventId = `evt-${token}`;
  const pay1 = await fetch(`${base}/inspection/test/payment-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_id: '1',
      project_id: projectId,
      provider_event_id: eventId,
    }),
  });
  const pay1json = await pay1.json();
  const pay2 = await fetch(`${base}/inspection/test/payment-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_id: '1',
      project_id: projectId,
      provider_event_id: eventId,
    }),
  });
  const pay2json = await pay2.json();
  assert(pay1json.ok && pay2json.ok, 'payment endpoint');
  assert(pay2json.duplicate === true, 'payment idempotent');

  console.log('INSPECTION FLOW OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
