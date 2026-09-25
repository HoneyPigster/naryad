# Наряд

Сайт для ремонта и приёмки помещений: кабинеты **клиента**, **прораба**, **мастера** и **приёмки**.

| Роль | Что делает | Цена в этой версии |
|------|------------|--------------------|
| Клиент | Заявка и статус | бесплатно |
| Прораб | Объект: этапы, закупки, долг, фото, вызов мастера | 690 ₽ за объект |
| Мастер | Входящие по специальности | 490 ₽ / мес за входящие |
| Приёмка | Чек-лист, дефекты с фото и замерами, PDF-отчёт | 990 ₽ за объект |

Деньги в этой версии **не списываются** (кнопки «без оплаты»).

- Продукт: [docs/product-brief.md](docs/product-brief.md)
- Постановка на Ubuntu: [docs/deploy.md](docs/deploy.md)
- Спеки «Приёмка»: [docs/inspection/](docs/inspection/)

Репозиторий: [github.com/HoneyPigster/naryad](https://github.com/HoneyPigster/naryad). Прод: [masterprorab.ru](https://masterprorab.ru).

## Локально

Нужны Node.js ≥ 22.14 и PostgreSQL 16 (или Docker Compose).

```bash
git clone https://github.com/HoneyPigster/naryad.git
cd naryad
cp .env.example .env
# DATABASE_URL, SESSION_SECRET, PHOTO_DIR=./data/photos, COOKIE_SECURE=0
npm ci
npm start
```

Сайт: http://127.0.0.1:3000/

Через Docker:

```bash
cp .env.example .env
# POSTGRES_PASSWORD, SESSION_SECRET, SITE_ADDRESS=:80, COOKIE_SECURE=0
docker compose up -d --build
```

Проверка: `curl -fsS http://127.0.0.1/health` → `ok`.

Демо-аккаунты после `node scripts/seed-demo.js` (в контейнере — `docker compose exec app node scripts/seed-demo.js`): те же пароли, что в скрипте; для приёмки — отдельный кабинет.

## Стек

Node.js 22 · Express · EJS · PostgreSQL 16 · сессии в Postgres · фото на диске (`PHOTO_DIR`) · Caddy 80/443 в Compose.

## Скрипты

```bash
npm start                 # сервер
npm run verify            # сценарий прораб/мастер
npm run verify:inspection # сценарий приёмки
npm run test:unit         # unit-тесты
```

## Обновление на сервере

См. [docs/deploy.md](docs/deploy.md): бэкап кода, `pg_dump`, фото → `git pull` → `docker compose up -d --build`. Не использовать `docker compose down -v` на живом сервере.
