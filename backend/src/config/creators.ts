/**
 * Каждый Creator (модель) = отдельный OnlyFans-аккаунт.
 * Связка имени в Glossary с env-переменной (acct_XXX), типом (free/vip) и model_group.
 *
 * model_group объединяет Free и Vip одной модели — нужен для Free→VIP аналитики
 * и для inferred username-матчей в рамках одной модели.
 *
 * Когда появятся новые модели — добавь сюда строку и заведи env-переменную.
 */
export type CreatorType = "free" | "vip";

interface CreatorConfig {
  envKey: string;
  /** env-переменная с OnlyMonster platform_account_id (OF numeric id) */
  omEnvKey: string;
  /** env-переменная с OM-токеном: токен выдаётся на организацию, у каждой модели свой */
  omTokenEnvKey: string;
  type: CreatorType;
  modelGroup: string;
}

const CREATOR_CONFIG: Record<string, CreatorConfig> = {
  "Nekoletta Free": { envKey: "ONLYFANSAPI_ACCOUNT_FREE", omEnvKey: "ONLYMONSTER_ACCOUNT_FREE", omTokenEnvKey: "ONLYMONSTER_TOKEN", type: "free", modelGroup: "Nekoletta" },
  "Nekoletta Vip": { envKey: "ONLYFANSAPI_ACCOUNT_VIP", omEnvKey: "ONLYMONSTER_ACCOUNT_VIP", omTokenEnvKey: "ONLYMONSTER_TOKEN", type: "vip", modelGroup: "Nekoletta" },
  "Lily Free": { envKey: "ONLYFANSAPI_ACCOUNT_LILY_FREE", omEnvKey: "ONLYMONSTER_ACCOUNT_LILY_FREE", omTokenEnvKey: "ONLYMONSTER_TOKEN_LILY", type: "free", modelGroup: "Lily" },
  "Lily Vip": { envKey: "ONLYFANSAPI_ACCOUNT_LILY_VIP", omEnvKey: "ONLYMONSTER_ACCOUNT_LILY_VIP", omTokenEnvKey: "ONLYMONSTER_TOKEN_LILY", type: "vip", modelGroup: "Lily" },
};

/**
 * Модели для переключателя в интерфейсе. group = model_group у creator-ов,
 * label — как модель называют в таблицах (в глоссарии Nekoletta, в листах Velora).
 */
export interface ModelOption {
  group: string;
  label: string;
  /** Модель больше не льётся: скрыта в интерфейсе, но данные и синк остаются. */
  hidden?: boolean;
}

const MODELS: ModelOption[] = [
  { group: "Nekoletta", label: "Velora", hidden: true },
  { group: "Lily", label: "Lily" },
];

/**
 * Список моделей, у которых есть хотя бы один сконфигурированный creator.
 * По умолчанию — только видимые (для интерфейса); includeHidden=true нужен
 * внутренним потребителям (OM-синк, тоталы), чтобы неактивные модели
 * продолжали собираться.
 */
export function listModels(includeHidden = false): ModelOption[] {
  return MODELS.filter(
    (m) => creatorsInModelGroup(m.group).length > 0 && (includeHidden || !m.hidden),
  );
}

export function getAccountIdForCreator(name: string): string | null {
  const cfg = CREATOR_CONFIG[name];
  if (!cfg) return null;
  return process.env[cfg.envKey] ?? null;
}

/** OnlyMonster platform_account_id для creator. */
export function getOMAccountForCreator(name: string): string | null {
  const cfg = CREATOR_CONFIG[name];
  if (!cfg) return null;
  return process.env[cfg.omEnvKey] ?? null;
}

export function getCreatorType(name: string): CreatorType | null {
  return CREATOR_CONFIG[name]?.type ?? null;
}

/** OM-токен для creator. Токен организации, у каждой модели свой. */
export function getOMTokenForCreator(name: string): string | null {
  const cfg = CREATOR_CONFIG[name];
  if (!cfg) return null;
  return process.env[cfg.omTokenEnvKey] ?? null;
}

/**
 * OM-токен по platform_account_id — клиент знает только id аккаунта,
 * а токен привязан к организации модели.
 */
export function getOMTokenForAccount(platformAccountId: string): string | null {
  for (const cfg of Object.values(CREATOR_CONFIG)) {
    if (process.env[cfg.omEnvKey] === platformAccountId) {
      return process.env[cfg.omTokenEnvKey] ?? null;
    }
  }
  return null;
}

/**
 * model_group по имени creator. Если creator не сконфигурирован — фолбэк на само имя
 * (чтобы неизвестные модели не схлопывались в один group и не давали ложных матчей).
 */
export function getModelGroup(name: string | null | undefined): string | null {
  if (!name) return null;
  return CREATOR_CONFIG[name]?.modelGroup ?? name;
}

/** Все creator в одном model_group (например Free + Vip одной модели). */
export function creatorsInModelGroup(modelGroup: string): string[] {
  return Object.entries(CREATOR_CONFIG)
    .filter(([, cfg]) => cfg.modelGroup === modelGroup)
    .map(([name]) => name);
}

export function creatorSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}
