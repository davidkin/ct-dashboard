import Database from "better-sqlite3";

/**
 * Identity resolution для Global Fan.
 *
 * Правила (Phase 1):
 *  1. of_fan_id — главный канон. Совпал of_fan_id → тот же фан.
 *  2. of_fan_id совпал, username другой → тот же фан, обновляем username/last_seen.
 *  3. username совпал, of_fan_id РАЗНЫЙ → НЕ склеиваем. Создаём отдельного фана
 *     и пишем inferred-match в fan_identity_matches (evidence). В payout не используется.
 *  4. Нет ни того, ни другого → новый Global Fan.
 *
 * Identity = (of_account_id, of_fan_id): один и тот же глобальный of_fan_id на Free и Vip
 * = две identity под одним fan.
 */

export type MatchMethod =
  | "exact_of_fan_id"
  | "new_fan"
  | "same_username_same_model_group";

export interface IdentityInput {
  ofFanId: string | null;
  username: string | null;
  ofAccountId: string | null;
  creator: string | null;
  modelGroup: string | null;
  sourceEndpoint: string;
  /** Реальное время из OnlyFansAPI, если известно (source_event_at). */
  sourceEventAt?: string | null;
  rawJson?: string | null;
}

export interface ResolvedIdentity {
  fanId: number;
  identityId: number;
  isNewFan: boolean;
  matchMethod: MatchMethod;
  /** id inferred-кандидата, если по username нашёлся другой of_fan_id. */
  inferredAgainstIdentityId?: number;
}

export function normalizeUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "");
  return v.length ? v : null;
}

/**
 * Разрешить identity и вернуть fan_id/identity_id. Идемпотентно.
 * Вызывать внутри транзакции при батче.
 */
export function resolveIdentity(db: Database.Database, input: IdentityInput): ResolvedIdentity {
  const norm = normalizeUsername(input.username);
  const sea = input.sourceEventAt ?? null;

  // 1. Точное совпадение identity по (account, of_fan_id).
  if (input.ofFanId) {
    const existing = db
      .prepare(
        `SELECT id, fan_id FROM fan_identities
         WHERE of_fan_id = ? AND (of_account_id IS ? OR of_account_id = ?)`,
      )
      .get(input.ofFanId, input.ofAccountId, input.ofAccountId) as
      | { id: number; fan_id: number }
      | undefined;
    if (existing) {
      touchIdentity(db, existing.id, input.username, norm, sea);
      touchFan(db, existing.fan_id, input.ofFanId, input.username, norm, sea);
      return {
        fanId: existing.fan_id,
        identityId: existing.id,
        isNewFan: false,
        matchMethod: "exact_of_fan_id",
      };
    }

    // 2. Тот же глобальный of_fan_id, но другой аккаунт → та же сущность fan, новая identity.
    const sameFan = db
      .prepare(`SELECT id FROM fans WHERE primary_of_fan_id = ?`)
      .get(input.ofFanId) as { id: number } | undefined;
    if (sameFan) {
      const identityId = insertIdentity(db, sameFan.id, input, norm, sea);
      touchFan(db, sameFan.id, input.ofFanId, input.username, norm, sea);
      return {
        fanId: sameFan.id,
        identityId,
        isNewFan: false,
        matchMethod: "exact_of_fan_id",
      };
    }
  }

  // 3. username совпал, of_fan_id другой → inferred, отдельный фан + evidence.
  let inferredAgainst: { id: number } | undefined;
  if (norm) {
    inferredAgainst = db
      .prepare(
        `SELECT id FROM fan_identities
         WHERE normalized_username = ?
           AND (model_group IS ? OR model_group = ?)
           AND (? IS NULL OR of_fan_id IS NULL OR of_fan_id <> ?)
         LIMIT 1`,
      )
      .get(norm, input.modelGroup, input.modelGroup, input.ofFanId, input.ofFanId) as
      | { id: number }
      | undefined;
  }

  // 4. Новый Global Fan.
  const fanId = insertFan(db, input.ofFanId, input.username, norm, sea);
  const identityId = insertIdentity(db, fanId, input, norm, sea);

  if (inferredAgainst) {
    recordMatch(db, {
      fanId,
      identityAId: inferredAgainst.id,
      identityBId: identityId,
      matchMethod: "same_username_same_model_group",
      confidence: 0.5,
      isExact: 0,
      evidence: { normalized_username: norm, model_group: input.modelGroup },
    });
    return {
      fanId,
      identityId,
      isNewFan: true,
      matchMethod: "same_username_same_model_group",
      inferredAgainstIdentityId: inferredAgainst.id,
    };
  }

  return { fanId, identityId, isNewFan: true, matchMethod: "new_fan" };
}

function insertFan(
  db: Database.Database,
  ofFanId: string | null,
  username: string | null,
  norm: string | null,
  sourceEventAt: string | null,
): number {
  const res = db
    .prepare(
      `INSERT INTO fans (primary_of_fan_id, primary_username, normalized_username, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`,
    )
    .run(ofFanId, username ?? null, norm, sourceEventAt, sourceEventAt);
  return Number(res.lastInsertRowid);
}

function insertIdentity(
  db: Database.Database,
  fanId: number,
  input: IdentityInput,
  norm: string | null,
  sourceEventAt: string | null,
): number {
  const res = db
    .prepare(
      `INSERT INTO fan_identities
         (fan_id, of_account_id, creator, model_group, of_fan_id, username, normalized_username,
          source_endpoint, first_seen_at, last_seen_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?)`,
    )
    .run(
      fanId,
      input.ofAccountId,
      input.creator,
      input.modelGroup,
      input.ofFanId,
      input.username ?? null,
      norm,
      input.sourceEndpoint,
      sourceEventAt,
      sourceEventAt,
      input.rawJson ?? null,
    );
  return Number(res.lastInsertRowid);
}

function touchIdentity(
  db: Database.Database,
  identityId: number,
  username: string | null,
  norm: string | null,
  sourceEventAt: string | null,
): void {
  db.prepare(
    `UPDATE fan_identities SET
       username = COALESCE(?, username),
       normalized_username = COALESCE(?, normalized_username),
       last_seen_at = MAX(COALESCE(last_seen_at, ''), COALESCE(?, datetime('now'))),
       first_seen_at = MIN(COALESCE(first_seen_at, datetime('now')), COALESCE(?, first_seen_at, datetime('now'))),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(username ?? null, norm, sourceEventAt, sourceEventAt, identityId);
}

function touchFan(
  db: Database.Database,
  fanId: number,
  ofFanId: string | null,
  username: string | null,
  norm: string | null,
  sourceEventAt: string | null,
): void {
  db.prepare(
    `UPDATE fans SET
       primary_of_fan_id = COALESCE(primary_of_fan_id, ?),
       primary_username = COALESCE(primary_username, ?),
       normalized_username = COALESCE(normalized_username, ?),
       last_seen_at = MAX(COALESCE(last_seen_at, ''), COALESCE(?, datetime('now'))),
       first_seen_at = MIN(COALESCE(first_seen_at, datetime('now')), COALESCE(?, first_seen_at, datetime('now'))),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(ofFanId, username ?? null, norm, sourceEventAt, sourceEventAt, fanId);
}

interface MatchRow {
  fanId: number;
  identityAId: number;
  identityBId: number;
  matchMethod: MatchMethod;
  confidence: number;
  isExact: 0 | 1;
  evidence: unknown;
}

function recordMatch(db: Database.Database, m: MatchRow): void {
  db.prepare(
    `INSERT INTO fan_identity_matches
       (fan_id, identity_a_id, identity_b_id, match_method, confidence, is_exact, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(identity_a_id, identity_b_id, match_method) DO UPDATE SET
       confidence = excluded.confidence,
       evidence_json = excluded.evidence_json`,
  ).run(
    m.fanId,
    m.identityAId,
    m.identityBId,
    m.matchMethod,
    m.confidence,
    m.isExact,
    JSON.stringify(m.evidence ?? null),
  );
}
