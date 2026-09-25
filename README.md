# Наряд

Сайт заявок на ремонт: кабинет клиента, кабинет прораба и кабинет мастера. Клиент не платит. Объект прораба — 690 ₽, входящие мастера — 490 ₽ в месяц. В этой версии деньги не списываются.

Постановка на свой Ubuntu: [docs/deploy.md](docs/deploy.md). О продукте: [docs/product-brief.md](docs/product-brief.md).

Планируемое направление «Приёмка» (аудит, без реализации в коде): [docs/inspection/](docs/inspection/).

Локально, если уже есть PostgreSQL 16 и Node.js 22:

```bash
cp .env.example .env
# пропишите DATABASE_URL, SESSION_SECRET, PHOTO_DIR=./data/photos, COOKIE_SECURE=0
npm ci
npm start
```

Сайт: http://127.0.0.1:3000/

На сервере, в каталоге проекта после заполнения `.env`:

```bash
docker compose up -d --build
```
