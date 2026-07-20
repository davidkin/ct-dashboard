# Задача для агента на VPS — развернуть couture-dashboard и включить выгрузку

Этот документ = полный контекст проекта + конкретная задача. Читай целиком, потом действуй.
Гранулярные команды деплоя — в **`DEPLOY.md`** (следуй ему как источнику истины). Здесь — общая картина, задача и что вернуть David.

---

## 1. Что это за проект (контекст)

**couture-dashboard** — веб-приложение, которое **автоматизирует** ручную Google-таблицу трафик-трекинга партнёра (OnlyFans-агентство). Раньше человек каждый день вручную снимал с платформы «сколько всего кликов и фанов по каждой трекинг-ссылке» и вписывал в Google Sheet; таблица считала разницу со вчера. Мы это **воспроизвели в вебе и автоматизировали**.

**Что уже сделано (код в ветке `feat/web_traffic_tracking`):**
- **Backend** (Node + Fastify + SQLite + TypeScript): REST API + ночной джоб автоматизации.
- **Frontend** (Vite + React): страница-копия листа — вид Google Sheets (таблицы Total + Raw Data, график «Клики & Фаны», блок Notes & Conditions, накопительный Total).
- **Автоматизация**: каждый день в **23:59 по Киеву** джоб тянет из OnlyMonster накопительные клики+фаны по каждой ссылке и пишет «сырой снимок». «Total» считается на лету как дельта `cum[сегодня] − cum[вчера]` — ровно как формулы в исходной таблице.
- **Историю** (июнь–июль) один раз импортировали из Google-листа; дальше данные наполняются авто-снимком.
- **Read-only эндпоинт `/api/export`** — чтобы ассистент мог фетчить живые данные с VPS.

**Ключевая деталь:** автоматизация живёт **внутри backend-процесса** (`setInterval`-шедулер). Значит цель — **backend работает 24/7 под systemd**, и снимки идут сами.

**Репозиторий:** `git@github.com:davidkin/ct-dashboard.git` · ветка **`feat/web_traffic_tracking`** · актуальный коммит `f3971fc`.

---

## 2. Архитектура на VPS (Ubuntu, домен + HTTPS)

```
systemd ─▶ node dist/server.js  (127.0.0.1:3001, backend + ночной джоб 23:59)
nginx   ─▶ статика frontend/dist  +  proxy /api → 127.0.0.1:3001  +  TLS (certbot)
SQLite  ─▶ backend/data/couture.db (на диске VPS)
секреты ─▶ backend/.env + backend/credentials/google-service.json (не в git)
```

- Автоматизация = backend под systemd (перезапуск при краше + после ребута).
- Наружу торчит только nginx (80/443); backend слушает localhost (`HOST=127.0.0.1`).

---

## 3. ЗАДАЧА — по шагам

### 3.1. Развернуть приложение (полные команды — в `DEPLOY.md`)
1. Node 20, `git`, `nginx`.
2. `git clone` → `git checkout feat/web_traffic_tracking`.
3. `cd backend && npm ci` — **важно: пересобирает `better-sqlite3` под Node этого VPS** (иначе ABI-краш).
4. Создать `backend/.env` (шаблон в §4), `chmod 600`.
5. Положить `backend/credentials/google-service.json` (`chmod 600`).
6. **Засидить БД**: скопировать готовый `backend/data/couture.db` (David передаст через scp — в нём Glossary + история) **или** `npm run import-glossary` + после старта `POST /api/daily-tracking/import-sheet`.
7. `npm run build`; прогнать `node dist/server.js` — в логе должно быть `Couture Dashboard backend on :3001` и `[daily] capture scheduled at 23:59 Europe/Kyiv`.
8. **systemd**: `deploy/couture-backend.service` → поправить `User=`/`WorkingDirectory=` → `systemctl enable --now couture-backend`.
9. `cd frontend && npm ci && npm run build`.
10. **nginx**: `deploy/nginx-couture.conf` → `server_name` + `root` → активировать, `nginx -t && reload`.
11. **HTTPS**: `certbot --nginx -d <домен>`.
12. **Firewall**: `ufw allow OpenSSH`, `ufw allow 'Nginx Full'`, `ufw enable`.

### 3.2. Включить выгрузку для ассистента (`/api/export`)
Эндпоинт уже в коде. Нужно только задать токен:
```bash
openssl rand -hex 24                     # скопируй значение
# допиши в backend/.env:  EXPORT_TOKEN=<это значение>
sudo systemctl restart couture-backend
```
Проверить:
```bash
curl "https://<домен>/api/export?key=<TOKEN>&partner=6&creator=Nekoletta%20Free&from=2026-06-01&all=1&source=combined"
# → JSON вида {"data":{"campaigns":[...],"rows":[...]}}
```
- Только чтение, отдельный токен (не пароль дашборда). Неверный ключ → 401, без `EXPORT_TOKEN` → 503.
- Токен ротируемый: поменял в `.env` + рестарт — старый отозван.

---

## 4. `.env` шаблон (backend/.env)

```env
PORT=3001
HOST=127.0.0.1
DASHBOARD_PASSWORD=<openssl rand -base64 24>   # НЕ "changeme" — иначе дашборд открыт всем!
EXPORT_TOKEN=<openssl rand -hex 24>            # для read-only /api/export
TRACKING_TZ=Europe/Kyiv
DAILY_CAPTURE_AT=23:59

ONLYMONSTER_TOKEN=<...>
ONLYMONSTER_ACCOUNT_FREE=<...>
ONLYMONSTER_ACCOUNT_VIP=<...>
ONLYFANSAPI_KEY=<...>
ONLYFANSAPI_ACCOUNT_FREE=<...>
ONLYFANSAPI_ACCOUNT_VIP=<...>

GLOSSARY_SHEET_ID=<...>
GLOSSARY_TAB=<...>
GOOGLE_CREDENTIALS_PATH=./credentials/google-service.json
```

**Запросить у David до старта:** домен (A-запись → IP VPS), значения секретов выше, файл `google-service.json`, и как сидить БД (scp `couture.db` или импорт заново).

---

## 5. Что ВЕРНУТЬ David (итог)

1. **Домен**: `https://<домен>` — открывается дашборд.
2. **EXPORT_TOKEN**: `<токен>` (для передачи ассистенту).
3. **Рабочий export-URL** (из §3.2) + первые ~200 символов JSON-ответа — как подтверждение.
4. Вывод `systemctl status couture-backend` (должно быть `active (running)`) и строка про `23:59` из `journalctl -u couture-backend`.

David передаст ассистенту домен + токен → ассистент будет фетчить `https://<домен>/api/export?...` и видеть живые данные с VPS.

---

## 6. ⚠️ Обязательно (безопасность и правила)

- **`DASHBOARD_PASSWORD`** — реальный сильный пароль (не `changeme`), иначе дашборд и данные открыты всем.
- **`HOST=127.0.0.1`** — backend не торчит наружу, только через nginx.
- **Токены OM/OF/Google** — свежие/ротированные; `.env` и `credentials/` — `chmod 600`, в git не коммитить.
- **Firewall** включён, наружу только SSH + 80/443.
- **HTTPS** активен, редирект 80→443.
- **`.env`, `credentials/`, `data/`** — не в git (проверено в `.gitignore`).
- **Google Sheet — СТРОГО ТОЛЬКО ЧТЕНИЕ.** Никогда не писать/менять её (service account с scope `spreadsheets.readonly`). Вся запись — только в нашу БД.

---

## 7. Чек-лист готовности

- [ ] `systemctl status couture-backend` → active (running)
- [ ] `journalctl -u couture-backend` → `[daily] capture scheduled at 23:59 Europe/Kyiv`
- [ ] `https://<домен>` открывает таблицу, данные грузятся (логин `admin` + пароль)
- [ ] `curl https://<домен>/api/export?key=<TOKEN>&partner=6...` → JSON
- [ ] Домен + токен + подтверждение отправлены David
- [ ] `.env`/`credentials` с `chmod 600`, firewall включён, HTTPS работает
