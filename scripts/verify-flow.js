const base = process.env.BASE_URL || 'http://127.0.0.1:3000';
const token = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const address = `проезд Нарядный ${token}, кв. 8`;
const summary = `заменить смеситель ${token}`;
const purchase = `Смеситель ${token}`;
const stage = `Разводка ${token}`;

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
  for (let hop = 0; hop < 6 && [301, 302, 303, 307, 308].includes(res.status); hop += 1) {
    const loc = res.headers.get('location');
    assert(loc, `redirect without location from ${current}`);
    current = new URL(loc, current).toString();
    res = await client.fetch(current);
  }
  const body = await res.text();
  return { res, body, url: current };
}

function csrfOf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert(match, 'csrf token on page');
  return match[1];
}

function pretty(phone) {
  return `+7 ${phone.slice(1, 4)} ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9)}`;
}

let phoneSeq = 2000000 + Math.floor(Math.random() * 5000000);
function nextPhone() {
  phoneSeq += 1;
  return `7900${String(phoneSeq).slice(-7)}`;
}

async function register(role, name, specialty) {
  const client = jar();
  const phone = nextPhone();
  const first = await page(client, '/register');
  assert(first.res.status === 200, `register form ${role}`);
  const body = new URLSearchParams({
    _csrf: csrfOf(first.body),
    role,
    specialty: specialty || 'plumber',
    full_name: name,
    phone: pretty(phone),
    password: 'parol-naryad-1',
  });
  const done = await page(client, '/register', { method: 'POST', body });
  assert(done.res.status === 200, `registered ${role} landed`);
  assert(done.body.includes(name), `cabinet shows ${name}`);
  return { client, phone, name };
}

async function main() {
  const health = await fetch(`${base}/health`);
  assert((await health.text()) === 'ok', 'health');

  const landing = await fetch(`${base}/`);
  const landingHtml = await landing.text();
  assert(landingHtml.includes('Наряд'), 'landing title');
  assert(landingHtml.includes('690'), 'landing object price');
  assert(landingHtml.includes('490'), 'landing master price');
  assert(landingHtml.includes('не списываются'), 'landing says money is not taken');
  assert(!/оплата прошла|успешно оплачен/i.test(landingHtml), 'landing does not fake a charge');

  const anon = jar();
  const bad = await page(anon, '/login');
  const badPost = await page(anon, '/login', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(bad.body),
      phone: '+7 900 000-00-00',
      password: 'wrong-password',
    }),
  });
  assert(badPost.body.includes('Неверный телефон или пароль'), 'bad login error');

  const missing = await fetch(`${base}/no-such-page`);
  assert(missing.status === 404, 'unknown page status');
  assert((await missing.text()).includes('Такой страницы нет'), 'unknown page copy');

  const client = await register('client', 'Клиент Проверка');
  const foreman = await register('foreman', 'Прораб Проверка');
  const master = await register('master', 'Мастер Проверка', 'plumber');
  const locked = await register('master', 'Мастер Закрытый', 'plumber');

  const forbidden = await page(client.client, '/foreman');
  assert(forbidden.res.status === 403, 'client cannot open foreman cabinet');

  const form = await page(client.client, '/client/requests/new');
  const empty = await page(client.client, '/client/requests', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(form.body),
      kind: 'apartment',
      address: 'дом',
      description: 'коротко',
    }),
  });
  assert(empty.body.includes('Укажите адрес'), 'address validation');

  const created = await page(client.client, '/client/requests', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(empty.body),
      kind: 'apartment',
      address,
      description: 'Нужен ремонт ванной и кухни, смеситель течёт второй месяц.',
    }),
  });
  const requestMatch = created.url.match(/\/client\/requests\/(\d+)/);
  assert(requestMatch, 'client request created');
  const requestId = requestMatch[1];
  assert(created.body.includes(address), 'client sees address');
  assert(created.body.includes('Новая'), 'client sees new status');

  const paywall = await page(foreman.client, `/foreman/objects/new?request=${requestId}`);
  assert(paywall.body.includes('690'), 'paywall shows 690');
  assert(paywall.body.includes('Деньги не списываются'), 'paywall says money is not taken');
  assert(paywall.body.includes('Открыть объект без оплаты'), 'paywall button is honest');

  const refused = await page(foreman.client, '/foreman/objects', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(paywall.body),
      request_id: requestId,
      address,
      client_name: 'Клиент Проверка',
      client_phone: pretty(client.phone),
    }),
  });
  assert(refused.body.includes('без оплаты'), 'object blocked without unpaid confirmation');
  assert(!refused.url.includes('/foreman/objects/'), 'refused create stays on paywall');

  const opened = await page(foreman.client, '/foreman/objects', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(refused.body),
      request_id: requestId,
      address,
      client_name: 'Клиент Проверка',
      client_phone: pretty(client.phone),
      confirm_unpaid: '1',
    }),
  });
  const objectMatch = opened.url.match(/\/foreman\/objects\/(\d+)/);
  assert(objectMatch, 'object created');
  const objectId = objectMatch[1];
  assert(opened.body.includes('Деньги не списаны'), 'object banner says money was not taken');
  assert(opened.body.includes('Клиент должен'), 'debt label');

  const withStage = await page(foreman.client, `/foreman/objects/${objectId}/stages`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(opened.body), title: stage }),
  });
  assert(withStage.body.includes(stage), 'stage saved');

  const withPurchase = await page(foreman.client, `/foreman/objects/${objectId}/purchases`, {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(withStage.body),
      title: purchase,
      amount_rub: '1500',
      charged_to_client: '1',
    }),
  });
  assert(withPurchase.body.includes(purchase), 'purchase saved');
  assert(withPurchase.body.includes('1'), 'debt amount visible');
  assert(/1[\s\u00a0\u202f]?500\s?₽/.test(withPurchase.body), 'debt formatted in rubles');

  const masterPrice = await page(master.client, '/master/subscription');
  assert(masterPrice.body.includes('490'), 'master price 490');
  assert(masterPrice.body.includes('Деньги не списываются'), 'master paywall is honest');
  const masterHomeBefore = await page(master.client, '/master');
  assert(!masterHomeBefore.body.includes(address), 'unopened master does not see the job');
  const lockedHome = await page(locked.client, '/master');
  assert(!lockedHome.body.includes(address), 'locked master does not see the job');

  const openedOrders = await page(master.client, '/master/subscription/open', {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(masterPrice.body), confirm_unpaid: '1' }),
  });
  assert(openedOrders.body.includes('Деньги не списаны'), 'master cabinet keeps unpaid notice');
  assert(!openedOrders.body.includes(address), 'offer not created yet');

  const accepting = await page(master.client, '/master/accepting', {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(openedOrders.body), accepting_orders: '1' }),
  });
  assert(accepting.body.includes('Сейчас вы принимаете заказы'), 'master accepts orders toggle');

  const offered = await page(foreman.client, `/foreman/objects/${objectId}/offers`, {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(withPurchase.body),
      specialty: 'plumber',
      summary,
    }),
  });
  assert(offered.body.includes(summary), 'foreman sees the offer');

  const incoming = await page(master.client, '/master');
  assert(incoming.body.includes(address), 'subscribed master sees the offer');
  const stillLocked = await page(locked.client, '/master');
  assert(!stillLocked.body.includes(address), 'unsubscribed master still does not see the offer');

  const offerPage = await page(master.client, incoming.body.match(/href="(\/master\/offers\/\d+)"/)[1]);
  assert(offerPage.body.includes('Принять заказ'), 'accept button');
  const accepted = await page(master.client, offerPage.url.replace(base, '') + '/accept', {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(offerPage.body) }),
  });
  assert(accepted.body.includes('Принят'), 'master sees accepted');
  assert(accepted.body.includes('Мастер Проверка'), 'acceptance note names the master');

  const clientView = await page(client.client, `/client/requests/${requestId}`);
  assert(clientView.body.includes('Мастер Проверка'), 'client sees the master');
  assert(clientView.body.includes('Принят'), 'client sees accepted call');
  assert(clientView.body.includes(address), 'client still sees address');

  const foremanView = await page(foreman.client, `/foreman/objects/${objectId}`);
  assert(foremanView.body.includes('Мастер Проверка'), 'foreman sees who accepted');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const upload = new FormData();
  upload.set('_csrf', csrfOf(foremanView.body));
  upload.set('room', 'bathroom');
  upload.set('photo', new Blob([png], { type: 'image/png' }), 'bath.png');
  const uploaded = await page(foreman.client, `/foreman/objects/${objectId}/photos`, {
    method: 'POST',
    body: upload,
  });
  const photo = uploaded.body.match(/src="(\/photos\/\d+)"/);
  assert(photo, 'photo rendered');
  const image = await foreman.client.fetch(new URL(photo[1], base));
  assert(image.status === 200, 'photo file served');
  assert((image.headers.get('content-type') || '').includes('image'), 'photo content type');
  const stranger = await client.client.fetch(new URL(photo[1], base));
  assert(stranger.status === 404, 'client cannot download foreman photo');

  console.log('FLOW OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
