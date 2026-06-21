import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Hint } from "./Hint";

interface DayPoint {
  day: string;
  clicks: number | null;
  subs: number | null;
  spenders: number | null;
  revenue: number | null;
}

type Metric = "revenue" | "clicks" | "subs" | "spenders" | "cr";
type Mode = "total" | "delta";
type RangeMode = "preset" | "custom";

interface Props {
  partnerId?: number;
  creator?: string;
  title?: string;
}

const METRICS: Record<Metric, { label: string; color: string; money?: boolean; percent?: boolean }> = {
  revenue: { label: "Revenue", color: "#00AFF0", money: true },
  clicks: { label: "Clicks", color: "#5DD39E" },
  subs: { label: "Subs", color: "#FFB300" },
  spenders: { label: "Spenders", color: "#FF7A90" },
  cr: { label: "CR%", color: "#A78BFA", percent: true },
};

const fmt = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");
const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;
const percent = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${Number(n).toFixed(1)}%`;

/**
 * Динамика по дням: итоговое состояние или дневной прирост.
 * Источник — latest snapshot per link per day с backend /api/activity.
 */
export function ActivityChart({ partnerId, creator, title = "Активность" }: Props) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [rangeMode, setRangeMode] = useState<RangeMode>("preset");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [mode, setMode] = useState<Mode>("total");
  const [active, setActive] = useState<Metric[]>(["revenue", "clicks", "subs"]);
  const [data, setData] = useState<DayPoint[] | null>(null);

  useEffect(() => {
    const url = new URL("/api/activity", window.location.origin);
    if (rangeMode === "custom" && (startDate || endDate)) {
      if (startDate) url.searchParams.set("start", startDate);
      if (endDate) url.searchParams.set("end", endDate);
    } else {
      url.searchParams.set("days", String(days));
    }
    if (partnerId) url.searchParams.set("partner_id", String(partnerId));
    if (creator) url.searchParams.set("creator", creator);
    setData(null);
    fetch(url.toString())
      .then((r) => r.json())
      .then((j) => setData(j.data ?? []))
      .catch(console.error);
  }, [days, rangeMode, startDate, endDate, partnerId, creator]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.map((d, i) => {
      const prev = i > 0 ? data[i - 1] : null;
      const clicks = Number(d.clicks ?? 0);
      const subs = Number(d.subs ?? 0);
      const spenders = Number(d.spenders ?? 0);
      const revenue = Number(d.revenue ?? 0);
      const prevClicks = Number(prev?.clicks ?? 0);
      const prevSubs = Number(prev?.subs ?? 0);
      const prevSpenders = Number(prev?.spenders ?? 0);
      const prevRevenue = Number(prev?.revenue ?? 0);
      const values = mode === "delta"
        ? {
            clicks: Math.max(0, clicks - prevClicks),
            subs: Math.max(0, subs - prevSubs),
            spenders: Math.max(0, spenders - prevSpenders),
            revenue: Math.max(0, revenue - prevRevenue),
          }
        : { clicks, subs, spenders, revenue };
      return {
        day: d.day.slice(5),
        fullDay: d.day,
        ...values,
        cr: values.clicks > 0 ? (values.subs / values.clicks) * 100 : 0,
      };
    });
  }, [data, mode]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const first = chartData[0];
    const last = chartData[chartData.length - 1];
    const sums = chartData.reduce(
      (a, d) => ({
        clicks: a.clicks + d.clicks,
        subs: a.subs + d.subs,
        spenders: a.spenders + d.spenders,
        revenue: a.revenue + d.revenue,
      }),
      { clicks: 0, subs: 0, spenders: 0, revenue: 0 },
    );
    const delta = {
      clicks: last.clicks - first.clicks,
      subs: last.subs - first.subs,
      spenders: last.spenders - first.spenders,
      revenue: last.revenue - first.revenue,
    };
    const base = mode === "delta" ? sums : delta;
    return {
      ...base,
      cr: base.clicks > 0 ? (base.subs / base.clicks) * 100 : null,
      bestDay: [...chartData].sort((a, b) => b.subs - a.subs || b.clicks - a.clicks)[0],
    };
  }, [chartData, mode]);

  const toggleMetric = (metric: Metric) => {
    setActive((cur) => {
      if (cur.includes(metric)) {
        return cur.length === 1 ? cur : cur.filter((m) => m !== metric);
      }
      return [...cur, metric];
    });
  };

  const Chart = active.length === 1 ? AreaChart : LineChart;
  const rangeLabel = rangeMode === "custom" && (startDate || endDate)
    ? `${startDate || "начало"} — ${endDate || "сегодня"}`
    : `последние ${days}д`;

  return (
    <div className="card chart-card">
      <div className="chart-toolbar">
        <h2 style={{ margin: 0, fontSize: 15, flex: 1 }}>
          {title}
          <Hint text="Итог — состояние на конец дня. Прирост — сколько добавилось за день относительно предыдущего snapshot-дня." />
        </h2>
        <div className="scope-tabs">
          {(["total", "delta"] as const).map((m) => (
            <button
              key={m}
              className={`chip${mode === m ? " active" : ""}`}
              onClick={() => setMode(m)}
            >{m === "total" ? "Итог" : "Прирост"}</button>
          ))}
        </div>
        <div className="scope-tabs">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className={`chip${rangeMode === "preset" && days === d ? " active" : ""}`}
              onClick={() => {
                setRangeMode("preset");
                setDays(d as 7 | 30 | 90);
              }}
            >{d}д</button>
          ))}
        </div>
      </div>

      <div className="chart-range-row">
        <span className="muted" style={{ fontSize: 12 }}>
          Диапазон:
          <Hint text="Для кастомного периода можно указать обе даты или только начало / конец. Быстрые кнопки 7/30/90 возвращают режим последних дней." />
        </span>
        <input
          className="input"
          type="date"
          value={startDate}
          onChange={(e) => {
            setRangeMode("custom");
            setStartDate(e.target.value);
          }}
        />
        <span className="muted" style={{ fontSize: 12 }}>по</span>
        <input
          className="input"
          type="date"
          value={endDate}
          onChange={(e) => {
            setRangeMode("custom");
            setEndDate(e.target.value);
          }}
        />
        {(startDate || endDate) && (
          <button
            className="btn ghost"
            onClick={() => {
              setStartDate("");
              setEndDate("");
              setRangeMode("preset");
            }}
            style={{ padding: "5px 12px" }}
          >
            Сбросить
          </button>
        )}
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
          {rangeLabel}
        </span>
      </div>

      <div className="chart-metric-row">
        {(Object.keys(METRICS) as Metric[]).map((m) => (
          <button
            key={m}
            className={`metric-toggle${active.includes(m) ? " active" : ""}`}
            onClick={() => toggleMetric(m)}
            style={{ borderColor: active.includes(m) ? METRICS[m].color : undefined }}
          >
            <span style={{ background: METRICS[m].color }} />
            {METRICS[m].label}
          </button>
        ))}
      </div>

      {summary && (
        <div className="chart-summary-grid">
          <ChartSummary label={mode === "delta" ? "Clicks за период" : "Clicks Δ"} value={fmt(summary.clicks)} />
          <ChartSummary label={mode === "delta" ? "Subs за период" : "Subs Δ"} value={fmt(summary.subs)} accent />
          <ChartSummary label={mode === "delta" ? "Revenue за период" : "Revenue Δ"} value={money(summary.revenue)} />
          <ChartSummary label="CR периода" value={percent(summary.cr)} />
          <ChartSummary label="Лучший день" value={summary.bestDay ? `${summary.bestDay.day} · ${fmt(summary.bestDay.subs)} subs` : "—"} />
        </div>
      )}

      {!data && <div className="chart-empty">Загружаю…</div>}
      {data && chartData.length === 0 && (
        <div className="chart-empty">
          Нет snapshot-ов за период: {rangeLabel}. Sync должен поднабрать историю.
        </div>
      )}
      {data && chartData.length > 0 && (
        <div style={{ height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <Chart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                {active.map((m) => (
                  <linearGradient key={m} id={`grad-${m}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={METRICS[m].color} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={METRICS[m].color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid stroke="rgba(148,166,176,0.15)" strokeDasharray="3 3" />
              <XAxis dataKey="day" stroke="var(--muted)" fontSize={11} />
              <YAxis stroke="var(--muted)" fontSize={11} />
              <Tooltip content={<ChartTooltip activeMetrics={active} />} cursor={{ stroke: "var(--accent)", strokeWidth: 1 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {active.map((m) => {
                const common = {
                  key: m,
                  type: "monotone" as const,
                  dataKey: m,
                  stroke: METRICS[m].color,
                  strokeWidth: 2,
                  name: METRICS[m].label,
                  dot: false,
                  activeDot: { r: 4 },
                };
                return active.length === 1
                  ? <Area {...common} fill={`url(#grad-${m})`} fillOpacity={1} />
                  : <Line {...common} />;
              })}
            </Chart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function ChartSummary({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`chart-summary${accent ? " accent" : ""}`}>
      <div className="muted">{label}</div>
      <strong>{value}</strong>
    </div>
  );
}

function ChartTooltip({ active, payload, label, activeMetrics }: {
  active?: boolean;
  payload?: Array<{ dataKey: Metric; value: number; color: string }>;
  label?: string;
  activeMetrics: Metric[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const byKey = new Map(payload.map((p) => [p.dataKey, p]));
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{label}</div>
      {activeMetrics.map((m) => {
        const item = byKey.get(m);
        const value = item?.value ?? 0;
        const meta = METRICS[m];
        return (
          <div key={m} className="chart-tooltip-row">
            <span className="dot" style={{ background: meta.color }} />
            <span>{meta.label}</span>
            <strong>{meta.money ? money(value) : meta.percent ? percent(value) : fmt(value)}</strong>
          </div>
        );
      })}
    </div>
  );
}
