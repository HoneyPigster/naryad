# Постановка «Наряда» на Ubuntu 24.04

Сервер вы готовите сами: Ubuntu 24.04, Docker Engine и плагин Compose, открытые порты 80 и 443. Если будет домен — A-запись на этот сервер. Этот файл ничего на сервере не устанавливает и не заходит по SSH.

Прод сейчас: `masterprorab.ru` → `109.172.37.155`, код в `/opt/naryad`.

## Команда

В каталоге проекта, когда файл `.env` уже заполнен:

```bash
docker compose up -d --build
```

## Каталог

```bash
git clone https://github.com/HoneyPigster/naryad.git
cd naryad
cp .env.example .env
```

Откройте `.env`, задайте пароли и адрес сайта. Затем команда выше.

Код на ветке `main`.

## Переменные

- `POSTGRES_PASSWORD` — пароль базы. Без символов `@ : / # ? &`.
- `SESSION_SECRET` — длинная случайная строка для сессий. Удобно взять `openssl rand -hex 32`.
- `SITE_ADDRESS` — домен без схемы, например `masterprorab.ru`, либо `:80`, если домена нет.
- `ACME_EMAIL` — почта для Let's Encrypt. Нужна, когда `SITE_ADDRESS` — домен.
- `COOKIE_SECURE` — `1`, если заходите по https. `0`, если сайт только по http (`:80`). Иначе браузер не сохранит вход.
- `PHOTO_DIR` — в контейнере оставьте `/data/photos`.

Приложение само собирает адрес базы: пользователь `naryad`, база `naryad`, хост `db`.

## Где лежат данные

- PostgreSQL: том Docker `pgdata`. В контейнере базы это `/var/lib/postgresql/data`. На хосте каталог тома, обычно `/var/lib/docker/volumes/<проект>_pgdata/_data`.
- Фото: том `photos`. В контейнере приложения путь из `PHOTO_DIR`, по умолчанию `/data/photos`. Другого каталога для снимков код не использует: в базе только имя файла. Чтобы позже перейти на объектное хранилище, подмените этот том или `PHOTO_DIR`.
- Сертификаты Caddy: том `caddy_data`.

Имя проекта Compose совпадает с именем каталога. Для каталога `naryad` тома называются `naryad_pgdata` и `naryad_photos`.

```bash
docker volume inspect naryad_photos
docker volume inspect naryad_pgdata
```

## Порты

Наружу открыты 80 и 443 (Caddy). Приложение и PostgreSQL в интернет не выставлены.

Если `SITE_ADDRESS` — домен, Caddy сам получает сертификат и отвечает по https. Если `:80`, сайт работает по http, без сертификата. На голый IP Let's Encrypt сертификат не даёт.

## Проверка

```bash
docker compose ps
curl -fsS http://127.0.0.1/health
```

С доменом: `curl -fsS https://ваш-домен/health`. Ответ: `ok`.

Дальше откройте сайт, зарегистрируйте клиента, прораба, мастера или кабинет приёмки и пройдите свой сценарий.

## Обновление (обязательно с бэкапом)

В родительском каталоге проекта (например `/opt`):

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
cp -a naryad "naryad.bak.$STAMP"
cd naryad
docker compose exec -T db pg_dump -U naryad naryad > "backup-$STAMP.sql"
# фото: скопируйте том naryad_photos или архивируйте его каталог
ls -lh "backup-$STAMP.sql" "../naryad.bak.$STAMP"
git pull
docker compose up -d --build
```

Тома с базой и фото при этом не удаляются. Команда `docker compose down -v` стирает тома — на рабочем сервере её **не** использовать.

## Копии

```bash
docker compose exec -T db pg_dump -U naryad naryad > naryad.sql
```

Фото копируйте из каталога тома `photos`.
