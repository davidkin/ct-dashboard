import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, Creator, PartnerRow, TrendsResponse } from "../api";
import { ActiveFilters } from "../components/ActiveFilters";
import { ActivityChart } from "../components/ActivityChart";
import { CreatorSwitcher } from "../components/CreatorSwitcher";
import { Hint } from "../components/Hint";
import { Pagination } from "../components/Pagination";
import { StatSkeleton, TableSkeleton } from "../components/Skeleton";
import { TopMovers } from "../components/TopMovers";

const fmt = (n: number | null): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");
const money = (n: number | null): string =>
  n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
const pctFmt = (n: number | null): string =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;
const formatDateLabel = (dateOnly: string): string =>
  new Date(`${dateOnly}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });

type SortKey =
  | "display_name" | "type" | "source"
  | "links_count" | "clicks_total" | "subs_total" | "spenders_total" | "revenue_total" | "payout_total";

type TrendKey = "clicks" | "subs" | "spenders" | "revenue" | "payout" | "cr" | "arps";
type TrendRangeMode = "preset" | "custom";

interface TrendSummary {
  current: Record<TrendKey, number | null>;
  prior: Record<TrendKey, number | null>;
  delta: Record<TrendKey, number | null>;
  deltaPct: Record<TrendKey, number | null>;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "никогда";
  const d = new Date(iso.replace(" ", "T") + "Z").getTime();
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const selectedCreator = params.get("creator") || undefined;
  const [partners, setPartners] = useState<PartnerRow[] | null>(null);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [trends, setTrends] = useState<TrendsResponse | null>(null);
  const [trendDays, setTrendDays] = useState<7 | 30 | 90>(7);
  const [trendRangeMode, setTrendRangeMode] = useState<TrendRangeMode>("preset");
  const [trendStartDate, setTrendStartDate] = useState("");
  const [trendEndDate, setTrendEndDate] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [filterType, setFilterType] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("revenue_total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

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

  const load = () => {
    api.partners(selectedCreator).then(setPartners).catch(console.error);
    api.creators().then(setCreators).catch(console.error);
    api.trends(trendDays, selectedCreator, trendRange).then(setTrends).catch(console.error);
  };
  useEffect(() => { load(); }, [selectedCreator, trendDays, trendRange]);

  const sources = useMemo(() => {
    if (!partners) return [];
    return Array.from(new Set(partners.map((p) => p.source).filter(Boolean))) as string[];
  }, [partners]);
  const types = useMemo(() => {
    if (!partners) return [];
    return Array.from(new Set(partners.map((p) => p.type).filter(Boolean))) as string[];
  }, [partners]);

  const visible = useMemo(() => {
    if (!partners) return [];
    const filtered = partners.filter((p) => {
      if (filterSource && p.source !== filterSource) return false;
      if (filterType && p.type !== filterType) return false;
      if (search) {
        const haystack = [p.display_name, p.glossary_name, p.telegram ?? "", p.source ?? "", p.type ?? ""].join(" ").toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp = 0;
      if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
      else cmp = (Number(av ?? -Infinity)) - (Number(bv ?? -Infinity));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [partners, filterSource, filterType, search, sortKey, sortDir]);

  const pageData = useMemo(() => {
    const start = (page - 1) * pageSize;
    return visible.slice(start, start + pageSize);
  }, [visible, page, pageSize]);

  const totals = useMemo(() => {
    return (partners ?? []).reduce(
      (acc, p) => ({
        links: acc.links + (p.links_count ?? 0),
        clicks: acc.clicks + (p.clicks_total ?? 0),
        subs: acc.subs + (p.subs_total ?? 0),
        spenders: acc.spenders + (p.spenders_total ?? 0),
        revenue: acc.revenue + (p.revenue_total ?? 0),
        payout: acc.payout + (p.payout_total ?? 0),
      }),
      { links: 0, clicks: 0, subs: 0, spenders: 0, revenue: 0, payout: 0 },
    );
  }, [partners]);

  const derivedTotals = useMemo(() => ({
    cr: totals.clicks > 0 ? totals.subs / totals.clicks : null,
    arps: totals.subs > 0 ? totals.revenue / totals.subs : null,
  }), [totals]);

  const trendSummary = useMemo<TrendSummary | null>(() => {
    if (!trends) return null;
    const partnerIds = new Set((partners ?? []).map((p) => p.id));
    const rows = trends.data.filter((t) => partnerIds.has(t.id));
    const current = rows.reduce(
      (a, r) => ({
        clicks: a.clicks + r.current.clicks,
        subs: a.subs + r.current.subs,
        spenders: a.spenders + r.current.spenders,
        revenue: a.revenue + r.current.revenue,
        payout: a.payout + r.current.payout,
      }),
      { clicks: 0, subs: 0, spenders: 0, revenue: 0, payout: 0 },
    );
    const prior = rows.reduce(
      (a, r) => ({
        clicks: a.clicks + r.prior.clicks,
        subs: a.subs + r.prior.subs,
        spenders: a.spenders + r.prior.spenders,
        revenue: a.revenue + r.prior.revenue,
        payout: a.payout + r.prior.payout,
      }),
      { clicks: 0, subs: 0, spenders: 0, revenue: 0, payout: 0 },
    );
    const currentFull = {
      ...current,
      cr: current.clicks > 0 ? current.subs / current.clicks : null,
      arps: current.subs > 0 ? current.revenue / current.subs : null,
    };
    const priorFull = {
      ...prior,
      cr: prior.clicks > 0 ? prior.subs / prior.clicks : null,
      arps: prior.subs > 0 ? prior.revenue / prior.subs : null,
    };
    const delta = Object.fromEntries(
      (Object.keys(currentFull) as TrendKey[]).map((k) => [
        k,
        currentFull[k] === null || priorFull[k] === null ? null : currentFull[k]! - priorFull[k]!,
      ]),
    ) as TrendSummary["delta"];
    const deltaPct = Object.fromEntries(
      (Object.keys(currentFull) as TrendKey[]).map((k) => [
        k,
        currentFull[k] === null || priorFull[k] === null || priorFull[k] === 0
          ? null
          : (currentFull[k]! - priorFull[k]!) / priorFull[k]!,
      ]),
    ) as TrendSummary["deltaPct"];
    return { current: currentFull, prior: priorFull, delta, deltaPct };
  }, [trends, partners]);

  const lastSync = useMemo(() => {
    const source = selectedCreator
      ? creators.filter((c) => c.name === selectedCreator)
      : creators;
    return source
      .map((c) => c.last_synced_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  }, [creators, selectedCreator]);

  const doSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await api.forceSync();
      if (res.error) setSyncMessage(`Ошибка: ${res.error}`);
      else {
        const r = res.data?.results ?? [];
        setSyncMessage(r.map((x: { creator: string; matched: number; fetched: number }) => `${x.creator}: ${x.matched}/${x.fetched}`).join(" · "));
        load();
      }
    } catch (e) {
      setSyncMessage(`Error: ${e}`);
    } finally {
      setSyncing(false);
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
    setPage(1);
  };
  const SortHeader = ({ k, hint, children, num }: { k: SortKey; hint?: string; children: React.ReactNode; num?: boolean }) => (
    <th onClick={() => toggleSort(k)} className={`${num ? "num " : ""}sortable`}>
      {children}
      {hint && <Hint text={hint} />}
      <span className="sort-arrow">{sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕"}</span>
    </th>
  );

  const activeFilters = [
    filterSource && { label: "Источник", value: filterSource, onRemove: () => { setFilterSource(""); setPage(1); } },
    filterType && { label: "Тип", value: filterType, onRemove: () => { setFilterType(""); setPage(1); } },
    search && { label: "Поиск", value: search, onRemove: () => { setSearch(""); setPage(1); } },
  ].filter(Boolean) as { label: string; value: string; onRemove: () => void }[];

  const clearAll = () => { setFilterSource(""); setFilterType(""); setSearch(""); setPage(1); };

  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));

  if (!partners) {
    return (
      <>
        <StatSkeleton count={5} />
        <TableSkeleton rows={6} cols={8} />
      </>
    );
  }

  return (
    <>
      <section className="dashboard-section">
        <div className="section-header">
          <div>
            <h2>Тренды</h2>
            <p>Быстрый сигнал: кто даёт больше всего активности и кто растёт относительно прошлого периода.</p>
          </div>
        </div>
        <TopMovers partners={partners} trends={trends} />
      </section>

      <section className="dashboard-section">
        <div className="section-header">
          <div>
            <h2>Общий объём</h2>
            <p>Сумма по выбранной модели. Фильтры таблицы ниже на эти цифры не влияют.</p>
          </div>
          <div className="section-actions">
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
            <div className="date-range-inline" title="Кастомный период для динамики на KPI-карточках">
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
            <div className="muted" style={{ fontSize: 12 }}>
              Sync: {relativeTime(lastSync)}
              <Hint text="Последний sync с OnlyFansAPI. Авто каждые 5 часов." />
            </div>
            <button className="btn" onClick={doSync} disabled={syncing}>
              {syncing ? "Sync…" : "Sync now"}
            </button>
          </div>
        </div>

        <CreatorSwitcher />

        {syncMessage && (
          <div className="alert" style={{ color: syncMessage.startsWith("Ошибка") ? "var(--bad)" : "var(--good)" }}>
            {syncMessage}
          </div>
        )}

        <div className="kpi-grid">
          <MetricCard
            label="Ссылок"
            value={fmt(totals.links)}
            hint="Сколько уникальных трекинг-ссылок назначено выбранным партнёрам."
          />
          <MetricCard
            label="Clicks"
            value={fmt(totals.clicks)}
            hint="Общее число кликов по выбранному срезу."
            trend={trendSummary}
            trendKey="clicks"
            periodLabel={trendPeriodLabel}
          />
          <MetricCard
            label="Subs"
            value={fmt(totals.subs)}
            hint="Атрибутированные подписки, пришедшие по ссылкам партнёров."
            accent
            trend={trendSummary}
            trendKey="subs"
            periodLabel={trendPeriodLabel}
          />
          <MetricCard
            label="Spenders"
            value={fmt(totals.spenders)}
            hint="Сколько подписчиков сделали хотя бы одну трату."
            trend={trendSummary}
            trendKey="spenders"
            periodLabel={trendPeriodLabel}
          />
          <MetricCard
            label="CR%"
            value={pctFmt(derivedTotals.cr)}
            hint="Conversion Rate = Subs ÷ Clicks. Показывает качество трафика."
            trend={trendSummary}
            trendKey="cr"
            periodLabel={trendPeriodLabel}
            format="percent-points"
          />
          <MetricCard
            label="ARPS"
            value={money(derivedTotals.arps)}
            hint="Average Revenue Per Subscriber = Revenue ÷ Subs."
            trend={trendSummary}
            trendKey="arps"
            periodLabel={trendPeriodLabel}
            format="money"
          />
          <MetricCard
            label="Revenue"
            value={money(totals.revenue)}
            hint="Общая выручка с привлечённых фанатов."
            trend={trendSummary}
            trendKey="revenue"
            periodLabel={trendPeriodLabel}
            format="money"
          />
          <MetricCard
            label="Payout"
            value={money(totals.payout)}
            hint="Оценка выплаты партнёрам по текущей формуле: CPF / RevShare / hybrid MAX."
            accent
            trend={trendSummary}
            trendKey="payout"
            periodLabel={trendPeriodLabel}
            format="money"
          />
        </div>
      </section>

      <section className="dashboard-section">
        <div className="section-header">
          <div>
            <h2>Партнёры</h2>
            <p>Рабочая таблица для поиска, сортировки и перехода в профиль партнёра.</p>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Показано {visible.length} из {partners.length}
          </div>
        </div>

        <div className="toolbar">
          <div className="input-with-icon" style={{ minWidth: 320, flex: "0 1 360px" }}>
            <span className="input-icon">🔎</span>
            <input
              className="input"
              placeholder="Поиск: имя / @telegram / источник / тип…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <SelectWithHint
            value={filterSource}
            onChange={(v) => { setFilterSource(v); setPage(1); }}
            options={sources}
            placeholder="Источник: все"
            hint="Платформа, с которой партнёр льёт трафик."
          />
          <SelectWithHint
            value={filterType}
            onChange={(v) => { setFilterType(v); setPage(1); }}
            options={types}
            placeholder="Тип: все"
            hint="External — внешний партнёр. In-house — наша команда."
          />
        </div>

        <ActiveFilters filters={activeFilters} onClearAll={clearAll} />

        <div className="muted" style={{ fontSize: 12, margin: "0 4px 6px 4px" }}>
          💡 Клик по строке откроет профиль партнёра. Внутри будет разбивка по моделям (Free / Vip).
        </div>

        <table className="data clickable-rows">
        <thead>
          <tr>
            <th style={{ width: 28 }}></th>
            <SortHeader k="display_name">Партнёр</SortHeader>
            <th>Telegram</th>
            <SortHeader k="type" hint="External — внешний арбитражник. In-house — наша команда.">Тип</SortHeader>
            <SortHeader k="source">Источник</SortHeader>
            <SortHeader k="links_count" hint="Сколько трекинг-ссылок у партнёра (по обеим моделям)" num>Ссылок</SortHeader>
            <SortHeader k="clicks_total" hint="Клики по всем ссылкам партнёра" num>Clicks</SortHeader>
            <SortHeader k="subs_total" hint="Атрибутированные подписки" num>Subs</SortHeader>
            <SortHeader k="spenders_total" hint="Подписчики, которые что-то покупали" num>Spenders</SortHeader>
            <SortHeader k="revenue_total" hint="Выручка от подписчиков партнёра" num>Revenue</SortHeader>
            <SortHeader k="payout_total" hint="Оценка выплаты партнёру по текущей формуле" num>Payout</SortHeader>
          </tr>
        </thead>
        <tbody>
          {pageData.map((p) => (
            <tr key={p.id} onClick={() => navigate(`/partners/${p.id}${selectedCreator ? `?creator=${encodeURIComponent(selectedCreator)}` : ""}`)}>
              <td className="row-open">
                <span title="Открыть профиль партнёра">↗</span>
              </td>
              <td>
                <span className="partner-link">{p.display_name}</span>
              </td>
              <td className="muted" onClick={(e) => e.stopPropagation()}>
                {p.telegram
                  ? <a href={`https://t.me/${p.telegram.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer">{p.telegram}</a>
                  : "—"}
              </td>
              <td>{p.type ? <span className={`tag ${p.type === "External" ? "ext" : "in"}`}>{p.type}</span> : <span className="muted">—</span>}</td>
              <td>{p.source || <span className="muted">—</span>}</td>
              <td className="num">{p.links_count}</td>
              <td className="num">{fmt(p.clicks_total)}</td>
              <td className="num">{fmt(p.subs_total)}</td>
              <td className="num">{fmt(p.spenders_total)}</td>
              <td className="num">{money(p.revenue_total)}</td>
              <td className="num">{money(p.payout_total)}</td>
            </tr>
          ))}
          {pageData.length === 0 && (
            <tr><td colSpan={11} className="empty">Партнёры не найдены</td></tr>
          )}
        </tbody>
        </table>

        <Pagination
          page={page}
          totalPages={totalPages}
          pageSize={pageSize}
          totalItems={visible.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </section>

      {/* Активность — В САМОМ НИЗУ под таблицей */}
      <div style={{ marginTop: 32 }}>
        <ActivityChart creator={selectedCreator} title="Активность за период" />
      </div>
    </>
  );
}

function SelectWithHint({
  value, onChange, options, placeholder, hint,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
  hint: string;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <Hint text={hint} />
    </span>
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
