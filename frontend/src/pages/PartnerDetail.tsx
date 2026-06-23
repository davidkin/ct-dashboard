import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useParams, useSearchParams } from "react-router-dom";
import { api, Link, Partner, TrendsResponse } from "../api";
import { ActivityChart } from "../components/ActivityChart";
import { Hint } from "../components/Hint";
import { LinkFansModal } from "../components/LinkFansModal";

const fmt = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");
const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;
const pct = (n: number | null): string =>
  n === null ? "—" : `${(n * 100).toFixed(0)}%`;
const pctFmt = (n: number | null): string =>
  n === null ? "—" : `${(n * 100).toFixed(1)}%`;
const formatDateLabel = (dateOnly: string): string =>
  new Date(`${dateOnly}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
const rate = (free: number | null, paid: number | null): string => {
  if (free === null && paid === null) return "—";
  if (paid === null) return `$${free!.toFixed(2)}`;
  if (free === null) return `$${paid.toFixed(2)}`;
  return `$${free.toFixed(2)} / $${paid.toFixed(2)}`;
};
const formatDate = (iso: string): string => {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T") + "Z");
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};

/**
 * Расчёт выплаты per-link:
 *
 *   RevShare:  payout = revenue × revshare_pct
 *   CPF:       payout = subscribers × (cpf_paid ?? cpf_free)
 *   Гибрид:    payout = MAX(CPF, RevShare)     ← TODO согласовать с тимлидом
 *
 * Если ни ставок, ни метрик — возвращаем 0.
 */
function calcPayout(link: Link): { value: number; formula: string } {
  const subs = link.subscribers_count ?? 0;
  const revenue = link.revenue_total ?? 0;
  const cpf = link.cpf_paid ?? link.cpf_free ?? 0;
  const cpfPayout = subs * cpf;
  const revPayout = link.revshare_pct ? revenue * link.revshare_pct : 0;

  if (cpf > 0 && link.revshare_pct) {
    const v = Math.max(cpfPayout, revPayout);
    return {
      value: v,
      formula: `MAX( ${subs} × $${cpf.toFixed(2)} , $${revenue.toFixed(2)} × ${(link.revshare_pct * 100).toFixed(0)}% ) = MAX($${cpfPayout.toFixed(2)}, $${revPayout.toFixed(2)}) = $${v.toFixed(2)}`,
    };
  }
  if (link.revshare_pct) {
    return {
      value: revPayout,
      formula: `$${revenue.toFixed(2)} × ${(link.revshare_pct * 100).toFixed(0)}% = $${revPayout.toFixed(2)}`,
    };
  }
  if (cpf > 0) {
    return {
      value: cpfPayout,
      formula: `${subs} subs × $${cpf.toFixed(2)} = $${cpfPayout.toFixed(2)}`,
    };
  }
  return { value: 0, formula: "ставка не задана — payout = 0" };
}

type LinkScope = "all" | string;
type TrendKey = "clicks" | "subs" | "spenders" | "revenue" | "payout" | "cr" | "arps";
type TrendRangeMode = "preset" | "custom";

interface TrendSummary {
  current: Record<TrendKey, number | null>;
  prior: Record<TrendKey, number | null>;
  delta: Record<TrendKey, number | null>;
  deltaPct: Record<TrendKey, number | null>;
}

export default function PartnerDetail() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const requestedCreator = params.get("creator");

  const [data, setData] = useState<{ partner: Partner; links: Link[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [monthlyFee, setMonthlyFee] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [linkScope, setLinkScope] = useState<LinkScope>(requestedCreator || "all");
  const [trendDays, setTrendDays] = useState<7 | 30 | 90>(7);
  const [trendRangeMode, setTrendRangeMode] = useState<TrendRangeMode>("preset");
  const [trendStartDate, setTrendStartDate] = useState("");
  const [trendEndDate, setTrendEndDate] = useState("");
  const [trends, setTrends] = useState<TrendsResponse | null>(null);
  const [linkSearch, setLinkSearch] = useState("");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");

  const reload = () => {
    if (!id) return;
    api.partner(Number(id)).then((d) => {
      setData(d);
      setMonthlyFee(d.partner.monthly_fee !== null ? String(d.partner.monthly_fee) : "");
      setNotes(d.partner.notes ?? "");
    }).catch(console.error);
  };

  useEffect(() => { reload(); }, [id]);
  useEffect(() => {
    setLinkScope(requestedCreator || "all");
  }, [requestedCreator]);

  const trendRange = useMemo(() => {
    if (trendRangeMode !== "custom" || (!trendStartDate && !trendEndDate)) return undefined;
    return {
      start: trendStartDate || undefined,
      end: trendEndDate || undefined,
    };
  }, [trendRangeMode, trendStartDate, trendEndDate]);

  const trendPeriodLabel = useMemo(() => {
    if (!trendRange) return `${trendDays}д`;
    const start = trendRange.start ? formatDateLabel(trendRange.start) : "";
    const end = trendRange.end ? formatDateLabel(trendRange.end) : "";
    if (start && end) return `${start}–${end}`;
    if (start) return `с ${start}`;
    return `до ${end}`;
  }, [trendRange, trendDays]);

  useEffect(() => {
    if (!id) return;
    api.trends(trendDays, linkScope === "all" ? undefined : linkScope, trendRange)
      .then(setTrends)
      .catch(console.error);
  }, [id, linkScope, trendDays, trendRange]);

  const availableCreators = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.links.map((l) => l.creator))).sort();
  }, [data]);

  const filteredLinks = useMemo(() => {
    if (!data) return [];
    return data.links.filter((l) => {
      if (linkScope !== "all" && l.creator !== linkScope) return false;
      if (linkSearch) {
        const hay = `${l.campaign_code} ${l.of_url} ${l.creator}`.toLowerCase();
        if (!hay.includes(linkSearch.toLowerCase())) return false;
      }
      if (createdAfter && l.of_created_at) {
        if (l.of_created_at.slice(0, 10) < createdAfter) return false;
      }
      if (createdBefore && l.of_created_at) {
        if (l.of_created_at.slice(0, 10) > createdBefore) return false;
      }
      return true;
    });
  }, [data, linkScope, linkSearch, createdAfter, createdBefore]);

  const stats = useMemo(() => {
    const totals = filteredLinks.reduce(
      (a, l) => {
        const p = calcPayout(l);
        return {
          clicks: a.clicks + (l.clicks_count ?? 0),
          subs: a.subs + (l.subscribers_count ?? 0),
          spenders: a.spenders + (l.spenders_count ?? 0),
          revenue: a.revenue + (l.revenue_total ?? 0),
          payout: a.payout + p.value,
        };
      },
      { clicks: 0, subs: 0, spenders: 0, revenue: 0, payout: 0 },
    );
    const cr = totals.clicks > 0 ? totals.subs / totals.clicks : null;
    const arps = totals.subs > 0 ? totals.revenue / totals.subs : null;
    return { ...totals, cr, arps };
  }, [filteredLinks]);

  const byCreator = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, { creator: string; links: number; clicks: number; subs: number; revenue: number; payout: number }>();
    for (const l of data.links) {
      const k = l.creator || "(unknown)";
      const cur = m.get(k) ?? { creator: k, links: 0, clicks: 0, subs: 0, revenue: 0, payout: 0 };
      cur.links += 1;
      cur.clicks += l.clicks_count ?? 0;
      cur.subs += l.subscribers_count ?? 0;
      cur.revenue += l.revenue_total ?? 0;
      cur.payout += calcPayout(l).value;
      m.set(k, cur);
    }
    return Array.from(m.values()).sort((a, b) => b.revenue - a.revenue);
  }, [data]);

  const trendSummary = useMemo<TrendSummary | null>(() => {
    if (!trends || !id) return null;
    const row = trends.data.find((r) => r.id === Number(id));
    if (!row) return null;
    const current = {
      clicks: row.current.clicks,
      subs: row.current.subs,
      spenders: row.current.spenders,
      revenue: row.current.revenue,
      payout: row.current.payout,
      cr: row.current.clicks > 0 ? row.current.subs / row.current.clicks : null,
      arps: row.current.subs > 0 ? row.current.revenue / row.current.subs : null,
    };
    const prior = {
      clicks: row.prior.clicks,
      subs: row.prior.subs,
      spenders: row.prior.spenders,
      revenue: row.prior.revenue,
      payout: row.prior.payout,
      cr: row.prior.clicks > 0 ? row.prior.subs / row.prior.clicks : null,
      arps: row.prior.subs > 0 ? row.prior.revenue / row.prior.subs : null,
    };
    const delta = Object.fromEntries(
      (Object.keys(current) as TrendKey[]).map((k) => [
        k,
        current[k] === null || prior[k] === null ? null : current[k]! - prior[k]!,
      ]),
    ) as TrendSummary["delta"];
    const deltaPct = Object.fromEntries(
      (Object.keys(current) as TrendKey[]).map((k) => [
        k,
        current[k] === null || prior[k] === null || prior[k] === 0
          ? null
          : (current[k]! - prior[k]!) / prior[k]!,
      ]),
    ) as TrendSummary["deltaPct"];
    return { current, prior, delta, deltaPct };
  }, [trends, id]);

  const save = async () => {
    if (!data) return;
    setSaving(true);
    try {
      const mf = monthlyFee.trim() === "" ? null : Number(monthlyFee);
      await api.updatePartner(data.partner.id, {
        monthly_fee: mf,
        notes: notes.trim() === "" ? null : notes,
      });
      setEditing(false);
      reload();
    } catch (e) {
      alert(`Не удалось сохранить: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <div className="loading">Загружаю…</div>;
  const { partner, links } = data;
  const monthlyFeeNum = partner.monthly_fee ?? 0;

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <RouterLink to="/">← К списку партнёров</RouterLink>
      </div>

      {/* Шапка профиля */}
      <div className="card profile-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>{partner.display_name}</h2>
          <div style={{ marginTop: 6, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {partner.telegram && (
              <a
                href={`https://t.me/${partner.telegram.replace(/^@/, "")}`}
                target="_blank" rel="noopener noreferrer"
              >{partner.telegram}</a>
            )}
            {partner.type && <span className={`tag ${partner.type === "External" ? "ext" : "in"}`} title={partner.type === "External" ? "Внешний партнёр" : "Внутренняя команда"}>{partner.type}</span>}
            {partner.source && <span className="tag" title="Платформа основного трафика">{partner.source}</span>}
            <span className="muted" style={{ fontSize: 12 }}>· создан {formatDate(partner.created_at)}</span>
          </div>
        </div>
      </div>

      <div className="card partner-info-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Информация о партнёре</h2>
          {!editing ? (
            <button className="btn ghost" onClick={() => setEditing(true)}>Редактировать</button>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn ghost" onClick={() => { setEditing(false); reload(); }}>Отмена</button>
              <button className="btn" onClick={save} disabled={saving}>{saving ? "Сохраняю…" : "Сохранить"}</button>
            </div>
          )}
        </div>
        <div className="kv compact">
          <div className="k">
            Glossary name
            <Hint text="Точная строка из колонки A таблицы Glossary — ключ для синка с Google Sheet." />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{partner.glossary_name}</div>

          <div className="k">Telegram</div>
          <div>{partner.telegram || "—"}</div>

          <div className="k">
            Тип
            <Hint text="Источник: Glossary. External — внешний партнёр-арбитражник. In-house — наша внутренняя команда." />
          </div>
          <div>{partner.type || "—"} <span className="muted" style={{ fontSize: 11 }}>· read-only из Glossary</span></div>

          <div className="k">
            Источник
            <Hint text="Источник: Glossary. Основная платформа, с которой партнёр льёт трафик." />
          </div>
          <div>{partner.source || "—"} <span className="muted" style={{ fontSize: 11 }}>· read-only из Glossary</span></div>

          <div className="k">
            Monthly fee
            <Hint text="Фиксированный месячный гонорар сверху ставок. Хранится в БД дашборда, не в Glossary." />
          </div>
          <div>
            {!editing
              ? (partner.monthly_fee !== null ? money(partner.monthly_fee) : "—")
              : <input value={monthlyFee} onChange={(e) => setMonthlyFee(e.target.value)} placeholder="0.00" type="number" step="0.01" style={{ width: 120 }} />}
          </div>

          <div className="k">
            Заметки
            <Hint text="Свободный текст: личные пометки менеджера, договорённости, контекст." />
          </div>
          <div>
            {!editing
              ? (partner.notes || "—")
              : <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ width: "100%" }} />}
          </div>

          <div className="k">Создан / Обновлён</div>
          <div className="muted" style={{ fontSize: 12 }}>{formatDate(partner.created_at)} · {formatDate(partner.updated_at)}</div>
        </div>
      </div>

      <section className="dashboard-section">
        <div className="section-header">
          <div>
            <h2>Динамика партнёра</h2>
            <p>
              Метрики по текущему scope: {linkScope === "all" ? "все модели" : linkScope}.
              Стрелки сравнивают выбранный период с предыдущим таким же периодом.
            </p>
          </div>
          <div className="section-actions">
            <div className="scope-inline">
              <div className="scope-label">
                Показать данные по модели:
                <Hint text="Фильтрует ссылки, статы и формулу payout. «Все» = суммарно по обеим моделям." />
              </div>
              <div className="scope-tabs">
                <button className={`chip${linkScope === "all" ? " active" : ""}`} onClick={() => setLinkScope("all")}>
                  Все модели ({links.length})
                </button>
                {availableCreators.map((c) => {
                  const count = links.filter((l) => l.creator === c).length;
                  return (
                    <div key={c} className="chip-group">
                      <button className={`chip${linkScope === c ? " active" : ""}`} onClick={() => setLinkScope(c)}>
                        {c} ({count})
                      </button>
                      <RouterLink to={`/creators/${c.toLowerCase().replace(/\s+/g, "-")}`} className="chip-profile" title={`Открыть профиль модели ${c}`}>
                        👤
                      </RouterLink>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="period-switch" title="Период для динамики на KPI-карточках">
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  className={`chip${trendRangeMode === "preset" && trendDays === d ? " active" : ""}`}
                  onClick={() => {
                    setTrendRangeMode("preset");
                    setTrendDays(d as 7 | 30 | 90);
                  }}
                >
                  {d}д
                </button>
              ))}
            </div>
            <div className="date-range-inline" title="Кастомный период для динамики партнёра">
              <span className="muted">с</span>
              <input
                className="input"
                type="date"
                value={trendStartDate}
                max={trendEndDate || undefined}
                onChange={(e) => {
                  setTrendRangeMode("custom");
                  setTrendStartDate(e.target.value);
                }}
              />
              <span className="muted">по</span>
              <input
                className="input"
                type="date"
                value={trendEndDate}
                min={trendStartDate || undefined}
                onChange={(e) => {
                  setTrendRangeMode("custom");
                  setTrendEndDate(e.target.value);
                }}
              />
              {(trendStartDate || trendEndDate) && (
                <button
                  className="chip"
                  onClick={() => {
                    setTrendRangeMode("preset");
                    setTrendStartDate("");
                    setTrendEndDate("");
                  }}
                >
                  Сброс
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="kpi-grid">
          <MetricCard
            label="Ссылок"
            value={String(filteredLinks.length)}
            hint="Сколько трекинг-ссылок попало в текущий scope."
          />
          <MetricCard
            label="Clicks"
            value={fmt(stats.clicks)}
            hint="Сумма кликов по выбранным ссылкам."
            trend={trendSummary}
            trendKey="clicks"
            periodLabel={trendPeriodLabel}
          />
          <MetricCard
            label="Subs"
            value={fmt(stats.subs)}
            accent
            hint="Атрибутированные подписки: окно 90 минут после клика."
            trend={trendSummary}
            trendKey="subs"
            periodLabel={trendPeriodLabel}
          />
          <MetricCard
            label="Spenders"
            value={fmt(stats.spenders)}
            hint="Подписчики, которые что-то покупали."
            trend={trendSummary}
            trendKey="spenders"
            periodLabel={trendPeriodLabel}
          />
          <MetricCard
            label="CR%"
            value={pctFmt(stats.cr)}
            hint="Conversion Rate = Subs ÷ Clicks. Качество трафика."
            trend={trendSummary}
            trendKey="cr"
            periodLabel={trendPeriodLabel}
            format="percent-points"
          />
          <MetricCard
            label="ARPS"
            value={money(stats.arps)}
            hint="Average Revenue Per Subscriber = Revenue ÷ Subs."
            trend={trendSummary}
            trendKey="arps"
            periodLabel={trendPeriodLabel}
            format="money"
          />
          <MetricCard
            label="Revenue"
            value={money(stats.revenue)}
            hint="Общая выручка по выбранным ссылкам."
            trend={trendSummary}
            trendKey="revenue"
            periodLabel={trendPeriodLabel}
            format="money"
          />
          <MetricCard
            label="Payout"
            value={money(stats.payout)}
            accent
            hint="Сумма выплат по выбранным ссылкам. Без учёта monthly fee."
            trend={trendSummary}
            trendKey="payout"
            periodLabel={trendPeriodLabel}
            format="money"
          />
        </div>
      </section>

      <div className="card">
          <h2 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>
            Формула расчёта выплаты
            <Hint text="Логика, по которой считается payout. Применяется к КАЖДОЙ ссылке отдельно, потом суммируется." />
          </h2>
          <div className="formula-block">
            <div className="formula-line">
              <span className="formula-tag cpf">CPF</span>
              <code>payout = subs × cpf_paid</code>
              <span className="muted"> (или cpf_free если paid не задан)</span>
            </div>
            <div className="formula-line">
              <span className="formula-tag rev">RevShare</span>
              <code>payout = revenue × revshare_pct</code>
            </div>
            <div className="formula-line">
              <span className="formula-tag hybrid">Гибрид</span>
              <code>payout = MAX(CPF, RevShare)</code>
              <span className="muted"> · TODO согласовать</span>
            </div>
            <div className="formula-line">
              <span className="formula-tag fee">Monthly</span>
              <code>{money(monthlyFeeNum)}</code>
              <span className="muted"> · фикс сверху, не суммируется в Payout</span>
            </div>
          </div>
          <div className="formula-summary">
            <div className="muted" style={{ fontSize: 12 }}>Итого по выбранному scope:</div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>
              {money(stats.payout)} <span className="muted" style={{ fontSize: 12 }}>+ {money(monthlyFeeNum)} monthly</span>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              💡 Hover на «Payout» в строке ссылки — увидишь подсчёт для конкретной кампании.
            </div>
          </div>
      </div>

      {/* Сводка по моделям — всегда показываем обе, даже если scope = одна */}
      <div className="card">
        <h2 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>
          Сводка по моделям
          <Hint text="Полная разбивка по обеим моделям независимо от выбранного scope — чтобы быстро сравнить." />
        </h2>
        <table className="data">
          <thead>
            <tr>
              <th>Модель</th>
              <th className="num">Ссылок</th>
              <th className="num">Clicks</th>
              <th className="num">Subs</th>
              <th className="num">Revenue</th>
              <th className="num">Payout</th>
            </tr>
          </thead>
          <tbody>
            {byCreator.map((r) => (
              <tr key={r.creator}>
                <td>{r.creator}</td>
                <td className="num">{r.links}</td>
                <td className="num">{fmt(r.clicks)}</td>
                <td className="num">{fmt(r.subs)}</td>
                <td className="num">{money(r.revenue)}</td>
                <td className="num">{money(r.payout)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Ссылки — с поиском, фильтром по датам, сортировкой колонок */}
      <div className="card">
        <h2 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>
          Ссылки ({filteredLinks.length}{filteredLinks.length !== links.length && <> из {links.length}</>})
          <Hint text="Каждая ссылка = одна campaign в OnlyFans. Сгруппированы по моделям, заголовки колонок кликабельные для сортировки." />
        </h2>
        <div className="link-toolbar">
          <div className="input-with-icon" style={{ minWidth: 240 }}>
            <span className="input-icon">🔎</span>
            <input
              className="input"
              placeholder="Поиск по campaign / URL…"
              value={linkSearch}
              onChange={(e) => setLinkSearch(e.target.value)}
            />
          </div>
          <span className="link-date-filter">
            <span className="muted" style={{ fontSize: 12 }}>
              Создана с
              <Hint text="Фильтр по дате создания кампании в OnlyFans (поле createdAt)." />
            </span>
            <input className="input" type="date" value={createdAfter} onChange={(e) => setCreatedAfter(e.target.value)} />
            <span className="muted" style={{ fontSize: 12 }}>по</span>
            <input className="input" type="date" value={createdBefore} onChange={(e) => setCreatedBefore(e.target.value)} />
            {(createdAfter || createdBefore) && (
              <button className="btn-icon" onClick={() => { setCreatedAfter(""); setCreatedBefore(""); }} title="Сбросить">×</button>
            )}
          </span>
        </div>
        <LinkGroups links={filteredLinks} />
      </div>

      {/* Активность партнёра — В САМОМ НИЗУ под всеми таблицами */}
      <div style={{ marginTop: 32 }}>
        <ActivityChart
          partnerId={partner.id}
          creator={linkScope === "all" ? undefined : linkScope}
          title="Активность партнёра"
        />
      </div>
    </>
  );
}

function LinkGroups({ links }: { links: Link[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, Link[]>();
    for (const l of links) {
      const k = l.creator || "(unknown)";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(l);
    }
    return Array.from(m.entries());
  }, [links]);

  if (groups.length === 0) {
    return <div className="empty">Ссылки не найдены</div>;
  }
  return (
    <>
      {groups.map(([creator, items]) => {
        const sub = items.reduce(
          (a, l) => {
            const p = calcPayout(l);
            return {
              clicks: a.clicks + (l.clicks_count ?? 0),
              subs: a.subs + (l.subscribers_count ?? 0),
              revenue: a.revenue + (l.revenue_total ?? 0),
              payout: a.payout + p.value,
            };
          },
          { clicks: 0, subs: 0, revenue: 0, payout: 0 },
        );
        return <CreatorLinksGroup key={creator} creator={creator} items={items} sub={sub} />;
      })}
    </>
  );
}

type LinkSortKey = "campaign_code" | "of_created_at" | "clicks_count" | "subscribers_count" | "revenue_total" | "payout";

function CreatorLinksGroup({
  creator, items, sub,
}: {
  creator: string;
  items: Link[];
  sub: { clicks: number; subs: number; revenue: number; payout: number };
}) {
  const [open, setOpen] = useState(true);
  const [sortKey, setSortKey] = useState<LinkSortKey>("revenue_total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [drillLink, setDrillLink] = useState<Link | null>(null);

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      if (sortKey === "payout") {
        av = calcPayout(a).value;
        bv = calcPayout(b).value;
      } else if (sortKey === "campaign_code") {
        av = a.campaign_code;
        bv = b.campaign_code;
      } else if (sortKey === "of_created_at") {
        av = a.of_created_at ?? "";
        bv = b.of_created_at ?? "";
      } else {
        av = (a[sortKey] as number) ?? 0;
        bv = (b[sortKey] as number) ?? 0;
      }
      let cmp = 0;
      if (typeof av === "string" && typeof bv === "string") {
        /* numeric: true даёт natural sort — "camp_2" < "camp_10" < "camp_55" */
        cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
      } else {
        cmp = Number(av) - Number(bv);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [items, sortKey, sortDir]);

  const toggle = (k: LinkSortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  };
  const sortArrow = (k: LinkSortKey) =>
    sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕";

  return (
    <div className="link-group">
      <div className="link-group-header" onClick={() => setOpen(!open)}>
        <span style={{ fontSize: 12, width: 14 }}>{open ? "▼" : "▶"}</span>
        <strong>{creator}</strong>
        <span className="muted" style={{ fontSize: 12 }}>· {items.length} ссылок</span>
        <span style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 12 }}>
          {fmt(sub.clicks)} clicks · {fmt(sub.subs)} subs · {money(sub.revenue)} · payout {money(sub.payout)}
        </span>
      </div>
      {open && (
        <div className="link-table-wrap">
          <table className="data link-table">
            <colgroup>
              <col style={{ width: "9%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "5%" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggle("campaign_code")}>Campaign<span className="sort-arrow">{sortArrow("campaign_code")}</span></th>
                <th>OF URL</th>
                <th className="sortable" onClick={() => toggle("of_created_at")}>Создана<span className="sort-arrow">{sortArrow("of_created_at")}</span> <Hint text="Дата создания кампании в OnlyFans." /></th>
                <th>CPF (free / paid) <Hint text="Cost Per Fan — фикс-ставка за подписку. Слева — за бесплатную, справа — за платную." /></th>
                <th>RevShare <Hint text="Процент от выручки. 30% = $30 партнёру с каждых $100." /></th>
                <th className="num sortable" onClick={() => toggle("clicks_count")}>Clicks<span className="sort-arrow">{sortArrow("clicks_count")}</span></th>
                <th className="num sortable" onClick={() => toggle("subscribers_count")}>Subs<span className="sort-arrow">{sortArrow("subscribers_count")}</span></th>
                <th className="num sortable" onClick={() => toggle("revenue_total")}>Revenue<span className="sort-arrow">{sortArrow("revenue_total")}</span></th>
                <th className="num sortable" onClick={() => toggle("payout")}>
                  Payout<span className="sort-arrow">{sortArrow("payout")}</span>
                  <Hint text="Hover на значение чтобы увидеть формулу. CPF: subs × ставка. RevShare: revenue × процент. Гибрид: max из двух." />
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((l) => {
                const p = calcPayout(l);
                return (
                  <tr key={l.id}>
                    <td>
                      <button
                        className="partner-link"
                        onClick={() => setDrillLink(l)}
                        title="Открыть фанов этой ссылки"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--accent)", fontWeight: 500, padding: 0 }}
                      >
                        {l.campaign_code} ↗
                      </button>
                    </td>
                    <td className="ellipsis">
                      <a href={l.of_url} target="_blank" rel="noopener noreferrer" title={l.of_url}>
                        {l.of_url.replace("https://onlyfans.com/", "")}
                      </a>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {l.of_created_at ? new Date(l.of_created_at).toLocaleDateString("ru-RU") : "—"}
                    </td>
                    <td>{rate(l.cpf_free, l.cpf_paid)}</td>
                    <td>{pct(l.revshare_pct)}</td>
                    <td className="num">{fmt(l.clicks_count)}</td>
                    <td className="num">{fmt(l.subscribers_count)}</td>
                    <td className="num">{money(l.revenue_total)}</td>
                    <td className="num" title={p.formula}>{money(p.value)}</td>
                    <td>
                      <button
                        className="btn-icon"
                        onClick={() => { navigator.clipboard.writeText(l.of_url); }}
                        title="Скопировать URL"
                      >📋</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {drillLink && <LinkFansModal link={drillLink} onClose={() => setDrillLink(null)} />}
    </div>
  );
}

function Stat({ label, value, accent, hint }: { label: string; value: string; accent?: boolean; hint: string }) {
  return (
    <div className={`stat${accent ? " accent" : ""}`}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        <Hint text={hint} />
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  accent,
  trend,
  trendKey,
  periodLabel,
  format = "number",
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
  trend?: TrendSummary | null;
  trendKey?: TrendKey;
  periodLabel?: string;
  format?: "number" | "money" | "percent-points";
}) {
  const delta = trend && trendKey ? trend.delta[trendKey] : null;
  const deltaPct = trend && trendKey ? trend.deltaPct[trendKey] : null;
  const isFlat = delta === null || Math.abs(delta) < 0.000001;
  const isUp = !isFlat && delta! > 0;
  const trendText = trendKey && periodLabel
    ? formatDelta(delta, deltaPct, format, periodLabel)
    : "Срез без динамики";

  return (
    <div className={`metric-card${accent ? " accent" : ""}`}>
      <div className="metric-label">
        {label}
        <Hint text={hint} />
      </div>
      <div className="metric-value">{value}</div>
      <div className={`metric-trend ${isFlat ? "flat" : isUp ? "up" : "down"}`}>
        {trendKey ? (
          <>
            <span>{isFlat ? "→" : isUp ? "▲" : "▼"}</span>
            <span>{trendText}</span>
          </>
        ) : (
          <span>{trendText}</span>
        )}
      </div>
    </div>
  );
}

function formatDelta(
  delta: number | null,
  deltaPct: number | null,
  format: "number" | "money" | "percent-points",
  periodLabel: string,
): string {
  if (delta === null) return `нет базы: ${periodLabel}`;
  const abs = Math.abs(delta);
  const primary =
    format === "money"
      ? `$${abs.toFixed(2)}`
      : format === "percent-points"
        ? `${(abs * 100).toFixed(1)} п.п.`
        : abs.toLocaleString("en-US");
  const secondary = deltaPct === null ? "" : ` (${Math.abs(deltaPct * 100).toFixed(0)}%)`;
  return `${primary}${secondary} vs предыдущий период (${periodLabel})`;
}
