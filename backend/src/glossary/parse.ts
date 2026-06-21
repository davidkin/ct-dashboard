export interface ParsedPartnerName {
  displayName: string;
  telegram: string | null;
}

/**
 * Examples:
 *   "NIKO @niko_couture_affiliate"  → { displayName: "NIKO", telegram: "@niko_couture_affiliate" }
 *   "Vlad | @geekachad "             → { displayName: "Vlad", telegram: "@geekachad" }
 *   "Adult Angels | @adultangels"    → { displayName: "Adult Angels", telegram: "@adultangels" }
 *   "NEW"                            → { displayName: "NEW", telegram: null }
 */
export function parsePartnerName(raw: string): ParsedPartnerName {
  const cleaned = raw.trim();
  const atIdx = cleaned.indexOf("@");
  if (atIdx === -1) {
    return { displayName: cleaned, telegram: null };
  }
  let displayName = cleaned.slice(0, atIdx).trim();
  if (displayName.endsWith("|")) displayName = displayName.slice(0, -1).trim();
  const tgPart = cleaned.slice(atIdx).split(/\s+/)[0].trim();
  return { displayName: displayName || cleaned, telegram: tgPart || null };
}

export interface ParsedCpf {
  free: number | null;
  paid: number | null;
}

/**
 * Examples:
 *   "$0,90"        → { free: 0.90, paid: null }
 *   "$0,90/$3,50"  → { free: 0.90, paid: 3.50 }
 *   "$1,50"        → { free: 1.50, paid: null }
 *   ""             → { free: null, paid: null }
 */
export function parseCpf(raw: string): ParsedCpf {
  const cleaned = (raw || "").trim();
  if (!cleaned) return { free: null, paid: null };
  const parts = cleaned.split("/").map((p) => p.trim());
  const toNum = (s: string): number | null => {
    const m = s.replace(/[$\s]/g, "").replace(",", ".");
    const n = Number(m);
    return Number.isFinite(n) ? n : null;
  };
  const free = parts[0] ? toNum(parts[0]) : null;
  const paid = parts.length > 1 ? toNum(parts[1]) : null;
  return { free, paid };
}

/**
 * Examples:
 *   "0.30" → 0.30
 *   "30%"  → 0.30
 *   ""     → null
 */
export function parseRevshare(raw: string): number | null {
  const cleaned = (raw || "").trim();
  if (!cleaned) return null;
  if (cleaned.endsWith("%")) {
    const n = Number(cleaned.slice(0, -1).replace(",", "."));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(cleaned.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
