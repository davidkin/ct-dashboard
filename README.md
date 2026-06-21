# Couture Dashboard

Веб-приложение для учёта привлечённых фанатов: партнёры + ссылки из Glossary (Google Sheet) сводятся с метриками из OnlyFansAPI и показываются в дашборде с фильтрами и расчётом выплат.

## Текущий статус MVP

| Milestone | Готовность |
|---|:-:|
| **M1** — Скаффолд (backend + frontend + SQLite-схема) | ✅ |
| **M2** — Импорт Glossary в БД (25 партнёров / 109 ссылок) | ✅ |
| **M4** — Backend REST: `/partners`, `/partners/:id`, `/sync`, `/health` | ✅ |
| **M5** — Frontend MVP: таблица партнёров + drill-down | ✅ |
| **M3** — OnlyFansAPI sync (клики/выручка) | ⏳ ждёт API-ключ |
| **M6** — Деплой на VPS | ⏳ после M3 |

## Структура

```
couture-dashboard/
├── backend/
│   ├── src/
│   │   ├── server.ts             # Fastify entry
│   │   ├── db/
│   │   │   ├── schema.sql        # partners + links + snapshots + sync_log
│   │   │   ├── index.ts          # singleton DB connection
│   │   │   └── init.ts           # `npm run init-db`
│   │   ├── glossary/
│   │   │   ├── parse.ts          # partner name + CPF dual rate parsing
│   │   │   └── import.ts         # `npm run import-glossary`
│   │   ├── routes/
│   │   │   ├── partners.ts       # GET list / detail, PATCH edit
│   │   │   └── sync.ts           # POST force sync, GET status
│   │   └── of/                   # OnlyFansAPI client (M3, пока пусто)
│   ├── data/                     # SQLite файл (gitignored)
│   ├── .env                      # секреты (gitignored)
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx               # layout + header
│   │   ├── api.ts                # типы + клиент к backend
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx     # главная таблица + фильтры
│   │   │   └── PartnerDetail.tsx # карточка + список ссылок
│   │   ├── styles.css            # тёмная тема
│   │   └── main.tsx
│   ├── vite.config.ts            # proxy /api → :3001
│   └── package.json
└── README.md
```

## Локальный запуск

### Backend

```bash
cd backend
cp .env.example .env
# проверь GOOGLE_CREDENTIALS_PATH (по умолчанию указывает на ../../affiliate-tg-bot/credentials/google-service.json)

npm install
npm run import-glossary    # один раз — заливает Glossary в SQLite
npm run dev                # сервер на :3001
```

### Frontend

```bash
cd frontend
npm install
npm run dev                # vite на :5173, проксирует /api → :3001
```

Открой [localhost:5173](http://localhost:5173).

## Что видно в дашборде сейчас

- **Таблица 25 партнёров**: имя, Telegram, тип (External/In-house), источник (IG/TT/FB/…), число ссылок
- **Фильтры**: поиск по имени/telegram, тип, источник
- **Сводка**: суммарные клики / подписки / выручка по выбранным партнёрам
- **Drill-down** (клик по партнёру): карточка + полный список ссылок со ставками CPF и RevShare

Колонки **Clicks / Subs / Revenue / Spenders** показывают `—` — это значения из OnlyFansAPI, которые подтянутся когда подключим ключ.

## OnlyFansAPI: ключ vs Account ID

Это **разные вещи**, нужны обе:

| Что | Где взять | Куда |
|---|---|---|
| **API ключ** (Bearer-токен) | [app.onlyfansapi.com/api-keys](https://app.onlyfansapi.com/api-keys) | `ONLYFANSAPI_KEY` в `.env` |
| **Account ID** для Free (acct_XXX) | Console → подключённые аккаунты | `ONLYFANSAPI_ACCOUNT_FREE` в `.env` |
| **Account ID** для Vip (acct_XXX) | Console → подключённые аккаунты | `ONLYFANSAPI_ACCOUNT_VIP` в `.env` |

Account ID говорит API, **какой** OF-аккаунт читать. API-ключ говорит API, **что мы вообще авторизованы** что-то читать.

Без обоих — sync не запустится.

## Когда всё будет заполнено

Дальше — реализуем M3: HTTP-клиент к `https://app.onlyfansapi.com/api/{acct}/tracking-links`, матчинг по `campaignUrl` ↔ `of_url`, обновление `clicks_count / subscribers_count / revenue_total` в таблице `links` + snapshot для истории. Cron внутри backend, раз в 15 мин.

## API endpoints

```
GET    /api/health                          — статус + флаг "of_api_configured"
GET    /api/creators                        — список моделей с агрегатами + статусом конфигурации
GET    /api/partners?creator=<name>         — партнёры (всё или фильтр по модели)
GET    /api/partners/:id?creator=<name>     — карточка + ссылки (опц. фильтр по модели)
PATCH  /api/partners/:id                    — обновить monthly_fee / notes
POST   /api/sync                            — форсированный sync (503 пока нет API-ключа)
GET    /api/sync/status                     — последние 5 sync-запусков + флаг конфигурации
```

## Мульти-модельная архитектура

Каждый Creator (модель) = отдельный OnlyFans-аккаунт, у каждого свой `acct_XXX` в системе OnlyFansAPI.

В дашборде есть переключатель в шапке: **Все** / **Nekoletta Free** / **Nekoletta Vip**.

- **Все** — агрегаты по всем моделям сразу.
- **Free / Vip** — данные только этой модели. Партнёры без ссылок на эту модель скрываются.
- При фильтре по модели в карточке партнёра отображаются только её ссылки.
- Если у модели не задан `account_id` в `.env`, рядом с табом появится ⚠ — это сигнал что метрики для неё не подтянутся.

Маппинг «Glossary creator name → env-переменная с acct» лежит в [backend/src/config/creators.ts](backend/src/config/creators.ts). Чтобы добавить новую модель: завести строку там и переменную в `.env`.

## Глоссарий метрик (что значат поля)

| Поле | Что значит | Откуда берётся |
|---|---|---|
| **Clicks** | Сколько раз кликнули на трекинг-ссылку | OnlyFansAPI |
| **Subs** | Подписки, атрибутированные к кликам (окно 90 минут после клика) | OnlyFansAPI |
| **Spenders** | Сколько из подписчиков потратили хоть что-то (тип, разовая покупка, платная подписка) | OnlyFansAPI |
| **Revenue** | Общая выручка от привлечённых фанатов: подписки + чаевые + покупки | OnlyFansAPI |
| **CR%** | Conversion Rate = Subs ÷ Clicks. Показывает качество трафика. | вычисляется |
| **ARPS** | Average Revenue Per Subscriber = Revenue ÷ Subs. Средний чек на подписчика. | вычисляется |
| **CPF** | Cost Per Fan — фикс-ставка за подписку. Может быть двойная: free / paid. | Glossary |
| **RevShare** | Процент от выручки. Например 30% = с каждых $100 партнёр получает $30. | Glossary |
| **Payout** | Сколько мы должны выплатить партнёру. Считается из метрик и ставок. | вычисляется |
| **Type** | External — внешний арбитражник. In-house — наша команда. | Glossary |
| **Source** | Платформа основного трафика партнёра (IG, TikTok, …). | Glossary |
| **Monthly fee** | Фиксированный месячный гонорар сверху ставок. | редактируется в дашборде |

Все эти определения доступны как inline-подсказки в UI: наведи мышь на `?` рядом с заголовком колонки.

## Расчёт payout (текущая формула)

```
RevShare:  payout = revenue × revshare_pct
CPF:       payout = subs × (cpf_paid ?? cpf_free)
Гибрид:    payout = MAX(CPF, RevShare)         ← TODO согласовать
Monthly:   monthly_fee — добавляется сверху отдельной строкой (пока не суммируется автоматически)
```

Формула в [frontend/src/pages/PartnerDetail.tsx](frontend/src/pages/PartnerDetail.tsx) в функции `calcPayout`. Когда согласуем финал — перенесу в backend.

## Парсинг Glossary

Логика в [backend/src/glossary/parse.ts](backend/src/glossary/parse.ts):

| Вход | Разбор |
|---|---|
| `"NIKO @niko_couture_affiliate"` | name=`NIKO`, telegram=`@niko_couture_affiliate` |
| `"Vlad \| @geekachad "` | name=`Vlad`, telegram=`@geekachad` |
| `"NEW"` | name=`NEW`, telegram=`null` |
| `"$0,90"` (CPF) | free=0.90, paid=null |
| `"$0,90/$3,50"` (CPF dual) | free=0.90, paid=3.50 |
| `"0.30"` (RevShare) | 0.30 |
| `"30%"` (RevShare) | 0.30 |

Импорт **идемпотентен** — повторный запуск обновляет существующие строки (upsert по `glossary_name` для партнёров и по `of_url` для ссылок).

## Деплой (M6, после M3)

- Backend: systemd-сервис, рядом с Couture-ботом (`/home/openclaw/couture-dashboard/backend`)
- Frontend: build → отдаётся через nginx как статика
- nginx reverse-proxy: `dashboard.домен/api/*` → backend :3001, `/*` → frontend dist
- HTTPS через certbot
- Auth — простой пароль `DASHBOARD_PASSWORD` в `.env` (basic auth на nginx-уровне или middleware Fastify)

## Что осталось проверить с тобой

1. **Adult Angels** — CPF $1.50 + RevShare 30% одновременно? Если да — текущая модель данных это поддерживает (обе колонки заполнятся).
2. **Расчёт выплаты** — формула? Сейчас не считаем. Вероятная схема:
   - Если есть CPF → `payout = subs × cpf_paid + free_subs × cpf_free` (нужно поле free vs paid в snapshot)
   - Если есть RevShare → `payout = revenue × revshare_pct`
   - Если обе → ?
3. **Какие колонки добавить в карточку партнёра** для управления? Сейчас только `monthly_fee` и `notes`.
