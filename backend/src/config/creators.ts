/**
 * Каждый Creator (модель) = отдельный OnlyFans-аккаунт.
 * Связка имени в Glossary с переменной окружения, где хранится acct_XXX.
 *
 * Когда появятся новые модели — добавь сюда строку и заведи env-переменную.
 */
const CREATOR_ENV_MAP: Record<string, string> = {
  "Nekoletta Free": "ONLYFANSAPI_ACCOUNT_FREE",
  "Nekoletta Vip": "ONLYFANSAPI_ACCOUNT_VIP",
};

export function getAccountIdForCreator(name: string): string | null {
  const envKey = CREATOR_ENV_MAP[name];
  if (!envKey) return null;
  return process.env[envKey] ?? null;
}

export function creatorSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}
