const PRICES = {
  objectRub: 690,
  masterMonthRub: 490,
};

const ROLES = {
  client: 'Клиент',
  foreman: 'Прораб',
  master: 'Мастер',
};

const KINDS = {
  apartment: 'Ремонт квартиры',
  plumber: 'Сантехник',
  electrician: 'Электрик',
  washer: 'Ремонт стиральной машины',
};

const SPECIALTIES = {
  plumber: 'Сантехник',
  electrician: 'Электрик',
  washer: 'Ремонт стиральных машин',
};

const REQUEST_STATUS = {
  new: 'Новая',
  offered: 'Предложена мастерам',
  accepted: 'Принята',
  in_progress: 'В работе',
  done: 'Готово',
  cancelled: 'Отменена',
};

const STAGE_STATUS = {
  planned: 'Запланирован',
  in_progress: 'В работе',
  done: 'Готово',
};

const ROOMS = {
  kitchen: 'Кухня',
  bathroom: 'Ванная',
  room: 'Комната',
  hallway: 'Коридор',
  balcony: 'Балкон',
  other: 'Другое',
};

const HOME = {
  client: '/client',
  foreman: '/foreman',
  master: '/master',
};

function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith('7')) return digits;
  return null;
}

function formatPhone(digits) {
  if (!digits || String(digits).length !== 11) return digits || '';
  const d = String(digits);
  return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
}

function formatMoney(amount) {
  const n = Number(amount) || 0;
  return `${new Intl.NumberFormat('ru-RU').format(n)} ₽`;
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

function offerLabel(offer) {
  if (offer.status === 'open') return 'Открыт';
  if (offer.status === 'cancelled') return 'Отменён';
  if (offer.job_status === 'in_progress') return 'В работе';
  if (offer.job_status === 'done') return 'Готово';
  return 'Принят';
}

function parseId(value) {
  if (!/^\d+$/.test(String(value || ''))) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

function parseAmount(value) {
  const cleaned = String(value || '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Math.round(Number(cleaned));
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000000) return null;
  return n;
}

function parseDateInput(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return raw;
}

function parseTimeInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!/^\d{2}:\d{2}$/.test(raw)) return null;
  const [h, m] = raw.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return raw;
}

function monthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function parseMonthKey(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}$/.test(raw)) return null;
  const [y, m] = raw.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  return monthKey(dt);
}

function daysInMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function addMonthsToDate(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1 + months, d);
  if (dt.getDate() !== d) dt.setDate(0);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function dateKey(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatMonthTitle(key) {
  const [y, m] = key.split('-').map(Number);
  const title = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
  return title.charAt(0).toUpperCase() + title.slice(1);
}

module.exports = {
  PRICES,
  ROLES,
  KINDS,
  SPECIALTIES,
  REQUEST_STATUS,
  STAGE_STATUS,
  ROOMS,
  HOME,
  normalizePhone,
  formatPhone,
  formatMoney,
  formatDate,
  offerLabel,
  parseId,
  parseAmount,
  parseDateInput,
  parseTimeInput,
  monthKey,
  parseMonthKey,
  shiftMonth,
  daysInMonth,
  addMonthsToDate,
  formatMonthTitle,
  dateKey,
};
