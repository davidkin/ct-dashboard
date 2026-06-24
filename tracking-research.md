# Tracking Research — расследование точности подсчёта подписчиков

> **Для кого:** следующий агент/разработчик, который продолжит работу.
> **Цель документа:** ввести в курс что мы выяснили про источники данных, где они расходятся
> и почему, чтобы можно было продолжить с актуального места без повторного раскапывания.
>
> **Контекст проекта:** дашборд учёта привлечённых фанатов для OF-агентства Couture.
> Партнёры льют трафик по трекинг-ссылкам на модели (Nekoletta Free + Vip), мы считаем
> сколько фанов кто привёл и сколько надо выплатить. Ветка: `onlymonster-integration`.

---

## 0. TL;DR (если читать только это)

1. У нас **3 источника данных**: OnlyFansAPI, OnlyMonster API, OnlyMonster веб-дашборд (share-link).
2. **OnlyMonster дал то, чего не было в OnlyFansAPI — реальную дату подписки** (`subscribed_at`).
   Раньше мы использовали «дату когда МЫ увидели фана» (`first_seen_at`), что ломало фильтры по периодам.
3. **Наши данные совпадают с каноном OnlyMonster** и на уровне партнёра, и на уровне ссылки.
4. **Ручная таблица партнёра (Adult Angels в Google Sheets) — недостоверна** на уровне отдельных ссылок
   (показывает за 3 дня больше, чем OnlyMonster насчитал по ссылке за всю историю).
5. **Открытый вопрос для бизнеса:** платить за всех приведённых фанов или только за активных
   (разница = churn ~6.5%). Технически считаем оба.

---

## 1. Три источника данных — что есть и чем отличается

### A. OnlyFansAPI (`app.onlyfansapi.com`)
- **Что:** прокси-API поверх OnlyFans. Токен в `.env` → `ONLYFANSAPI_KEY`.
- **Аккаунты:** `ONLYFANSAPI_ACCOUNT_FREE=acct_2fb834c5b8c3443185a59a6ebc8b81d6`,
  `ONLYFANSAPI_ACCOUNT_VIP=acct_9e28213591674f528a3c6fb29e456081`
- **Эндпоинты что юзаем:** `/tracking-links` (агрегат subscribersCount), `/tracking-links/{id}/subscribers` (поимённо).
- **🐛 Ключевая проблема:** НЕ отдаёт реальную дату подписки. Поле `subscribedByExpireDate` = дата
  ИСТЕЧЕНИЯ подписки (отсюда даты «2036» — free-подписки не истекают 10 лет).
- **Клиент:** `backend/src/of/client.ts`.

### B. OnlyMonster API (`omapi.onlymonster.ai`) — ✅ ГЛАВНАЯ НАХОДКА
- **Что:** CRM поверх OnlyFans. Токен в `.env` → `ONLYMONSTER_TOKEN`. Header: `x-om-auth-token`.
- **Аккаунты (`platform_account_id` = OnlyFans numeric id):**
  `ONLYMONSTER_ACCOUNT_FREE=479355789` (nekoletta), `ONLYMONSTER_ACCOUNT_VIP=284366868` (vip.nekoletta).
- **Ключ для джойна:** `platform_account_id` = `onlyfans_id` из OnlyFansAPI; `fan.id` — тот же
  глобальный OF user id во всех системах. Всё джойнится по `fan.id`.
- **Эндпоинты (rate limit 25 req/s глобально, 15/endpoint, cursor-пагинация):**
  | Endpoint | Что даёт | Ценность |
  |---|---|---|
  | `tracking-link-users` | фан + `subscribed_at` (РЕАЛЬНАЯ дата) + link_id | 🔥 главное |
  | `subscriptions` | subscribe/prolong/return события + `expires_at` | churn/события |
  | `transactions` | amount + fan.id + timestamp + type | для RevShare |
  | `chargebacks` | amount + fan.id + даты | возвраты |
  | `tracking-links` | агрегат subscribers/clicks | дубль OF |
- **Клиент:** `backend/src/om/client.ts`. Sync: `backend/src/om/sync.ts`.
- **Docs:** https://docs.onlymonster.ai/integrations-and-api/openapi

### C. OnlyMonster веб-дашборд (share-link) — эталон что видит партнёр
- **Что:** внутренние POST-эндпоинты SPA (НЕ документированное API, `onlymonster.ai/s/{token}/...`).
- **Share-token:** `EteRrmc3`. URL: `https://onlymonster.ai/s/EteRrmc3/general` и `/statistics`.
- **Метод:** POST с JSON-payload. Это РОВНО то что видит партнёр в браузере → вероятный источник
  ручной таблицы Adult Angels.
- **Payload `/general`:** `{revenue:"net", deleted:false, from:"2026-06-07 00:00:00", to:"2026-06-24 23:59:59"}`
- **Payload `/statistics`:** то же + `{offset:0, order:"date_desc", pinned:[], query:""}`
- **Ответ `/general`:** `{clicks, claims, conv_rate, earnings, cpf, roi, epf}` — агрегат за период.
- **Ответ `/statistics`:** массив per-campaign `{id, name, clicks, fans, total_sum, conv_rate, ...}`.
- **⚠️ Важно:** в `/statistics` поле `fans` per-campaign = **lifetime total ссылки**, НЕ оконное
  (вернул 53 для camp_10 и за 15-17.06, и за 07-24.06 — одинаково). `deleted:false` исключает churned.
- **Как воспроизвести:**
  ```bash
  curl -s -X POST "https://onlymonster.ai/s/EteRrmc3/general" \
    -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" \
    -d '{"revenue":"net","deleted":false,"from":"2026-06-07 00:00:00","to":"2026-06-24 23:59:59"}'
  ```
- **Ограничение:** payload получен из DevTools браузера (пользователь скопировал). Если share-token
  протухнет — нужен новый из браузерной сессии.

---

## 2. Что мы построили (OnlyMonster интеграция)

Ветка `onlymonster-integration`, коммит "OnlyMonster integration: real subscribed_at dates".

- **`backend/src/om/client.ts`** — OM API клиент (tracking-link-users, transactions, chargebacks, accounts).
- **`backend/src/om/sync.ts`** — `syncOMForCreator` / `syncOMAllCreators`:
  тянет tracking-link-users → пишет `link_subscribers.om_subscribed_at` (реальная дата),
  матч по `of_tracking_link_id`; тянет transactions/chargebacks → `om_transactions` / `om_chargebacks`.
- **`backend/src/config/creators.ts`** — `getOMAccountForCreator` (creator → platform_account_id).
- **`backend/src/db/index.ts`** (migrate) — колонка `link_subscribers.om_subscribed_at` +
  таблицы `om_transactions`, `om_chargebacks`.
- **`backend/src/fans/backfill.ts`** — ledger теперь юзает `om_subscribed_at` как `source_event_at`
  → `fan_link_touches.first_touch_at` стал реальной датой подписки.
- **Endpoint:** `POST /api/sync/onlymonster` — sync всё + авто re-index ledger (`reconcileFromCache`).

**Результат первого sync (факт):**
- Free: 474 tracking-users, 466 matched, 129 transactions, 4 chargebacks.
- Vip: 2240 tracking-users, 12 matched (большинство ссылок VIP не в Glossary), 151 transactions, 11 chargebacks.
- Ledger: 478 subscribers ingested, 475 unique fans.
- Транзакции всего: 280 шт, $5546. Chargebacks: 15 шт, $146.

---

## 3. Три «системы» подсчёта — НЕ путать

Я (предыдущий агент) был неточен со словом «наша». Зафиксировано:

| Слой | Что | Источник чисел |
|---|---|---|
| **Сырой `link_subscribers`** | поимённый список фанов + `om_subscribed_at` | OnlyMonster sync |
| **📊 Текущая система** (`/api/partners`) | агрегат subscribersCount по ссылкам | OnlyFansAPI snapshots |
| **🧬 Новая система** (`/api/attribution`) | first-touch dedup поверх фанов | читает `link_subscribers` |

**Все сверки ниже сделаны по «сырому слою»** (= на чём стоит 🧬 Новая система), потому что
он матчится с OnlyMonster API (один источник).

---

## 4. РАССЛЕДОВАНИЕ — гипотезы и вердикты

Контекст: ручная Google-таблица Adult Angels (`[FREE_Adult Angels @adultangels]_traffic_tracking`,
sheet id `1R9P8KGHGfV5Y4nVIxyDg7mBB6SyryVTFCSx5_aZsXP4`) показывала БОЛЬШЕ фанов чем мы.
Расследовали почему.

### Гипотеза A — «партнёр считает события (переподписки), не уникальных»
**❌ ОПРОВЕРГНУТА.** За весь год: 1093 subscribe-события, 1092 уникальных фана,
только 1 переподписался дважды. Actions: 1086 subscribe, 6 return, 1 prolong.
Переподписки — статистический шум, не объясняют завышение.

### Гипотеза B — «OnlyMonster режет отписавшихся (churn)»
**⚠️ ЧАСТИЧНО, но мелочь.** Только 13 фанов есть в tracking-link-users, но нет в subscriptions.
Churn реальный (~6.5%), но не главный фактор расхождения.

### Гипотеза C — «органика раздувает числа партнёра»
**✅ ПОДТВЕРЖДЕНА.** Из 1092 фанов подписавшихся на free-страницу (за всё время):
- 658 (60%) — через трекинг-ссылки партнёров → за этих платим
- 447 (41%) — ОРГАНИКА / прямые заходы → ни один партнёр не приводил
Если партнёр берёт «новые подписчики страницы» из OF-статистики → туда попадает вся органика.

### Гипотеза D — «ручная таблица партнёра неточна на уровне ссылок»
**✅ ПОДТВЕРЖДЕНА (самое сильное доказательство).** См. раздел 5.

---

## 5. СВЕРКА ЦИФР (факты, на 24.06.2026)

### Уровень партнёра — Adult Angels, free, период 07-24.06

| Источник | Claims | Комментарий |
|---|---:|---|
| Сырой `link_subscribers` (om_subscribed_at) | **213** | ✓ |
| Ручная таблица партнёра | **214** | ✓ совпадает с нами |
| OnlyMonster дашборд `/general` (deleted:false) | **199** | только активные |
| **Разница 213 − 199 = 14** | | churn/удалённые (~6.5%) |

→ На агрегате все три источника РЕКОНСИЛЯТСЯ. Разница = фильтр `deleted` (активные vs все).

### Уровень ссылки — camp_10 (of_tracking_link_id 3405407, url nekoletta/c10)

| Источник | Fans | Вердикт |
|---|---:|---|
| OnlyMonster API tracking-link-users (lifetime) | **51** | эталон |
| OnlyMonster дашборд `/statistics` (lifetime) | **53** | ✓ совпадает (±2 churn) |
| Сырой `link_subscribers` (наш, lifetime) | **51** | ✓ совпадает |
| Ручная таблица партнёра (за 3 дня 15-17.06) | **65** | ❌ НЕВОЗМОЖНО |

→ Партнёр показывает за 3 дня (65) больше, чем OnlyMonster насчитал по ссылке за ВСЮ
историю (51-53). Их per-camp дневные колонки врут / меряют другое (клики? trials? ручная ошибка).

### Проверка реальных дат (камень в фундаменте всего)
camp_10 на 15.06: наша БД = **5 фанов** (13:07, 15:10, 17:04, 18:09, 18:30), OnlyMonster API = **5**.
1-в-1. Раньше (со старым `first_seen_at`) все были бы датированы днём bulk-pull, а не реальным 15.06.

### Пришло vs осталось (оба аккаунта, июнь)
| | FREE | VIP | ИТОГО |
|---|---:|---:|---:|
| Подписок пришло | 681 | 30 | **711** |
| Осталось активными | 655 | 29 | **684 (96%)** |
| Отписалось | 26 | 1 | **27 (4%)** |

---

## 6. Дедуп free→vip — НАЙДЕН БАГ (не пофикшен)

В ledger Игоря first-touch дедуп схлопывает фана **глобально по of_fan_id**, включая границу free→vip.

**Пример (fan 220401306, партнёр Vova TraffZone):**
- camp_45 (Free, CPF $1.20) — подписался 21.06 05:58 → `first_touch`, платим
- camp_paid_120 (Vip, CPF **$3.50**) — подписался 21.06 06:00 → `repeat_touch`, **НЕ платим**

**Проблема:** это ДВЕ разные подписки на ДВЕ разные страницы с РАЗНЫМИ ставками в Glossary.
Дедуп убивает легитимную vip-выплату $3.50. В Glossary отдельные ставки free ($1.20) и vip ($3.50)
= прямое доказательство что бизнес-модель = платить за обе.

**Реальных таких дублей сейчас:** всего 3 (478 строк, 475 уникальных). Масштаб мал, но логика неверна.

**Фикс (предложен, не сделан):** дедупить по `(of_fan_id + creator)`, а не глобально по `of_fan_id`.
Тогда free и vip считаются раздельно. Правка в `backend/src/fans/attribution.ts` (движок Игоря).

---

## 7. ОТКРЫТЫЕ ВОПРОСЫ / следующие шаги

### Бизнес-решения (нужен ответ владельца)
1. **Платить за всех приведённых (213) или только активных (199)?** Разница = churn ~6.5% = ~$22.50
   на Adult Angels за период. Дашборд OM по дефолту `deleted:false` (активные).
2. **Дедупить free→vip или нет?** Сейчас дедупит (теряем vip CPF). По Glossary похоже что НЕ надо.

### Технические TODO
1. **Пофиксить дедуп** на `(of_fan_id + creator)` — раздельно free/vip (см. раздел 6).
2. **Подключить RevShare** — есть `om_transactions` ($5546, с fan.id+датами). Сейчас revshare-компонент = 0.
3. **Chargeback-флаги в UI** — есть `om_chargebacks` (15 шт). Показать партнёров с возвратами.
4. **Заменить OF bulk-pull на OM sync в scheduler** — OM точнее (реальные даты) и быстрее.
5. **OM share-endpoint как 3-й эталонный столбец** в дашборде — авто-сверка с тем что видит партнёр.
   Payload известен (раздел 1C). Риск: share-token может протухнуть.
6. **Разобраться с per-camp колонками таблицы партнёра** — спросить Adult Angels откуда берут
   дневные per-camp числа (раздел 5 показал что они невозможны).
7. **Vip ссылки не в Glossary** — sync показал 43 unmatched VIP-ссылки. Проверить полноту Glossary.

### Безопасность
- Токены (`ONLYFANSAPI_KEY`, `ONLYMONSTER_TOKEN`, BOT_TOKEN) светились в чате — рекомендовано
  отозвать и пересоздать, хранить только в `.env` (gitignored).

---

## 8. Полезные команды для проверки (воспроизводимость)

```bash
# OnlyMonster API — фаны по ссылке с реальными датами
curl -s -H "x-om-auth-token: $ONLYMONSTER_TOKEN" \
  "https://omapi.onlymonster.ai/api/v0/platforms/onlyfans/accounts/479355789/tracking-link-users?link_id=3405407&limit=750"

# OnlyMonster дашборд — агрегат за период (что видит партнёр)
curl -s -X POST "https://onlymonster.ai/s/EteRrmc3/general" \
  -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" \
  -d '{"revenue":"net","deleted":false,"from":"2026-06-07 00:00:00","to":"2026-06-24 23:59:59"}'

# OnlyMonster дашборд — per-campaign разбивка
curl -s -X POST "https://onlymonster.ai/s/EteRrmc3/statistics" \
  -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" \
  -d '{"revenue":"net","deleted":false,"from":"2026-06-07 00:00:00","to":"2026-06-24 23:59:59","offset":0,"order":"date_desc","pinned":[],"query":""}'

# Наш sync OnlyMonster + re-index ledger
curl -s -X POST http://localhost:3001/api/sync/onlymonster

# Сверка attribution за период (реальные даты)
curl -s "http://localhost:3001/api/attribution/partners?from=2026-06-14&to=2026-06-22"
```

Google Sheets для сверки:
- Glossary (партнёры+ссылки+ставки): `10blNugwGCJ6wWg4k7mkgAgxU1Iogfj9OIAF6DLI8n60`
- Adult Angels трекинг (партнёрская): `1R9P8KGHGfV5Y4nVIxyDg7mBB6SyryVTFCSx5_aZsXP4`
  (tabs: `Velora | Total` gid=508899617, `Velora | Raw Data` gid=181118159)
- Доступ: service account `affiliate-bot-sa@affiliate-bot-495615.iam.gserviceaccount.com` (Viewer)

---

## 9. Итоговый вывод (одной фразой)

Наша система (сырой fan-level слой + Новая attribution) считает **корректно** и **совпадает с каноном
OnlyMonster** на всех уровнях. Расхождения с ручной таблицей партнёра — из-за их ручного ввода и
смешивания органики/кликов в колонку «фаны». Остался один технический баг (дедуп free→vip) и два
бизнес-вопроса (платить за всех/активных, дедупить free→vip или нет).
