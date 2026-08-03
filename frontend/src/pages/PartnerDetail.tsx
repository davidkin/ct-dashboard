import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AnalyticsPartner,
  DailyReport,
  fetchAnalytics,
  fetchExportReport,
  isAdminConfigured,
  patchPartner,
  setPayoutStatus,
} from "../api";
import DailyMatrix from "../components/DailyMatrix";
import DateRangePicker from "../components/DateRangePicker";
import OmReconcile from "../components/OmReconcile";

/* Профиль партнёра (дизайн, экран 5). Данные — через export-токен (combined),
   поэтому работает на проде. Заметка/статус/архив — write через админ-креды. */

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
const money = (n: number) => "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n));
const pct = (n: number | null) => (n == null ? "—" : (n * 100).toFixed(1) + "%");
const initials = (name: string) =>
  name.replace(/^@/, "").split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
const todayISO = () => new Date().toISOString().slice(0, 10);

interface CampAgg {
  link_id: number;
  code: string;
  tier: "free" | "paid";
  clicks: number;
  fans: number;
  payout: number;
}

export default function PartnerDetail() {
  const { id } = useParams<{ id: string }>();
  const pid = Number(id);
  const navigate = useNavigate();

  const [to, setTo] = useState(todayISO());
  const [from, setFrom] = useState(addDays(todayISO(), -29));
  const [meta, setMeta] = useState<AnalyticsPartner | null>(null);
  const [rep, setRep] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [reloadNonce, setReloadNonce] = useState(0);
  const [statusOv, setStatusOv] = useState<"done" | "pending" | null>(null);
  const [archOv, setArchOv] = useState<boolean | null>(null);
  const [noteOv, setNoteOv] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    Promise.all([
      fetchAnalytics({ from, to }),
      fetchExportReport({ partner: pid, from, to, all: true, source: "combined" }),
    ])
      .then(([an, report]) => {
        setMeta(an.partners.find((p) => p.partner_id === pid) ?? null);
        setWeekStart(an.week_start);
        setRep(report);
        setStatusOv(null);
        setArchOv(null);
        setNoteOv(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [pid, from, to, reloadNonce]);

  const campaigns = useMemo<CampAgg[]>(() => {
    if (!rep) return [];
    const agg = new Map<number, CampAgg>();
    for (const c of rep.campaigns) {
      agg.set(c.link_id, { link_id: c.link_id, code: c.campaign_code, tier: c.tier, clicks: 0, fans: 0, payout: 0 });
    }
    for (const row of rep.rows) {
      for (const c of rep.campaigns) {
        const cell = row.cells[String(c.link_id)];
        if (!cell) continue;
        const a = agg.get(c.link_id)!;
        a.clicks += cell.clicks ?? 0;
        a.fans += cell.subs;
        a.payout += cell.payout;
      }
    }
    return [...agg.values()].sort((a, b) => b.payout - a.payout);
  }, [rep]);

  const totals = useMemo(() => {
    const t = campaigns.reduce((s, c) => ({ clicks: s.clicks + c.clicks, fans: s.fans + c.fans, payout: s.payout + c.payout }), {
      clicks: 0,
      fans: 0,
      payout: 0,
    });
    return { ...t, cr: t.clicks > 0 ? t.fans / t.clicks : null };
  }, [campaigns]);

  const status = statusOv ?? meta?.payout_status ?? "pending";
  const archived = archOv ?? meta?.archived ?? false;
  const note = noteOv ?? meta?.note ?? "";

  async function toggleStatus() {
    const next = status === "done" ? "pending" : "done";
    setStatusOv(next);
    try {
      await setPayoutStatus(pid, next, weekStart);
    } catch {
      setStatusOv(next === "done" ? "pending" : "done");
    }
  }
  async function toggleArchive() {
    const next = !archived;
    setArchOv(next);
    try {
      await patchPartner(pid, { archived: next });
      if (next) navigate("/");
    } catch {
      setArchOv(!next);
    }
  }
  async function saveNote(text: string) {
    setNoteOv(text);
    try {
      await patchPartner(pid, { note: text });
    } catch {
      /* оставим локально */
    }
  }

  const [noteOpen, setNoteOpen] = useState(false);
  const [campOpen, setCampOpen] = useState(false);

  if (loading && !meta && !rep) return <p className="muted">Загружаю профиль…</p>;
  if (err) return <div className="alert">{err}</div>;

  const name = meta?.display_name ?? rep?.campaigns[0]?.partner_name ?? `Партнёр #${pid}`;

  const kpis = [
    { label: "Клики", value: fmt(totals.clicks), accent: false },
    { label: "Фаны", value: fmt(totals.fans), accent: false },
    { label: "Конверт", value: pct(totals.cr), accent: false },
    { label: "Выручка", value: money(meta?.revenue ?? 0), accent: true },
    { label: "Выплата", value: money(totals.payout), accent: true },
  ];

  return (
    <div className="an fadeUp">
      <div className="pd-back">
        <button className="btn ghost" onClick={() => navigate(-1)}>
          ← Назад
        </button>
        <div className="an-period">
          <span className="muted">с</span>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <span className="muted">по</span>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {/* header card */}
      <div className="an-card pd-header">
        <span className="an-ava pd-ava">{initials(name)}</span>
        <div className="pd-head-txt">
          <div className="pd-head-name">
            <h2>{name}</h2>
            {meta?.type && <span className="tag">{meta.type}</span>}
            <div style={{ position: "relative" }}>
              <button
                className={`an-note${note ? " has" : ""}`}
                title={note || "Добавить заметку"}
                onClick={() => setNoteOpen((s) => !s)}
              >
                !
              </button>
              {noteOpen && (
                <div className="an-note-pop">
                  <textarea autoFocus placeholder="Заметка…" value={note} onChange={(e) => saveNote(e.target.value)} />
                  <button className="btn" onClick={() => setNoteOpen(false)}>
                    Готово
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="pd-head-meta muted">
            {meta?.telegram && (
              <a href={`https://t.me/${meta.telegram.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer">
                {meta.telegram}
              </a>
            )}
            {meta?.source && <span>· {meta.source}</span>}
          </div>
        </div>
        <div className="pd-head-actions">
          <button
            className={`status-badge ${status === "done" ? "done" : "pending"}`}
            onClick={toggleStatus}
            disabled={!isAdminConfigured()}
          >
            {status === "done" ? "Выплата: Готов" : "Выплата: Ожидает"}
          </button>
          <button className="btn ghost" onClick={toggleArchive} disabled={!isAdminConfigured()}>
            {archived ? "↩ Восстановить" : "⧉ Архивировать"}
          </button>
        </div>
      </div>

      {/* KPI */}
      <div className="an-kpis pd-kpis">
        {kpis.map((k) => (
          <div key={k.label} className="an-kpi">
            <div className="an-kpi-label">{k.label}</div>
            <div className={`an-kpi-val${k.accent ? " accent" : ""}`}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* виджеты «Тотал залив» + «Общая выплата» по этому партнёру (свой диапазон) */}
      <PartnerTotalsWidgets pid={pid} />

      {/* персональная таблица трафика (день × кампания) — сразу под «Итоги за период» */}
      {rep && (
        <DailyMatrix
          campaigns={rep.campaigns}
          rows={rep.rows}
          partnerId={pid}
          onChanged={() => setReloadNonce((n) => n + 1)}
        />
      )}

      {/* daily chart — «Динамика по дням» */}
      {rep && <ProfileChart rows={rep.rows} />}

      {/* сверка тоталов с OM (истина) — свёрнута, под «Динамика по дням» */}
      <OmReconcile partnerId={pid} collapsible />

      {/* кампании / ссылки — свёрнуты в аккордеон */}
      <div className="an-card">
        <div className={`pd-acc-head${campOpen ? " open" : ""}`} onClick={() => setCampOpen((s) => !s)}>
          <h3>
            Кампании <span className="faint">· {campaigns.length}</span>
          </h3>
          <span className="pd-acc-caret">▶</span>
        </div>
        {campOpen && (
          <div className="an-table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th>Кампания</th>
                  <th>Тир</th>
                  <th className="num">Клики</th>
                  <th className="num">Фаны</th>
                  <th className="num">Конверт</th>
                  <th className="num">Выплата</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.link_id} style={{ cursor: "default" }}>
                    <td>{c.code}</td>
                    <td>
                      <span className={`tag pd-tier-${c.tier}`}>{c.tier}</span>
                    </td>
                    <td className="num">{fmt(c.clicks)}</td>
                    <td className="num">{fmt(c.fans)}</td>
                    <td className="num muted">{pct(c.clicks > 0 ? c.fans / c.clicks : null)}</td>
                    <td className="num accent">{money(c.payout)}</td>
                  </tr>
                ))}
                {!campaigns.length && (
                  <tr>
                    <td colSpan={6} className="muted" style={{ textAlign: "center", padding: 24 }}>
                      Нет кампаний за период.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* Виджеты «Тотал залив» + «Общая выплата» по одному партнёру — свой диапазон дат
   (общий на оба), тоталы считаются из per-partner отчёта (combined = «Таблица»). */
function PartnerTotalsWidgets({ pid }: { pid: number }) {
  const [wFrom, setWFrom] = useState(addDays(todayISO(), -29));
  const [wTo, setWTo] = useState(todayISO());
  const [rep, setRep] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchExportReport({ partner: pid, from: wFrom, to: wTo, all: true, source: "combined" })
      .then((r) => alive && setRep(r))
      .catch(() => alive && setRep(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [pid, wFrom, wTo]);

  const t = useMemo(() => {
    const rows = rep?.rows ?? [];
    return {
      clicks: rows.reduce((s, r) => s + (r.total.clicks ?? 0), 0),
      fans: rows.reduce((s, r) => s + r.total.subs, 0),
      payout: rows.reduce((s, r) => s + r.total.payout, 0),
    };
  }, [rep]);

  const busy = loading && !rep;

  return (
    <>
      <div className="an-widgets-bar">
        <h3 className="an-widgets-title">Итоги за период</h3>
        <DateRangePicker from={wFrom} to={wTo} onChange={(f, to2) => { setWFrom(f); setWTo(to2); }} />
      </div>
      <div className="an-two an-widgets">
        <div className="an-card an-widget">
          <div className="an-card-head">
            <h3>Тотал залив</h3>
          </div>
          <div className="an-widget-body">
            <div className="an-widget-nums">
              <div>
                <div className="an-kpi-label">Клики</div>
                <div className="an-kpi-val">{busy ? "…" : fmt(t.clicks)}</div>
              </div>
              <div>
                <div className="an-kpi-label">Фаны</div>
                <div className="an-kpi-val">{busy ? "…" : fmt(t.fans)}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="an-card an-widget">
          <div className="an-card-head">
            <h3>Общая выплата</h3>
          </div>
          <div className="an-widget-body">
            <div className="an-widget-nums">
              <div>
                <div className="an-kpi-label">Выплата</div>
                <div className="an-kpi-val accent">{busy ? "…" : money(t.payout)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ProfileChart({ rows }: { rows: DailyReport["rows"] }) {
  const daily = rows.map((r) => ({ day: r.date, clicks: r.total.clicks ?? 0, fans: r.total.subs }));
  if (!daily.length) return null;
  const W = 100;
  const H = 42;
  const maxC = Math.max(1, ...daily.map((d) => d.clicks));
  const maxF = Math.max(1, ...daily.map((d) => d.fans));
  const pts = (key: "clicks" | "fans", max: number) =>
    daily
      .map((d, i) => {
        const x = daily.length === 1 ? 0 : (i / (daily.length - 1)) * W;
        const y = H - (d[key] / max) * (H - 4) - 2;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  return (
    <div className="an-card an-chart">
      <div className="an-chart-head">
        <h3>Динамика по дням</h3>
        <div className="an-legend">
          <span>
            <i style={{ background: "var(--accent)" }} /> Клики
          </span>
          <span>
            <i style={{ background: "#7FA8C9" }} /> Фаны
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="an-chart-svg">
        {[10.5, 21, 31.5].map((y) => (
          <line key={y} x1="0" y1={y} x2={W} y2={y} stroke="var(--lineSoft)" strokeWidth="0.3" />
        ))}
        <polyline points={pts("clicks", maxC)} fill="none" stroke="var(--accent)" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={pts("fans", maxF)} fill="none" stroke="#7FA8C9" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
