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
  type: CreatorType;
  modelGroup: string;
}

const CREATOR_CONFIG: Record<string, CreatorConfig> = {
  "Nekoletta Free": { envKey: "ONLYFANSAPI_ACCOUNT_FREE", omEnvKey: "ONLYMONSTER_ACCOUNT_FREE", type: "free", modelGroup: "Nekoletta" },
  "Nekoletta Vip": { envKey: "ONLYFANSAPI_ACCOUNT_VIP", omEnvKey: "ONLYMONSTER_ACCOUNT_VIP", type: "vip", modelGroup: "Nekoletta" },
};

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
