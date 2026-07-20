import Database from "better-sqlite3";

/**
 * Authoritative payout calculation (backend = источник истины).
 *
 * payout = cpf_component + revshare_component   (per Glossary, НЕ MAX)
 *   cpf_component      = first-touch eligible fans × rate(cpf_paid ?? cpf_free)
 *   revshare_component = attributed direct-link revenue × revshare_pct
 *
 * CPF считается ТОЛЬКО по first-touch eligible фанам (дедуп: один фан = один CPF).
 * RevShare — только по revenue с attribution_type='direct_link'.
 * monthly_fee НЕ суммируется здесь (показывается отдельной строкой).
 */
export interface LinkPayout {
  link_id: number;
  partner_id: number | null;
  creator: string | null;
  cpf_rate: number | null;
  revshare_pct: number | null;
  cpf_eligible_fans: number;
  cpf_component: number;
  attributed_revenue: number;
  revshare_component: number;
  payout_total: number;
}

export interface PartnerPayout {
  partner_id: number;
  cpf_eligible_fans: number;
  cpf_component: number;
  attributed_revenue: number;
  revshare_component: number;
  payout_total: number;
}

interface LinkRow {
  link_id: number;
  partner_id: number | null;
  creator: string | null;
  cpf_rate: number | null;
  revshare_pct: number | null;
  cpf_eligible_fans: number;
  attributed_revenue: number;
}

export function linkPayouts(db: Database.Database, opts: { creator?: string } = {}): LinkPayout[] {
  const creator = opts.creator?.trim();
  const rows = db
    .prepare(
      `SELECT
         l.id            AS link_id,
         l.partner_id    AS partner_id,
         l.creator       AS creator,
         COALESCE(l.cpf_paid, l.cpf_free) AS cpf_rate,
         l.revshare_pct  AS revshare_pct,
         COALESCE(t.cpf_fans, 0) AS cpf_eligible_fans,
         COALESCE(r.rev, 0)      AS attributed_revenue
       FROM links l
       LEFT JOIN (
         SELECT link_id, COUNT(*) AS cpf_fans
         FROM fan_link_touches WHERE cpf_eligible = 1 GROUP BY link_id
       ) t ON t.link_id = l.id
       LEFT JOIN (
         SELECT link_id, SUM(amount) AS rev
         FROM fan_revenue_events
         WHERE attribution_type = 'direct_link' AND link_id IS NOT NULL
         GROUP BY link_id
       ) r ON r.link_id = l.id
       ${creator ? "WHERE l.creator = ?" : ""}`,
    )
    .all(...(creator ? [creator] : [])) as LinkRow[];

  return rows.map((r) => computeLinkPayout(r));
}

function computeLinkPayout(r: LinkRow): LinkPayout {
  const cpfComponent = r.cpf_rate != null ? r.cpf_eligible_fans * r.cpf_rate : 0;
  const revshareComponent = r.revshare_pct != null ? r.attributed_revenue * r.revshare_pct : 0;
  return {
    link_id: r.link_id,
    partner_id: r.partner_id,
    creator: r.creator,
    cpf_rate: r.cpf_rate,
    revshare_pct: r.revshare_pct,
    cpf_eligible_fans: r.cpf_eligible_fans,
    cpf_component: round2(cpfComponent),
    attributed_revenue: round2(r.attributed_revenue),
    revshare_component: round2(revshareComponent),
    payout_total: round2(cpfComponent + revshareComponent),
  };
}

export function partnerPayouts(db: Database.Database, opts: { creator?: string } = {}): Map<number, PartnerPayout> {
  // Аккумулируем СЫРЫЕ компоненты и округляем ОДИН раз на партнёра — иначе round-then-sum
  // даёт суб-центовый дрейф на итогах.
  const raw = new Map<number, { fans: number; cpf: number; rev: number; arev: number }>();
  for (const lp of linkPayouts(db, opts)) {
    if (lp.partner_id == null) continue;
    const r = raw.get(lp.partner_id) ?? { fans: 0, cpf: 0, rev: 0, arev: 0 };
    r.fans += lp.cpf_eligible_fans;
    r.cpf += lp.cpf_rate != null ? lp.cpf_eligible_fans * lp.cpf_rate : 0;
    r.rev += lp.revshare_pct != null ? lp.attributed_revenue * lp.revshare_pct : 0;
    r.arev += lp.attributed_revenue;
    raw.set(lp.partner_id, r);
  }
  const out = new Map<number, PartnerPayout>();
  for (const [pid, r] of raw) {
    out.set(pid, {
      partner_id: pid,
      cpf_eligible_fans: r.fans,
      cpf_component: round2(r.cpf),
      attributed_revenue: round2(r.arev),
      revshare_component: round2(r.rev),
      payout_total: round2(r.cpf + r.rev),
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
