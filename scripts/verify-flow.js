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
  const first = await page(client, `/register/${role}`);
  assert(first.res.status === 200, `register form ${role}`);
  const body = new URLSearchParams({
    _csrf: csrfOf(first.body),
    role,
    specialty: specialty || 'plumber',
    full_name: name,
    phone: pretty(phone),
    password: 'parol-naryad-1',
  });
  const done = await page(client, `/register/${role}`, { method: 'POST', body });
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
  const bad = await page(anon, '/login/foreman');
  const badPost = await page(anon, '/login/foreman', {
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

  const landingNoClient = !landingHtml.includes('Анна')
    && !/(?<!\d)0\s*₽/.test(landingHtml)
    && !/клиент/i.test(landingHtml)
    && !landingHtml.includes('value="client"');
  assert(landingNoClient, 'landing has no client');
  assert(landingHtml.includes('Я прораб'), 'landing foreman tile');
  assert(landingHtml.includes('Я мастер'), 'landing master tile');
  assert(landingHtml.includes('/drawings/foreman.webp') && landingHtml.includes('/drawings/master.webp'), 'landing has two drawings');
  assert(landingHtml.includes('/login/foreman') && landingHtml.includes('/login/master'), 'landing login paths are separate');

  const regJar = jar();
  const reg = await page(regJar, '/register?role=client');
  assert(!reg.body.includes('value="client"'), 'register form has no client');
  assert(reg.body.includes('/register/foreman') && reg.body.includes('/register/master'), 'register chooser has two paths');
  const foremanReg = await page(regJar, '/register/foreman');
  assert(!foremanReg.body.includes('name="specialty"'), 'foreman registration has no specialty');
  assert(foremanReg.body.includes('/drawings/foreman.webp'), 'foreman registration has his drawing');
  assert(!foremanReg.body.includes('/drawings/master.webp'), 'foreman registration has no master drawing');
  const masterReg = await page(jar(), '/register/master');
  assert(masterReg.body.includes('name="specialty"'), 'master registration has specialty');
  assert(masterReg.body.includes('/drawings/master.webp'), 'master registration has his drawing');
  const rejected = await page(regJar, '/register', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(foremanReg.body),
      role: 'client',
      full_name: 'Клиент Проверка',
      phone: '+7 900 111-22-33',
      password: 'parol-naryad-1',
    }),
  });
  assert(rejected.body.includes('прораб или мастер'), 'client registration refused');

  const foreman = await register('foreman', 'Прораб Проверка');
  const master = await register('master', 'Мастер Проверка', 'plumber');
  const locked = await register('master', 'Мастер Закрытый', 'plumber');

  const forbidden = await page(foreman.client, '/master');
  assert(forbidden.res.status === 403, 'foreman cannot open master cabinet');

  const form = await page(foreman.client, '/foreman');
  assert(form.body.includes('Квартира'), 'foreman opens on the apartment');
  assert(form.body.includes('690'), 'apartment form shows 690');
  assert(form.body.includes('Деньги не списываются'), 'apartment form says money is not taken');
  assert(form.body.includes('name="address"'), 'apartment form has address');
  assert(form.body.includes('name="client_name"'), 'apartment form has the person who owes');
  assert(!form.body.includes('Дать задачу'), 'apartment form is not a task headline');
  const refused = await page(foreman.client, '/foreman/objects', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(form.body),
      address,
      client_name: 'Иван Петров',
      client_phone: '+7 900 700-00-01',
    }),
  });
  assert(refused.body.includes('не списываются'), 'object blocked without unpaid confirmation');
  assert(!/\/foreman\/objects\/\d+/.test(refused.url), 'refused object stays on the form');

  const created = await page(foreman.client, '/foreman/objects', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(refused.body),
      address,
      client_name: 'Иван Петров',
      client_phone: '+7 900 700-00-01',
      confirm_unpaid: '1',
    }),
  });
  const objectMatch = created.url.match(/\/foreman\/objects\/(\d+)/);
  assert(objectMatch, 'apartment created');
  const objectId = objectMatch[1];
  assert(created.body.includes('Этапы'), 'apartment shows stages');
  assert(created.body.includes('Закупки'), 'apartment shows purchases');
  assert(created.body.includes('Клиент должен'), 'apartment shows the debt');
  assert(created.body.includes('Фото'), 'apartment shows photos');
  assert(created.body.includes('Деньги не списаны'), 'apartment says money was not taken');
  assert(created.body.includes(address), 'foreman sees the address');
  const offerAt = created.body.indexOf('Предложить мастерам');
  const stagesAt = created.body.indexOf('Этапы');
  assert(offerAt > stagesAt && stagesAt > -1, 'calling a master sits below the apartment');

  const masterHome = await page(master.client, '/master');
  assert(masterHome.body.includes('Мастер Проверка'), 'master cabinet shows his name');
  assert(masterHome.body.includes('Сантехник'), 'master cabinet shows specialty');
  assert(masterHome.body.includes('Принимаю заказы'), 'master cabinet has the orders switch');
  assert(masterHome.body.includes('490'), 'master price 490');
  assert(masterHome.body.includes('Деньги не списываются'), 'master cabinet says money is not taken');
  assert(masterHome.body.includes('Мои заказы'), 'master cabinet lists his jobs');
  assert(masterHome.body.indexOf('Принимаю заказы') < masterHome.body.indexOf('Входящие'), 'incoming sits below the switch');
  assert(!masterHome.body.includes(address), 'master does not see the call before he accepts orders');

  const accepting = await page(master.client, '/master/accepting', {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(masterHome.body),
      accepting_orders: '1',
    }),
  });
  assert(accepting.body.includes('Деньги не списаны'), 'turning on orders does not charge');
  assert(!accepting.body.includes(address), 'no call yet');

  const offered = await page(foreman.client, `/foreman/objects/${objectId}/offers`, {
    method: 'POST',
    body: new URLSearchParams({
      _csrf: csrfOf(created.body),
      specialty: 'plumber',
      summary,
    }),
  });
  assert(offered.body.includes(summary), 'foreman keeps the call on the apartment');
  assert(offered.body.indexOf('Этапы') < offered.body.indexOf(summary), 'the call stays below the apartment work');

  const waiting = await page(master.client, '/master');
  assert(waiting.body.includes(address), 'master sees the incoming call');
  assert(waiting.body.indexOf('Мои заказы') < waiting.body.indexOf(address) || waiting.body.indexOf('Принимаю') < waiting.body.indexOf('Входящие'), 'the call is not the cabinet headline');
  const lockedHome = await page(locked.client, '/master');
  assert(lockedHome.body.includes('Мастер Закрытый'), 'second master has his own cabinet');
  assert(!lockedHome.body.includes(address), 'paused master does not see the call');

  const offerId = waiting.body.match(/\/master\/offers\/(\d+)/)[1];
  const offerPage = await page(master.client, `/master/offers/${offerId}`);
  assert(offerPage.body.includes('Принять заказ'), 'accept sits on the call, not the cabinet headline');
  const taken = await page(master.client, `/master/offers/${offerId}/accept`, {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrfOf(offerPage.body) }),
  });
  assert(taken.body.includes('Принят'), 'accepted job has a status');
  const mine = await page(master.client, '/master');
  assert(mine.body.includes(address), 'master sees the job he took');
  assert(mine.body.includes('Принят'), 'taken job shows its status');
  assert(mine.body.indexOf(address) < mine.body.indexOf('<h2>Входящие</h2>'), 'taken job sits above incoming calls');

  console.log('FLOW OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
