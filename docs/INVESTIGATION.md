# OnlyFansAPI Investigation — Fan Attribution Ledger (Phase 1)

> Snapshot of what is **fact** vs **inferred** about OnlyFansAPI, captured before building the
> fan-level ledger. Source: OnlyFansAPI docs (docs.onlyfansapi.com) + empirical probes on the
> connected Free account (`acct_2fb834…`). Doc-derived payload field names must still be confirmed
> against one live payload before the ingestion normalizer is frozen.

## 1. Fan identity — `user_id` is GLOBAL ✅

- The OnlyFans **user id** (`fan.id` / `onlyfans_id`) is the same value across creator accounts —
  it is **not** account-scoped. → `of_fan_id` is a valid cross-account canonical key for matching a
  fan between Nekoletta Free and Nekoletta VIP.
- **Normalizer caveat:** the id arrives under different field names per event/endpoint:
  `fan.id`, `user_id`, `fromUser.id`, `toUser.id`, `onlyfans_id`. Ingestion MUST map all variants to
  one `of_fan_id`.
- **Empirical (Free):** 10 tracking links / 260 subscriber rows → 260 distinct `of_fan_id`, zero
  cross-link overlap. Looks like a sandbox account (usernames `uXXXXXXXX`, expiry dates in 2036,
  revenue $9.60). Production behaviour will differ.
- **Still blocked:** empirical Free↔VIP id-equality check needs `ONLYFANSAPI_ACCOUNT_VIP` (not yet
  provided).

### Identity rules locked for Phase 1
- `of_fan_id` = primary canonical key.
- Same `of_fan_id`, different username → same fan; update username history + `last_seen_at`.
- Same username, different `of_fan_id` → **inferred** match only
  (`match_method = same_username_same_model_group`), stored with confidence, **never used for payout**.

## 2. Timestamps — real subscribe time EXISTS ✅ (current code stores the wrong field 🐞)

- Fan/subscription objects expose `subscribedOnData.subscribeAt`, `expiredAt`, `renewedAt`, and
  nested `subscribes[].startDate/expireDate`. Webhook events carry `createdAt` / `created_at`.
  → real `source_event_at` is achievable.
- **Bug in current code:** `routes/links.ts` writes `link_subscribers.subscribed_at` from
  `subscribedByExpireDate` (the **expiry** date — hence the "2036" values), not the subscribe date.
- The tracking-link `/subscribers` endpoint does **not** reliably return the subscribe date; the real
  `subscribeAt` lives on the fans / user-details endpoint. Backfill first-touch must use that source,
  or fall back to `observed_at` + `is_inferred = true`.

### Ledger rule locked
- `observed_at` = when our software saw it. `source_event_at` = real OF timestamp when available.
  Never present `observed_at` as the real event time.

## 3. LiveSync — webhook-first works, with documented blind spots 🟡

Webhooks are available on all plans. Confirmed event types:

| Category | Events | Key fields (per docs, confirm live) |
|---|---|---|
| Subscriptions | `subscriptions.new`, `subscriptions.renewed` | `user_id`, `createdAt` |
| Transactions | `transactions.new` (sub/tip/post/PPV) | `id`, `created_at`, `type`, `amount`, `fan.id` |
| Tips | `tips.received` | `user_id`, `amountGross`, `amountNet` |
| Messages | `messages.received`, `messages.sent`, `messages.ppv.unlocked`, `messages.deleted` | `fromUser.id`/`toUser.id`, `createdAt`, `text`, `price` |
| Users | `users.typing`, `users.online`, `users.offline` | `fan.id`, `observed_at`, `status_changed_at` |
| Posts | `posts.liked` | `user_id` |
| Accounts | connected / reconnected / session_expired / auth_failed / otp | — |

### NOT available as webhooks (must be reconciliation/derived)
- ❌ **subscription expired / cancelled** → reconciliation polling (diff active state / expireDate).
- ❌ **chargebacks / refunds** → poll the chargebacks endpoint.
- ❌ **message read / seen / opened in real time** → OnlyFans does not expose read events live.
  Read status is only the `isNew` field on a message → derived by polling + diff. `is_inferred = true`,
  no exact read timestamp.
- ❌ **reply** as a distinct event → derived: `messages.received` correlated to a prior `messages.sent`.

### Infra prerequisite (Phase 2)
- Webhooks POST to a **public URL**. Current setup is `localhost` only → live delivery needs a tunnel
  (cloudflared/ngrok) in dev or a deploy (M6). Webhook ingestion can be **built** in Phase 1/2, but
  cannot **receive** until reachable. The existing `/api/webhooks/of` envelope parsing is a placeholder
  and must be rewritten to the real OF event shape.

## 4. Free Trial Links — separate system, OF already splits revenue ⚠️

- FTL are a **separate** endpoint family (create/manage + analytics, subscribers, spenders).
- On **link stacking**, OF **divides revenue equally across the stacked links**. Part of the
  attribution split is therefore done OF-side — relevant to overlap/attribution design.
- `listSmartLinks()` exists in `of/client.ts` but is **never wired in** → FTL are currently not
  ingested at all. Phase 1 ledger is schema-ready for them; ingestion comes later.

## 5. Source-of-truth map per event (drives `fan_events.source`)

| Spec event | Real source | Flags |
|---|---|---|
| subscription_new / renewed | webhook | `source_event_at = createdAt` |
| transaction / tip / ppv_purchase | webhook | — |
| subscription_expired | reconciliation only | `is_inferred = true` |
| chargeback / refund | reconciliation (chargebacks endpoint) | — |
| message_sent / received | webhook | — |
| message_read / opened | poll `isNew` diff | `is_inferred = true`, no exact time |
| reply_received | derived (received ↔ prior sent) | `is_inferred = true` |
| no_activity_after_48h | computed | not an OF event |

## Decisions locked for Phase 1

- `model_group = Nekoletta`; creators: `Nekoletta Free` (type `free`), `Nekoletta Vip` (type `vip`).
- `of_fan_id` primary; username inferred-only; inferred never affects payout.
- First Touch for CPF = **first confirmed subscriber/link touch**, not a click.
- CPF paid **once**, to the first-touch partner. Repeat/resubscribe via another link → no second CPF.
- Free→VIP organic revenue = **agency analytics**, not partner payout. Direct VIP partner links pay per Glossary.
- Payout = `cpf_component + revshare_component` **per Glossary** (not the old `MAX(...)`); backend is authoritative.
- Webhook ingestion → Phase 2. Message read/reply quality → Phase 3.

## Open blockers
1. `ONLYFANSAPI_ACCOUNT_VIP` — needed for live Free↔VIP id check and Free→VIP analytics.
2. Public URL / tunnel / deploy — needed for live webhook delivery (Phase 2).
3. One live payload capture (raw subscriber, transaction, fan w/ `subscribedOnData`) to freeze the
   normalizer field names before Phase 2 ingestion.
