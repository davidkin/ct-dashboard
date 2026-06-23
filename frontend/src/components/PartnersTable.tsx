import { Fragment, useEffect, useState } from "react";
import { api, Link, PartnerLinkSummary, PartnerRow } from "../api";
import { Hint } from "./Hint";
import { LinkFansModal } from "./LinkFansModal";
import { Sparkline } from "./Sparkline";

const fmt = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");
const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;

const rate = (l: PartnerLinkSummary): string => {
  if (l.revshare_pct !== null) {
    const base = l.cpf_paid ?? l.cpf_free;
    if (base !== null) return `$${base.toFixed(2)} / ${(l.revshare_pct * 100).toFixed(0)}%`;
    return `${(l.revshare_pct * 100).toFixed(0)}% rev`;
  }
  if (l.cpf_paid !== null || l.cpf_free !== null) {
    const free = l.cpf_free;
    const paid = l.cpf_paid;
    if (free !== null && paid !== null) return `$${free.toFixed(2)} / $${paid.toFixed(2)}`;
    return `$${(paid ?? free!).toFixed(2)}`;
  }
  return "—";
};

type SortKey =
  | "display_name" | "type" | "source"
  | "links_count" | "clicks_total" | "subs_total" | "spenders_total" | "revenue_total" | "payout_total";

interface Props {
  rows: PartnerRow[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onToggleSort: (k: SortKey) => void;
  onOpenPartner: (id: number) => void;
}

export function PartnersTable({ rows, sortKey, sortDir, onToggleSort, onOpenPartner }: Props) {
  const [expandedPartner, setExpandedPartner] = useState<Set<number>>(new Set());
  const [expandedCreator, setExpandedCreator] = useState<Set<string>>(new Set());
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const [drillLink, setDrillLink] = useState<Link | null>(null);

  const openLinkFans = (l: PartnerLinkSummary) => {
    /* PartnerLinkSummary почти полностью совпадает с Link — добавляем недостающие поля как null */
    const fullLink: Link = {
      id: l.id,
      partner_id: l.partner_id ?? 0,
      creator: l.creator,
      campaign_code: l.campaign_code,
      of_url: l.of_url,
      cpf_free: l.cpf_free,
      cpf_paid: l.cpf_paid,
      revshare_pct: l.revshare_pct,
      source: null,
      clicks_count: l.clicks_count,
      subscribers_count: l.subscribers_count,
      spenders_count: l.spenders_count,
      revenue_total: l.revenue_total,
      of_created_at: l.of_created_at,
      last_synced_at: null,
    };
    setDrillLink(fullLink);
  };

  /* Один раз тянем список моделей с авой — backend кэширует на 30 мин */
  useEffect(() => {
    api.creators().then((cs) => {
      const map: Record<string, string | null> = {};
      for (const c of cs) map[c.name] = c.avatar;
      setAvatars(map);
    }).catch(() => { /* offline — оставим эмодзи */ });
  }, []);

  const togglePartner = (id: number) => {
    setExpandedPartner((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleCreator = (key: string) => {
    setExpandedCreator((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const SortHeader = ({ k, hint, children, num }: { k: SortKey; hint?: string; children: React.ReactNode; num?: boolean }) => (
    <th onClick={() => onToggleSort(k)} className={`${num ? "num " : ""}sortable`}>
      {children}
      {hint && <Hint text={hint} />}
      <span className="sort-arrow">{sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕"}</span>
    </th>
  );

  return (
    <table className="data partners-table">
      <thead>
        <tr>
          <th style={{ width: 28 }}></th>
          <SortHeader k="display_name">Партнёр</SortHeader>
          <SortHeader k="type" hint="External — внешний арбитражник. In-house — наша команда.">Тип</SortHeader>
          <SortHeader k="source">Источник</SortHeader>
          <SortHeader k="clicks_total" hint="Клики по всем ссылкам партнёра" num>Clicks</SortHeader>
          <SortHeader k="subs_total" hint="Атрибутированные подписки" num>Subs</SortHeader>
          <th className="num">
            CR
            <Hint text="Conversion Rate = Subs ÷ Clicks. Качество трафика." />
          </th>
          <th className="num" style={{ minWidth: 100 }}>
            7д тренд
            <Hint text="Дневная динамика кликов за 7 дней. Появится по мере накопления snapshot-ов." />
          </th>
          <SortHeader k="revenue_total" hint="Выручка от подписчиков партнёра" num>Revenue</SortHeader>
          <SortHeader k="payout_total" hint="Оценка выплаты партнёру по формуле CPF/RevShare" num>Payout</SortHeader>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const isPExpanded = expandedPartner.has(p.id);
          const hasMultipleCreators = (p.by_creator?.length ?? 0) > 1;
          /* Раскрытие партнёра доступно даже с 1 моделью — там тоже могут быть N ссылок */
          const canExpandPartner = (p.by_creator?.length ?? 0) > 0;
          const cr = (p.clicks_total ?? 0) > 0 ? (p.subs_total ?? 0) / (p.clicks_total ?? 1) : null;

          return (
            <Fragment key={p.id}>
              {/* === LEVEL 1: PARTNER === */}
              <tr className="partner-row" onClick={() => onOpenPartner(p.id)}>
                <td className="expand-cell" onClick={(e) => { e.stopPropagation(); if (canExpandPartner) togglePartner(p.id); }}>
                  {canExpandPartner
                    ? <span className={`expand-arrow${isPExpanded ? " open" : ""}`}>▶</span>
                    : <span className="muted" style={{ opacity: 0.3 }}>·</span>}
                </td>
                <td>
                  <div className="partner-cell">
                    <span className="partner-icon" title={hasMultipleCreators ? "Партнёр с несколькими моделями" : "Партнёр"}>
                      {hasMultipleCreators ? "👥" : "👤"}
                    </span>
                    <div className="partner-name-block">
                      <div className="partner-name">{p.display_name}</div>
                      {p.telegram && (
                        <a
                          className="partner-telegram"
                          href={`https://t.me/${p.telegram.replace(/^@/, "")}`}
                          target="_blank" rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.telegram}
                        </a>
                      )}
                    </div>
                  </div>
                </td>
                <td>{p.type ? <span className={`tag ${p.type === "External" ? "ext" : "in"}`}>{p.type}</span> : <span className="muted">—</span>}</td>
                <td>{p.source || <span className="muted">—</span>}</td>
                <td className="num big">{fmt(p.clicks_total)}</td>
                <td className="num big">{fmt(p.subs_total)}</td>
                <td className="num">{pct(cr)}</td>
                <td className="num"><Sparkline data={p.sparkline ?? []} color="#FF5A6E" /></td>
                <td className="num big">{money(p.revenue_total)}</td>
                <td className="num big accent">{money(p.payout_total)}</td>
              </tr>

              {/* === LEVEL 2: CREATORS === */}
              {isPExpanded && (p.by_creator ?? []).map((b) => {
                const cKey = `${p.id}:${b.creator}`;
                const isCExpanded = expandedCreator.has(cKey);
                const childCr = (b.clicks_total ?? 0) > 0 ? (b.subs_total ?? 0) / (b.clicks_total ?? 1) : null;
                const canExpandCreator = (b.links?.length ?? 0) > 0;

                return (
                  <Fragment key={cKey}>
                    <tr className="partner-child-row creator-row">
                      <td className="expand-cell" onClick={() => canExpandCreator && toggleCreator(cKey)}>
                        {canExpandCreator
                          ? <span className={`expand-arrow${isCExpanded ? " open" : ""}`}>▶</span>
                          : <span className="muted" style={{ opacity: 0.3 }}>·</span>}
                      </td>
                      <td>
                        <div className="partner-cell child">
                          {avatars[b.creator] ? (
                            <img
                              src={avatars[b.creator] ?? ""}
                              alt={b.creator}
                              className="creator-avatar"
                              loading="lazy"
                            />
                          ) : (
                            <span className="partner-icon" title="Модель">🎬</span>
                          )}
                          <span className="creator-name">{b.creator}</span>
                        </div>
                      </td>
                      <td colSpan={2} className="muted" style={{ fontSize: 12 }}>
                        {b.links_count} ссылок
                      </td>
                      <td className="num big">{fmt(b.clicks_total)}</td>
                      <td className="num big">{fmt(b.subs_total)}</td>
                      <td className="num">{pct(childCr)}</td>
                      <td className="num"><span className="muted">—</span></td>
                      <td className="num big">{money(b.revenue_total)}</td>
                      <td className="num big accent">{money(b.payout_total)}</td>
                    </tr>

                    {/* === LEVEL 3: LINKS — natural sort: camp_2 < camp_10 < camp_55 === */}
                    {isCExpanded && [...(b.links ?? [])].sort((x, y) =>
                      x.campaign_code.localeCompare(y.campaign_code, undefined, { numeric: true, sensitivity: "base" })
                    ).map((l) => {
                      const linkCr = l.clicks_count > 0 ? l.subscribers_count / l.clicks_count : null;
                      return (
                        <tr key={`${cKey}:${l.id}`} className="partner-child-row link-row">
                          <td></td>
                          <td>
                            <div className="partner-cell link">
                              <span className="link-icon">🔗</span>
                              <div className="link-name-block">
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                  <button
                                    className="link-campaign"
                                    onClick={(e) => { e.stopPropagation(); openLinkFans(l); }}
                                    title="Посмотреть фанов этой ссылки"
                                    style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, font: "inherit" }}
                                  >
                                    {l.campaign_code}
                                  </button>
                                  <a
                                    href={l.of_url}
                                    target="_blank" rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    title="Открыть в OnlyFans"
                                    style={{ fontSize: 10, color: "var(--muted)", textDecoration: "none" }}
                                  >↗</a>
                                </span>
                                <span className="link-url">{l.of_url.replace("https://onlyfans.com/", "")}</span>
                              </div>
                            </div>
                          </td>
                          <td className="muted" colSpan={2} style={{ fontSize: 12 }}>
                            <span title="Ставка партнёра">{rate(l)}</span>
                            {l.of_created_at && <span style={{ marginLeft: 10 }} title="Дата создания кампании">· {new Date(l.of_created_at).toLocaleDateString("ru-RU")}</span>}
                          </td>
                          <td className="num">{fmt(l.clicks_count)}</td>
                          <td className="num">{fmt(l.subscribers_count)}</td>
                          <td className="num">{pct(linkCr)}</td>
                          <td className="num"><span className="muted">—</span></td>
                          <td className="num">{money(l.revenue_total)}</td>
                          <td className="num accent">{money(l.payout_total)}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </Fragment>
          );
        })}
        {rows.length === 0 && (
          <tr><td colSpan={10} className="empty">Партнёры не найдены</td></tr>
        )}
      </tbody>
      {drillLink && (
        <tfoot>
          <tr>
            <td colSpan={10} style={{ padding: 0, border: 0 }}>
              <LinkFansModal link={drillLink} onClose={() => setDrillLink(null)} />
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
