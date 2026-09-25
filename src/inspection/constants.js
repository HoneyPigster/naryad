const PROPERTY_TYPES = {
  APARTMENT: 'Квартира',
  APARTMENT_STUDIO: 'Студия',
  HOUSE: 'Дом',
  OFFICE: 'Офис',
  COMMERCIAL: 'Коммерция',
  OTHER: 'Другое',
};

const FINISH_TYPES = {
  NO_FINISH: 'Без отделки',
  ROUGH: 'Черновая',
  WHITE_BOX: 'White box',
  FINISHED: 'Чистовая',
  DESIGNER: 'Дизайнерская',
  OTHER: 'Другое',
};

const ROOM_KINDS = {
  hallway: 'Прихожая',
  kitchen: 'Кухня',
  living: 'Гостиная',
  bedroom: 'Спальня',
  kids: 'Детская',
  bathroom: 'Ванная',
  wc: 'Санузел',
  wardrobe: 'Гардеробная',
  balcony: 'Балкон',
  loggia: 'Лоджия',
  other: 'Другое',
};

const PROJECT_STATUS = {
  DRAFT: 'Черновик',
  SCHEDULED: 'Запланирована',
  IN_PROGRESS: 'В работе',
  COMPLETED: 'Завершена',
  FOLLOW_UP: 'Повторная',
  ARCHIVED: 'Архив',
};

const INSPECTION_STATUS = {
  DRAFT: 'Черновик',
  IN_PROGRESS: 'В работе',
  PAUSED: 'Пауза',
  COMPLETED: 'Завершена',
  FOLLOW_UP: 'Повторная',
  ARCHIVED: 'Архив',
};

const ITEM_RESULTS = {
  UNCHECKED: 'Не проверено',
  OK: 'Всё в порядке',
  DEFECT: 'Есть замечание',
  NA: 'Не применимо',
};

const SEVERITIES = {
  INFO: 'Инфо',
  MINOR: 'Незначительный',
  MAJOR: 'Серьёзный',
  CRITICAL: 'Критический',
};

const DEFECT_STATUSES = {
  OPEN: 'Открыт',
  CONFIRMED: 'Подтверждён',
  FIXED: 'Исправлен',
  RECHECK_REQUIRED: 'Нужна перепроверка',
  CLOSED: 'Закрыт',
  WONT_FIX: 'Не устраняется',
};

const MEASURE_TYPES = {
  LENGTH: 'Длина',
  WIDTH: 'Ширина',
  HEIGHT: 'Высота',
  DEPTH: 'Глубина',
  DEVIATION: 'Отклонение',
  TEMPERATURE: 'Температура',
  HUMIDITY: 'Влажность',
  OTHER: 'Другое',
};

const MEASURE_UNITS = {
  mm: 'мм',
  cm: 'см',
  m: 'м',
  C: '°C',
  pct: '%',
  other: 'др.',
};

const PHOTO_KINDS = {
  OVERVIEW: 'Общий вид',
  CLOSEUP: 'Крупный план',
  SCALE: 'С масштабом',
  OTHER: 'Фото',
};

const INSPECTION_PRICE_RUB = 990;
const PRODUCT_INSPECTION = 'inspection_object';

const FINISH_TAG_SETS = {
  NO_FINISH: ['rough', 'structure', 'openings', 'mep', 'docs', 'final'],
  ROUGH: ['rough', 'structure', 'openings', 'mep', 'docs', 'final'],
  WHITE_BOX: ['rough', 'structure', 'openings', 'mep', 'docs', 'base', 'final'],
  FINISHED: ['rough', 'structure', 'openings', 'mep', 'docs', 'base', 'finish', 'wet', 'kitchen', 'equip', 'final'],
  DESIGNER: ['rough', 'structure', 'openings', 'mep', 'docs', 'base', 'finish', 'wet', 'kitchen', 'equip', 'final'],
  OTHER: ['rough', 'structure', 'openings', 'mep', 'docs', 'base', 'finish', 'wet', 'kitchen', 'equip', 'final'],
};

function finishAllows(finishType, tags) {
  const allowed = FINISH_TAG_SETS[finishType] || FINISH_TAG_SETS.OTHER;
  if (!tags || !tags.length) return true;
  return tags.some((tag) => allowed.includes(tag));
}

module.exports = {
  PROPERTY_TYPES,
  FINISH_TYPES,
  ROOM_KINDS,
  PROJECT_STATUS,
  INSPECTION_STATUS,
  ITEM_RESULTS,
  SEVERITIES,
  DEFECT_STATUSES,
  MEASURE_TYPES,
  MEASURE_UNITS,
  PHOTO_KINDS,
  INSPECTION_PRICE_RUB,
  PRODUCT_INSPECTION,
  FINISH_TAG_SETS,
  finishAllows,
};
