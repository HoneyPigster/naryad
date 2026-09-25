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
};
