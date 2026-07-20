import { Fragment, useEffect, useMemo, useState } from "react";
import { api, AttributionLink, AttributionPartner, PartnerRow } from "../api";
import { Hint } from "./Hint";

const fmt = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");
const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;

interface Props {
  oldRows: PartnerRow[];
  onOpenPartner: (id: number) => void;
  /** Если передано — используем общий период (из Dashboard), скрываем локальный пикер */
  externalFrom?: string;
  externalTo?: string;
}

/** Natural sort: camp_2 < camp_10 < camp_55 */
const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export function AttributionTable({ oldRows, onOpenPartner, externalFrom, externalTo }: Props) {
  const [data, setData] = useState<AttributionPartner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  /* Раскрытие двухуровневое: партнёр + (партнёр + creator) */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expandedCreator, setExpandedCreator] = useState<Set<string>>(new Set());
  const [linksByPartner, setLinksByPartner] = useState<Record<number, AttributionLink[] | "loading" | "error">>({});
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});

  /* Period filter — берётся либо из props (общий с Dashboard), либо локальный */
  const [localFrom, setLocalFrom] = useState("");
  const [localTo, setLocalTo] = useState("");
  const from = externalFrom ?? localFrom;
  const to = externalTo ?? localTo;
  const periodActive = !!(from && to);
  const setFrom = externalFrom !== undefined ? () => {/* read-only */} : setLocalFrom;
  const setTo = externalTo !== undefined ? () => {/* read-only */} : setLocalTo;
  const showLocalPicker = externalFrom === undefined && externalTo === undefined;

  useEffect(() => {
    api.creators().then((cs) => {
      const m: Record<string, string | null> = {};
      for (const c of cs) m[c.name] = c.avatar;
      setAvatars(m);
    }).catch(() => { /* offline ok */ });
  }, []);

  const toggleCreator = (key: string) => {
    setExpandedCreator((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const load = () => {
    setError(null);
    api.attributionPartners(from || undefined, to || undefined)
      .then(setData)
      .catch((e) => setError(String(e)));
  };
  useEffect(() => { load(); }, [from, to]);

  /* При смене периода — сбрасываем кэш per-link, т.к. они тоже зависят от периода */
  useEffect(() => { setLinksByPartner({}); }, [from, to]);

  const togglePartner = async (partnerId: number) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(partnerId)) next.delete(partnerId);
      else next.add(partnerId);
      return next;
    });
    /* Лениво подтягиваем линки только при первом раскрытии */
    if (!linksByPartner[partnerId]) {
      setLinksByPartner((p) => ({ ...p, [partnerId]: "loading" }));
      try {
        const links = await api.attributionPartnerLinks(partnerId, from || undefined, to || undefined);
        const sorted = [...links].sort((a, b) =>
          (a.creator ?? "").localeCompare(b.creator ?? "") ||
          naturalSort(a.campaign_code, b.campaign_code)
        );
        setLinksByPartner((p) => ({ ...p, [partnerId]: sorted }));
      } catch {
        setLinksByPartner((p) => ({ ...p, [partnerId]: "error" }));
      }
    }
  };

  const setPeriod = (start: string, end: string) => { setFrom(start); setTo(end); };
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  /* Чтобы показать имена/телеграм/тип — мерджим с oldRows */
  const oldById = useMemo(() => new Map(oldRows.map((p) => [p.id, p])), [oldRows]);
  /* Карта старых ссылок по id — чтобы показывать old subs/payout рядом для diff */
  const oldLinkById = useMemo(() => {
    const m = new Map<number, { campaign_code: string; subs: number; payout: number }>();
    for (const p of oldRows) {
      for (const c of p.by_creator ?? []) {
        for (const l of c.links ?? []) {
          m.set(l.id, {
            campaign_code: l.campaign_code,
            subs: l.subscribers_count ?? 0,
            payout: l.payout_total ?? 0,
          });
        }
      }
    }
    return m;
  }, [oldRows]);

  /* Показываем ВСЕХ партнёров из Glossary, даже с 0 first-touch.
     Активные сверху, потом пустые в конце. */
  const [hideEmpty, setHideEmpty] = useState(false);
  const rows = useMemo(() => {
    if (!data) return [];
    return data
      .filter((d) => !hideEmpty || d.payout_total > 0 || d.first_touch_fans > 0)
      .map((d) => {
        const old = oldById.get(d.partner_id);
        return {
          ...d,
          old_payout: old?.payout_total ?? null,
          old_subs: old?.subs_total ?? null,
          telegram: old?.telegram ?? null,
        };
      })
      .sort((a, b) => {
        /* активные сверху по payout desc, пустые в конце по имени */
        const ap = a.payout_total > 0 || a.first_touch_fans > 0 ? 1 : 0;
        const bp = b.payout_total > 0 || b.first_touch_fans > 0 ? 1 : 0;
        if (ap !== bp) return bp - ap;
        if (ap === 1) return b.payout_total - a.payout_total;
        return a.display_name.localeCompare(b.display_name);
      });
  }, [data, oldById, hideEmpty]);

  const totals = useMemo(() => {
    if (!data) return null;
    return data.reduce(
      (a, r) => ({
        first_touch: a.first_touch + r.first_touch_fans,
        overlap: a.overlap + r.overlap_fans,
        cpf: a.cpf + r.cpf_component,
        revshare: a.revshare + r.revshare_component,
        payout: a.payout + r.payout_total,
      }),
      { first_touch: 0, overlap: 0, cpf: 0, revshare: 0, payout: 0 },
    );
  }, [data]);

  const doSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const r = await api.syncFans();
      const d = r.data ?? {};
      setSyncMessage(`✓ Обработано: ${d.subscribers_ingested ?? 0} subs, ${d.spenders_ingested ?? 0} spenders → ${d.fans_total ?? 0} уникальных фанов`);
      setLinksByPartner({}); // инвалидируем per-link кэш
      load();
    } catch (e) {
      setSyncMessage(`Ошибка: ${e}`);
    } finally {
      setSyncing(false);
    }
  };

  const [pulling, setPulling] = useState(false);
  const doPullAll = async () => {
    if (!confirm("Подтянуть subscribers со ВСЕХ ссылок с активными подписчиками? Это ~109 кредитов OF API. После завершения автоматически переиндексируется ledger.")) return;
    setPulling(true);
    setSyncMessage("Тяну фанов из OF API — это займёт ~1-2 минуты…");
    try {
      const r = await api.pullAllSubscribers(false);
      const d = r.data ?? {};
      setSyncMessage(
        `📥 Pull: ${d.processed}/${d.total_candidates} ссылок · ` +
        `${d.fans_pulled} фанов · кэш skip: ${d.skipped_fresh_cache} · ` +
        `ошибки: ${(d.errors ?? []).length}. Переиндексирую…`,
      );
      const r2 = await api.syncFans();
      const d2 = r2.data ?? {};
      setSyncMessage(
        `✅ Готово · OF API: ${d.fans_pulled} фанов из ${d.processed} ссылок · ` +
        `Ledger: ${d2.fans_total} уникальных, ${d2.overlap_touch_total} dedup-ов`,
      );
      setLinksByPartner({});
      load();
    } catch (e) {
      setSyncMessage(`Ошибка: ${e}`);
    } finally {
      setPulling(false);
    }
  };

  if (error) return <div className="alert" style={{ color: "var(--bad)" }}>{error}</div>;
  if (!data) return <div className="loading">Загружаю attribution-данные…</div>;

  return (
    <>
      <div className="alert" style={{ background: "rgba(0,175,240,0.08)", borderColor: "rgba(0,175,240,0.4)", color: "var(--accent)" }}>
        🧪 <b>Экспериментальный режим.</b> Payout считается из fan-ledger с first-touch dedup.
        Видит только тех фанов которых мы успели стянуть детально через subscribers endpoint.
        <Hint text="Concept: один реальный фан = одна выплата, даже если он подписан через несколько ссылок партнёра. Старая система считает каждое касание как новый sub → переплата." />
      </div>

      {showLocalPicker && (
      <div className="period-row">
        <span className="muted" style={{ fontSize: 12 }}>
          Период по first-touch
          <Hint text="Фильтр first_touch_at — когда мы впервые увидели фана. Точность = интервал sync (5 ч), либо для bulk-pull = дата pull. Реальная дата подписки на OF потребует Phase 2 (webhooks)." />
        </span>
        <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to || today} />
        <span className="muted" style={{ fontSize: 12 }}>—</span>
        <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} max={today} />
        <div className="period-presets">
          <button className="chip" onClick={() => setPeriod(daysAgo(6), today)}>7 дней</button>
          <button className="chip" onClick={() => setPeriod(daysAgo(13), today)}>14 дней</button>
          <button className="chip" onClick={() => setPeriod(daysAgo(29), today)}>30 дней</button>
          {periodActive && (
            <button className="chip" onClick={() => { setFrom(""); setTo(""); }}>За всё время</button>
          )}
        </div>
        {totals && periodActive && (
          <span style={{ fontSize: 12, marginLeft: "auto", color: "var(--accent)", fontWeight: 600 }}>
            В выбранном окне: {fmt(totals.first_touch)} fans · {money(totals.payout)}
          </span>
        )}
      </div>
      )}
      {periodActive && totals && totals.first_touch === 0 && (
        <div className="alert" style={{ marginBottom: 12 }}>
          ⚠ В выбранном периоде 0 фанов. Наши данные начинаются с момента когда впервые pull-или subscribers — раньше этой даты ledger пуст. Расширь окно или выбери «За всё время».
        </div>
      )}
      {periodActive && (
        <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
          ⓘ <b>Важно про first_touch_at:</b> это дата когда МЫ впервые увидели фана через OF API, а не его реальная подписка. Для accurate подписочной даты нужны webhooks (Phase 2 у Игоря). RevShare в период = 0 (нет revenue events с датой).
        </div>
      )}

      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label className="chip" style={{ cursor: "pointer", padding: "5px 12px" }}>
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => setHideEmpty(e.target.checked)}
            style={{ marginRight: 6, verticalAlign: "middle", height: "auto" }}
          />
          Скрыть пустых
        </label>
        <div className="muted" style={{ fontSize: 12, flex: 1 }}>
          {totals && (
            <>
              <b>{fmt(totals.first_touch)}</b> first-touch ·
              <b style={{ marginLeft: 6 }}>{fmt(totals.overlap)}</b> overlap dedup ·
              Σ CPF: <b style={{ marginLeft: 4 }}>{money(totals.cpf)}</b> ·
              Σ RevShare: <b style={{ marginLeft: 4 }}>{money(totals.revshare)}</b> ·
              <b style={{ marginLeft: 6, color: "var(--accent)" }}>Σ Payout: {money(totals.payout)}</b>
            </>
          )}
        </div>
        <button
          className="btn ghost"
          onClick={doPullAll}
          disabled={pulling || syncing}
          title="Один раз пройти по ВСЕМ ссылкам с активными подписчиками и подтянуть детали (~109 кредитов OF API)"
          style={{ marginRight: 8 }}
        >
          {pulling ? "Pull…" : "📥 Pull all subscribers"}
        </button>
        <button className="btn" onClick={doSync} disabled={syncing || pulling} title="Перезапустить backfill из локальной БД (без обращения к OF API)">
          {syncing ? "Reindex…" : "↻ Re-index ledger"}
        </button>
      </div>

      {syncMessage && (
        <div className="alert" style={{ color: syncMessage.startsWith("Ошибка") ? "var(--bad)" : "var(--good)" }}>
          {syncMessage}
        </div>
      )}

      <table className="data partners-table attribution-table">
        <thead>
          <tr>
            <th style={{ width: 28 }}></th>
            <th>Партнёр / Ссылка</th>
            <th className="num">
              First-touch
              <Hint text="Уникальные фаны где партнёр (или ссылка) был ПЕРВЫМ касанием. Дубли убраны." />
            </th>
            <th className="num">
              Дубли
              <Hint text="repeat_touch (тот же партнёр, другая ссылка) + overlap (другой партнёр). Тут отображается только когда ledger ловит пересечения. Если 0 — у каждого фана только одно касание, переплат не было." />
            </th>
            <th className="num">
              Subs (old)
              <Hint text="Что считала старая система (с дублями)." />
            </th>
            <th className="num">
              CPF
              <Hint text="Фикс-выплата за first-touch фанов." />
            </th>
            <th className="num">
              RevShare
              <Hint text="% от выручки. $0 пока выручки нет." />
            </th>
            <th className="num">
              Payout (new)
              <Hint text="CPF + RevShare — авторитативная оценка." />
            </th>
            <th className="num">
              Δ vs старая
              <Hint text="Разница new − old. Красным = старая переплачивала из-за дублей." />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const delta = r.old_payout !== null ? r.payout_total - r.old_payout : null;
            const isExp = expanded.has(r.partner_id);
            const linksState = linksByPartner[r.partner_id];

            return (
              <Fragment key={r.partner_id}>
                <tr className="partner-row" onClick={() => onOpenPartner(r.partner_id)}>
                  <td className="expand-cell" onClick={(e) => { e.stopPropagation(); togglePartner(r.partner_id); }}>
                    <span className={`expand-arrow${isExp ? " open" : ""}`}>▶</span>
                  </td>
                  <td>
                    <div className="partner-cell">
                      <span className="partner-icon" title="Партнёр">👥</span>
                      <div className="partner-name-block">
                        <div className="partner-name">{r.display_name}</div>
                        {r.telegram && <div className="partner-telegram">{r.telegram}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="num big">{fmt(r.first_touch_fans)}</td>
                  <td className="num">
                    {(() => {
                      const dups = (r.repeat_touch_fans ?? 0) + (r.overlap_fans ?? 0);
                      return dups > 0
                        ? <span style={{ color: "var(--warn)", fontWeight: 600 }}>{fmt(dups)}</span>
                        : <span className="muted">—</span>;
                    })()}
                  </td>
                  <td className="num muted">{fmt(r.old_subs)}</td>
                  <td className="num">{money(r.cpf_component)}</td>
                  <td className="num">{money(r.revshare_component)}</td>
                  <td className="num big accent">{money(r.payout_total)}</td>
                  <td className="num">
                    {delta === null
                      ? <span className="muted">—</span>
                      : delta === 0
                        ? <span className="muted">$0.00</span>
                        : (
                          <span style={{ color: delta < 0 ? "var(--bad)" : "var(--good)", fontWeight: 600 }}>
                            {delta > 0 ? "+" : ""}{money(delta)}
                          </span>
                        )}
                  </td>
                </tr>

                {/* Раскрытие L2 — creator-группы */}
                {isExp && linksState === "loading" && (
                  <tr className="partner-child-row"><td colSpan={9} className="muted" style={{ textAlign: "center", fontSize: 12 }}>Загружаю ссылки…</td></tr>
                )}
                {isExp && linksState === "error" && (
                  <tr className="partner-child-row"><td colSpan={9} className="muted" style={{ textAlign: "center", color: "var(--bad)" }}>Не удалось загрузить</td></tr>
                )}
                {isExp && Array.isArray(linksState) && (() => {
                  /* Группируем ссылки по creator + считаем агрегаты для L2-строки */
                  const byCreator = new Map<string, AttributionLink[]>();
                  for (const l of linksState) {
                    const k = l.creator ?? "(unknown)";
                    if (!byCreator.has(k)) byCreator.set(k, []);
                    byCreator.get(k)!.push(l);
                  }
                  const creatorGroups = Array.from(byCreator.entries()).sort((a, b) => a[0].localeCompare(b[0]));
                  if (creatorGroups.length === 0) {
                    return <tr className="partner-child-row"><td colSpan={9} className="muted" style={{ textAlign: "center", fontSize: 12 }}>Нет ссылок в attribution-леджере для этого партнёра</td></tr>;
                  }
                  return creatorGroups.map(([creator, links]) => {
                    const cKey = `${r.partner_id}:${creator}`;
                    const isCExp = expandedCreator.has(cKey);
                    /* Aggregated metrics на уровне модели */
                    const cAgg = links.reduce((a, l) => ({
                      first_touch: a.first_touch + l.first_touch_fans,
                      overlap: a.overlap + l.repeat_overlap_fans,
                      gross: a.gross + (oldLinkById.get(l.link_id)?.subs ?? l.gross_subscribers),
                      cpf: a.cpf + (l.payout_breakdown?.cpf_component ?? 0),
                      revshare: a.revshare + (l.payout_breakdown?.revshare_component ?? 0),
                      payout: a.payout + (l.payout_breakdown?.payout_total ?? 0),
                      old_payout: a.old_payout + (oldLinkById.get(l.link_id)?.payout ?? 0),
                    }), { first_touch: 0, overlap: 0, gross: 0, cpf: 0, revshare: 0, payout: 0, old_payout: 0 });
                    const cDelta = cAgg.old_payout > 0 || cAgg.payout > 0 ? cAgg.payout - cAgg.old_payout : null;

                    return (
                      <Fragment key={cKey}>
                        {/* L2: CREATOR */}
                        <tr className="partner-child-row creator-row">
                          <td className="expand-cell" onClick={() => toggleCreator(cKey)}>
                            <span className={`expand-arrow${isCExp ? " open" : ""}`}>▶</span>
                          </td>
                          <td>
                            <div className="partner-cell child">
                              {avatars[creator] ? (
                                <img src={avatars[creator] ?? ""} alt={creator} className="creator-avatar" loading="lazy" />
                              ) : (
                                <span className="partner-icon" title="Модель">🎬</span>
                              )}
                              <div>
                                <span className="creator-name">{creator}</span>
                                <div className="muted" style={{ fontSize: 11 }}>{links.length} ссылок</div>
                              </div>
                            </div>
                          </td>
                          <td className="num big">{fmt(cAgg.first_touch)}</td>
                          <td className="num">{cAgg.overlap > 0 ? <span className="muted">{fmt(cAgg.overlap)}</span> : <span className="muted">—</span>}</td>
                          <td className="num muted">{fmt(cAgg.gross)}</td>
                          <td className="num">{money(cAgg.cpf)}</td>
                          <td className="num">{money(cAgg.revshare)}</td>
                          <td className="num big accent">{money(cAgg.payout)}</td>
                          <td className="num">
                            {cDelta === null
                              ? <span className="muted">—</span>
                              : cDelta === 0
                                ? <span className="muted">$0.00</span>
                                : (
                                  <span style={{ color: cDelta < 0 ? "var(--bad)" : "var(--good)", fontWeight: 600 }}>
                                    {cDelta > 0 ? "+" : ""}{money(cDelta)}
                                  </span>
                                )}
                          </td>
                        </tr>

                        {/* L3: LINKS — natural sort */}
                        {isCExp && [...links].sort((x, y) =>
                          naturalSort(x.campaign_code, y.campaign_code)
                        ).map((l) => {
                          const oldLink = oldLinkById.get(l.link_id);
                          const newPayout = l.payout_breakdown?.payout_total ?? 0;
                          const oldPayout = oldLink?.payout ?? 0;
                          const linkDelta = oldPayout > 0 || newPayout > 0 ? newPayout - oldPayout : null;
                          return (
                            <tr key={l.link_id} className="partner-child-row link-row">
                              <td></td>
                              <td>
                                <div className="partner-cell link">
                                  <span className="link-icon">🔗</span>
                                  <div className="link-name-block">
                                    <a href={l.of_url} target="_blank" rel="noopener noreferrer" className="link-campaign" onClick={(e) => e.stopPropagation()} title={l.of_url}>
                                      {l.campaign_code}
                                    </a>
                                    <span className="link-url">{l.of_url.replace("https://onlyfans.com/", "")}</span>
                                  </div>
                                </div>
                              </td>
                              <td className="num">{fmt(l.first_touch_fans)}</td>
                              <td className="num">{l.repeat_overlap_fans > 0 ? <span className="muted">{fmt(l.repeat_overlap_fans)}</span> : <span className="muted">—</span>}</td>
                              <td className="num muted">{fmt(oldLink?.subs ?? l.gross_subscribers)}</td>
                              <td className="num">{money(l.payout_breakdown?.cpf_component ?? 0)}</td>
                              <td className="num">{money(l.payout_breakdown?.revshare_component ?? 0)}</td>
                              <td className="num accent">{money(newPayout)}</td>
                              <td className="num">
                                {linkDelta === null
                                  ? <span className="muted">—</span>
                                  : linkDelta === 0
                                    ? <span className="muted">$0.00</span>
                                    : (
                                      <span style={{ color: linkDelta < 0 ? "var(--bad)" : "var(--good)", fontWeight: 600 }}>
                                        {linkDelta > 0 ? "+" : ""}{money(linkDelta)}
                                      </span>
                                    )}
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  });
                })()}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="empty">
                Ledger пуст. Нажми «↻ Re-index ledger» чтобы пересчитать из локальных subscribers,
                либо подтяни subscribers всех ссылок (sync OF API).
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
