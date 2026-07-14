# Деплой на VPS (Hostinger, Ubuntu) — домен + HTTPS

Цель: backend крутится 24/7 под **systemd** (ночной снимок в 23:59 Киев идёт сам), frontend раздаётся **nginx**, доступ по домену через **HTTPS**.

Плейсхолдеры (замени на свои): `deploy` (пользователь), `your-domain.com`, путь `/home/deploy/couture-dashboard`.

---

## 0. Перед началом
- VPS с Ubuntu 22/24, root или sudo-пользователь.
- Домен, у которого **A-запись → IP твоего VPS** (проверь: `dig +short your-domain.com`).
- Несистемный пользователь (не root) для запуска приложения:
  ```bash
  sudo adduser deploy && sudo usermod -aG sudo deploy
  su - deploy
  ```

## 1. Node 20
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx
node -v   # ≥ 20
```

## 2. Забрать код
```bash
cd ~
git clone git@github.com:davidkin/ct-dashboard.git couture-dashboard
cd couture-dashboard
git checkout feat/web_traffic_tracking     # или ветку/тег, который деплоим
```

## 3. Backend
```bash
cd ~/couture-dashboard/backend
npm ci          # ВАЖНО: пересобирает better-sqlite3 под Node этого VPS (нативный модуль)
```

### 3a. Секреты `.env`
Создай `backend/.env` (НЕ из git — переноси вручную/через scp):
```env
PORT=3001
HOST=127.0.0.1                 # слушать только localhost → наружу только через nginx
DASHBOARD_PASSWORD=<СИЛЬНЫЙ_ПАРОЛЬ>   # НЕ "changeme" — иначе дашборд открыт всем!
TRACKING_TZ=Europe/Kyiv
DAILY_CAPTURE_AT=23:59

ONLYMONSTER_TOKEN=<свежий_ротированный>
ONLYMONSTER_ACCOUNT_FREE=<...>
ONLYMONSTER_ACCOUNT_VIP=<...>
ONLYFANSAPI_KEY=<свежий_ротированный>
ONLYFANSAPI_ACCOUNT_FREE=<...>
ONLYFANSAPI_ACCOUNT_VIP=<...>

GLOSSARY_SHEET_ID=<...>
GLOSSARY_TAB=<...>
GOOGLE_CREDENTIALS_PATH=./credentials/google-service.json
```
```bash
chmod 600 .env
```

### 3b. Google service account
Скопируй `credentials/google-service.json` на VPS (scp), затем:
```bash
mkdir -p credentials && chmod 600 credentials/google-service.json
```

### 3c. Сид БД (история)
Локальный `data/couture.db` уже содержит Glossary + импорт листа. Перенеси его:
```bash
# на ЛОКАЛЬНОЙ машине:
scp couture-dashboard/backend/data/couture.db deploy@<IP>:~/couture-dashboard/backend/data/
```
_Альтернатива без копии БД:_ на VPS выполнить `npm run import-glossary`, затем поднять сервер и дёрнуть `POST /api/daily-tracking/import-sheet`.

### 3d. Сборка + прогон
```bash
npm run build
node dist/server.js
# в логе должно быть:
#   Couture Dashboard backend on :3001
#   [daily] capture scheduled at 23:59 Europe/Kyiv (checks every 60s)
# Ctrl-C
```

## 4. systemd (автозапуск 24/7)
```bash
sudo cp ~/couture-dashboard/deploy/couture-backend.service /etc/systemd/system/
# ↑ поправь User= и WorkingDirectory= внутри файла под свой путь!
sudo nano /etc/systemd/system/couture-backend.service

sudo systemctl daemon-reload
sudo systemctl enable --now couture-backend
sudo systemctl status couture-backend        # active (running)
journalctl -u couture-backend -f              # смотрим логи + строку про 23:59
```
Теперь **автоматизация работает в фоне** и переживёт краш/ребут.

## 5. Frontend
```bash
cd ~/couture-dashboard/frontend
npm ci
npm run build     # → frontend/dist
```

## 6. nginx
```bash
sudo cp ~/couture-dashboard/deploy/nginx-couture.conf /etc/nginx/sites-available/couture
sudo nano /etc/nginx/sites-available/couture      # server_name + путь root
sudo ln -s /etc/nginx/sites-available/couture /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
# проверь http://your-domain.com — должна открыться таблица
```

## 7. HTTPS (Let's Encrypt)
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
# выбери redirect (80→443). Автопродление уже настроено (certbot.timer).
```

## 8. Firewall
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 + 443
sudo ufw enable
# порт 3001 наружу НЕ открываем — backend слушает 127.0.0.1 (HOST в .env)
```

## 9. Проверка автоматизации
- `journalctl -u couture-backend -f` → в 23:59 Киев появится `[daily] capturing clicks for … at 23:59` + `captured N links`.
- Хочешь проверить сразу, не дожидаясь ночи: `curl -u admin:<пароль> -X POST http://127.0.0.1:3001/api/daily-tracking/capture` (первый снимок = baseline, дельта пойдёт со второго дня).

## 10. Обновление (деплой новой версии)
```bash
cd ~/couture-dashboard && git pull
cd backend  && npm ci && npm run build && sudo systemctl restart couture-backend
cd ../frontend && npm ci && npm run build     # nginx подхватит новую статику сам
```

---

## ✅ Чек-лист безопасности
- [ ] `DASHBOARD_PASSWORD` — реальный сильный пароль (не `changeme`).
- [ ] Токены OM/OF/Google **ротированы** (старые светились в переписке) и лежат только в `.env`/`credentials` с `chmod 600`.
- [ ] `HOST=127.0.0.1` — backend не торчит наружу, только через nginx.
- [ ] `ufw` включён, открыты только SSH + 80/443.
- [ ] HTTPS активен, редирект 80→443.
- [ ] `.env`, `credentials/`, `data/` — не в git (проверено `.gitignore`).
