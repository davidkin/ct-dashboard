import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AnalyticsPartner,
  AnalyticsReport,
  fetchAnalytics,
  isAdminConfigured,
  isExportConfigured,
  patchPartner,
  setPayoutStatus,
} from "../api";
import DateRangePicker from "../components/DateRangePicker";
import OmReconcile from "../components/OmReconcile";

/* Главный экран «Общая аналитика». Строится поверх /export/analytics
   (та же combined-логика, что и «Таблица»). Заметки/статусы/архив — write через админ-креды. */

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
const money = (n: number) =>
  "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n));
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

type Tier = "" | "free" | "paid";

export default function Analytics() {
  const navigate = useNavigate();
  const [to, setTo] = useState(todayISO());
  const [from, setFrom] = useState(addDays(todayISO(), -29));
  const [tier, setTier] = useState<Tier>("");
  /* общий диапазон дат для виджетов «Тотал залив» + «Общая выплата» */
  const [wFrom, setWFrom] = useState(addDays(todayISO(), -29));
  const [wTo, setWTo] = useState(todayISO());
  const [rep, setRep] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [onlyActive, setOnlyActive] = useState(true); // дефолтный фильтр по активным

  /* локальные оверрайды после write, чтобы не перезапрашивать весь отчёт */
  const [statusOv, setStatusOv] = useState<Record<number, "done" | "pending">>({});
  const [noteOv, setNoteOv] = useState<Record<number, string>>({});
  const [archOv, setArchOv] = useState<Record<number, boolean>>({});
  const [activeOv, setActiveOv] = useState<Record<number, boolean>>({});
  const [noteOpen, setNoteOpen] = useState<number | null>(null);

  const load = () => {
    if (!isExportConfigured()) {
      setErr("VITE_API_BASE / VITE_EXPORT_TOKEN не заданы в .env.local");
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    fetchAnalytics({ from, to, tier: tier || undefined })
      .then((r) => {
        setRep(r);
        setStatusOv({});
        setNoteOv({});
        setArchOv({});
        setActiveOv({});
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [from, to, tier]);

  const statusOf = (p: AnalyticsPartner) => statusOv[p.partner_id] ?? p.payout_status;
  const noteOf = (p: AnalyticsPartner) => (p.partner_id in noteOv ? noteOv[p.partner_id] : p.note ?? "");
  const archOf = (p: AnalyticsPartner) => (p.partner_id in archOv ? archOv[p.partner_id] : p.archived);
  const activeOf = (p: AnalyticsPartner) => (p.partner_id in activeOv ? activeOv[p.partner_id] : p.active);

  async function setActive(p: AnalyticsPartner, next: boolean, e: React.ChangeEvent) {
    e.stopPropagation();
    setActiveOv((s) => ({ ...s, [p.partner_id]: next }));
    try {
      await patchPartner(p.partner_id, { active: next });
    } catch {
      setActiveOv((s) => ({ ...s, [p.partner_id]: !next }));
    }
  }

  const all = rep?.partners ?? [];
  const active = all.filter((p) => !archOf(p));
  const archived = all.filter((p) => archOf(p));

  const filtered = useMemo(() => {
    let list = active;
    /* дефолтный фильтр по активным (activeOf !== false — чтобы до рестарта, пока
       бэкенд не отдаёт active, показывались все) */
    if (onlyActive) list = list.filter((p) => activeOf(p) !== false);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) => p.display_name.toLowerCase().includes(q) || (p.telegram ?? "").toLowerCase().includes(q),
      );
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, query, archOv, activeOv, onlyActive]);

  /* KPI пересчитываем по активным (учёт локального архивирования) */
  const kpi = useMemo(() => {
    return {
      partners: active.length,
      clicks: active.reduce((s, p) => s + p.clicks, 0),
      fans: active.reduce((s, p) => s + p.fans, 0),
      revenue: active.reduce((s, p) => s + p.revenue, 0),
      payout: active.reduce((s, p) => s + p.payout, 0),
    };
  }, [active]);

  const top5 = useMemo(() => [...active].sort((a, b) => b.payout - a.payout).slice(0, 5), [active]);

  async function toggleStatus(p: AnalyticsPartner, e: React.MouseEvent) {
    e.stopPropagation();
    const next = statusOf(p) === "done" ? "pending" : "done";
    setStatusOv((s) => ({ ...s, [p.partner_id]: next }));
    try {
      await setPayoutStatus(p.partner_id, next, rep?.week_start);
    } catch {
      setStatusOv((s) => ({ ...s, [p.partner_id]: next === "done" ? "pending" : "done" }));
    }
  }
  async function toggleArchive(p: AnalyticsPartner, e: React.MouseEvent) {
    e.stopPropagation();
    const next = !archOf(p);
    setArchOv((s) => ({ ...s, [p.partner_id]: next }));
    try {
      await patchPartner(p.partner_id, { archived: next });
    } catch {
      setArchOv((s) => ({ ...s, [p.partner_id]: !next }));
    }
  }
  const saveNote = async (p: AnalyticsPartner, text: string) => {
    setNoteOv((s) => ({ ...s, [p.partner_id]: text }));
    try {
      await patchPartner(p.partner_id, { note: text });
    } catch {
      /* оставляем локально, при перезагрузке подтянется */
    }
  };

  const kpiCards = [
    { label: "Партнёров", value: fmt(kpi.partners), accent: false },
    { label: "Клики", value: fmt(kpi.clicks), accent: false },
    { label: "Фаны", value: fmt(kpi.fans), accent: false },
    { label: "Выручка", value: money(kpi.revenue), accent: true },
    { label: "Выплата", value: money(kpi.payout), accent: true },
  ];

  return (
    <div className="an fadeUp">
      {/* toolbar */}
      <div className="an-toolbar">
        <div className="seg">
          {(["", "free", "paid"] as Tier[]).map((t) => (
            <button key={t || "all"} className={`seg-btn${tier === t ? " active" : ""}`} onClick={() => setTier(t)}>
              {t === "" ? "Все" : t === "free" ? "Free" : "Paid"}
            </button>
          ))}
        </div>
        <DateRangePicker
          from={from}
          to={to}
          onChange={(f, t) => {
            setFrom(f);
            setTo(t);
          }}
        />
      </div>

      {err && <div className="alert">{err}</div>}
      {loading && !rep && <p className="muted">Загружаю аналитику…</p>}

      {rep && (
        <>
          {/* KPI */}
          <div className="an-kpis">
            {kpiCards.map((k) => (
              <div key={k.label} className="an-kpi">
                <div className="an-kpi-label">{k.label}</div>
                <div className={`an-kpi-val${k.accent ? " accent" : ""}`}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* виджеты с ОБЩИМ диапазоном дней (агрегат по всем партнёрам) */}
          <div className="an-widgets-bar">
            <h3 className="an-widgets-title">Итоги за период</h3>
            <DateRangePicker
              from={wFrom}
              to={wTo}
              onChange={(f, t) => {
                setWFrom(f);
                setWTo(t);
              }}
            />
          </div>
          <div className="an-two an-widgets">
            <RangeWidget title="Тотал залив" from={wFrom} to={wTo} tier={tier}>
              {(k, loading) => (
                <div className="an-widget-nums">
                  <div>
                    <div className="an-kpi-label">Клики</div>
                    <div className="an-kpi-val">{loading && !k ? "…" : fmt(k?.clicks ?? 0)}</div>
                  </div>
                  <div>
                    <div className="an-kpi-label">Фаны</div>
                    <div className="an-kpi-val">{loading && !k ? "…" : fmt(k?.fans ?? 0)}</div>
                  </div>
                </div>
              )}
            </RangeWidget>
            <RangeWidget title="Общая выплата" from={wFrom} to={wTo} tier={tier}>
              {(k, loading) => (
                <div className="an-widget-nums">
                  <div>
                    <div className="an-kpi-label">Выплата всем трафферам</div>
                    <div className="an-kpi-val accent">{loading && !k ? "…" : money(k?.payout ?? 0)}</div>
                  </div>
                </div>
              )}
            </RangeWidget>
          </div>

          {/* сверка тоталов с OM (истина) по всем партнёрам */}
          <OmReconcile />

          {/* chart */}
          <Chart daily={rep.daily} />

          {/* tier split + sources */}
          <div className="an-two">
            <TierSplit tiers={rep.tiers} />
            <Sources sources={rep.sources} />
          </div>

          {/* partners table */}
          <div className="an-card">
            <div className="an-card-head">
              <h3>
                {onlyActive ? "Активные партнёры" : "Все партнёры"} <span className="faint">· {filtered.length}</span>
              </h3>
              <div className="an-card-head-actions">
                <button
                  className={`seg-btn an-active-toggle${onlyActive ? " active" : ""}`}
                  onClick={() => setOnlyActive((v) => !v)}
                  title="Показывать только активных партнёров"
                >
                  {onlyActive ? "Только активные" : "Все партнёры"}
                </button>
                <div className="input-with-icon an-search">
                  <span className="input-icon">⌕</span>
                  <input
                    className="input"
                    placeholder="Поиск партнёра…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              </div>
            </div>
            <div className="an-table-wrap">
              <table className="an-table">
                <thead>
                  <tr>
                    <th className="an-rownum-h">#</th>
                    <th>Партнёр</th>
                    <th>Активность</th>
                    <th>Тип</th>
                    <th>Источник</th>
                    <th className="num">Клики</th>
                    <th className="num">Фаны</th>
                    <th className="num">Конверт</th>
                    <th className="num">Выручка</th>
                    <th className="num">Выплата</th>
                    <th>Статус</th>
                    <th className="num">Δ</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, i) => (
                    <tr key={p.partner_id} onClick={() => navigate(`/partners/${p.partner_id}`)}>
                      <td className="an-rownum">{i + 1}</td>
                      <td>
                        <div className="an-partner">
                          <span className="an-ava">{initials(p.display_name)}</span>
                          <div className="an-partner-txt">
                            <span className="an-partner-name">
                              {p.display_name}
                              <button
                                className={`an-note${noteOf(p) ? " has" : ""}`}
                                title={noteOf(p) || "Добавить заметку"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setNoteOpen(noteOpen === p.partner_id ? null : p.partner_id);
                                }}
                              >
                                !
                              </button>
                            </span>
                            {p.telegram && <span className="an-partner-tg">{p.telegram}</span>}
                          </div>
                          {noteOpen === p.partner_id && (
                            <div className="an-note-pop" onClick={(e) => e.stopPropagation()}>
                              <textarea
                                autoFocus
                                placeholder="Заметка о партнёре…"
                                value={noteOf(p)}
                                onChange={(e) => saveNote(p, e.target.value)}
                              />
                              <button className="btn" onClick={() => setNoteOpen(null)}>
                                Готово
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className={`an-active-sel ${activeOf(p) ? "on" : "off"}`}
                          value={activeOf(p) ? "1" : "0"}
                          onChange={(e) => setActive(p, e.target.value === "1", e)}
                          disabled={!isAdminConfigured()}
                        >
                          <option value="1">Активный</option>
                          <option value="0">Не активный</option>
                        </select>
                      </td>
                      <td>{p.type ? <span className="tag">{p.type}</span> : <span className="faint">—</span>}</td>
                      <td className="muted">{p.source || "—"}</td>
                      <td className="num">{fmt(p.clicks)}</td>
                      <td className="num">{fmt(p.fans)}</td>
                      <td className="num muted">{pct(p.cr)}</td>
                      <td className="num">{money(p.revenue)}</td>
                      <td className="num accent">{money(p.payout)}</td>
                      <td>
                        <button
                          className={`status-badge ${statusOf(p) === "done" ? "done" : "pending"}`}
                          onClick={(e) => toggleStatus(p, e)}
                          disabled={!isAdminConfigured()}
                        >
                          {statusOf(p) === "done" ? "Готов" : "Ожидает"}
                        </button>
                      </td>
                      <td className={`num ${p.trend == null ? "muted" : p.trend >= 0 ? "up" : "down"}`}>
                        {p.trend == null ? "—" : (p.trend >= 0 ? "▲ " : "▼ ") + fmt(Math.abs(p.trend))}
                      </td>
                      <td>
                        <button
                          className="an-arch-btn"
                          title="Архивировать"
                          onClick={(e) => toggleArchive(p, e)}
                          disabled={!isAdminConfigured()}
                        >
                          ⧉
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!filtered.length && (
                    <tr>
                      <td colSpan={13} className="muted" style={{ textAlign: "center", padding: 24 }}>
                        Нет партнёров за период.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* archive */}
          {archived.length > 0 && (
            <div className="an-card">
              <button className="an-arch-toggle" onClick={() => setShowArchived((s) => !s)}>
                ⧉ {showArchived ? "Скрыть архив" : "Показать архив"} · {archived.length}
              </button>
              {showArchived && (
                <div className="an-table-wrap">
                  <table className="an-table an-archived">
                    <tbody>
                      {archived.map((p) => (
                        <tr key={p.partner_id} onClick={() => navigate(`/partners/${p.partner_id}`)}>
                          <td>
                            <div className="an-partner">
                              <span className="an-ava">{initials(p.display_name)}</span>
                              <span className="an-partner-name">{p.display_name}</span>
                            </div>
                          </td>
                          <td className="num">{fmt(p.fans)} фан</td>
                          <td className="num accent">{money(p.payout)}</td>
                          <td>
                            <button className="btn ghost" onClick={(e) => toggleArchive(p, e)}>
                              ↩ Восстановить
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* top-5 */}
          {top5.length > 0 && (
            <div className="an-card an-top">
              <div className="an-card-head">
                <h3>Топ-5 партнёров по выплате</h3>
              </div>
              <div className="an-top-list">
                {top5.map((p, i) => (
                  <div key={p.partner_id} className="an-top-row" onClick={() => navigate(`/partners/${p.partner_id}`)}>
                    <span className="an-top-rank">{i + 1}</span>
                    <span className="an-ava">{initials(p.display_name)}</span>
                    <div className="an-partner-txt">
                      <span className="an-partner-name">{p.display_name}</span>
                      {p.telegram && <span className="an-partner-tg">{p.telegram}</span>}
                    </div>
                    <span className="an-top-fans muted">{fmt(p.fans)} фан</span>
                    <span className="an-top-pay accent">{money(p.payout)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* === виджет-метрика (управляемый диапазон) ===
   Тянет /export/analytics за переданный период (та же combined-логика =
   «Таблица»), отдаёт kpi (clicks/fans/payout по активным партнёрам) в render-проп. */
function RangeWidget({
  title,
  from,
  to,
  tier,
  children,
}: {
  title: string;
  from: string;
  to: string;
  tier: Tier;
  children: (kpi: AnalyticsReport["kpi"] | undefined, loading: boolean) => React.ReactNode;
}) {
  const [kpi, setKpi] = useState<AnalyticsReport["kpi"] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetchAnalytics({ from, to, tier: tier || undefined, sheetOnly: true })
      .then((r) => alive && setKpi(r.kpi))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [from, to, tier]);

  return (
    <div className="an-card an-widget">
      <div className="an-card-head">
        <h3>{title}</h3>
      </div>
      <div className="an-widget-body">
        {err ? <span className="muted">{err}</span> : children(kpi, loading)}
      </div>
    </div>
  );
}

/* === график клики+фаны === */
function Chart({ daily }: { daily: AnalyticsReport["daily"] }) {
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

/* === сплит по тирам === */
function TierSplit({ tiers }: { tiers: AnalyticsReport["tiers"] }) {
  const rows = [
    { label: "Free", ...tiers.free },
    { label: "Paid", ...tiers.paid },
  ];
  const totalFans = rows.reduce((s, r) => s + r.fans, 0) || 1;
  return (
    <div className="an-card">
      <div className="an-card-head">
        <h3>Тиры</h3>
      </div>
      <div className="an-bars">
        {rows.map((r) => {
          const p = r.fans / totalFans;
          return (
            <div key={r.label} className="an-bar-row">
              <div className="an-bar-top">
                <span className="muted">{r.label}</span>
                <span>
                  {fmt(r.fans)} фан · {(p * 100).toFixed(0)}%
                </span>
              </div>
              <div className="an-bar-track">
                <div className="an-bar-fill" style={{ width: `${(p * 100).toFixed(1)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* === источники === */
function Sources({ sources }: { sources: AnalyticsReport["sources"] }) {
  const max = Math.max(1, ...sources.map((s) => s.fans));
  return (
    <div className="an-card">
      <div className="an-card-head">
        <h3>Источники трафика</h3>
      </div>
      <div className="an-sources">
        {sources.map((s) => (
          <div key={s.label} className="an-src-row">
            <span className="an-src-label muted">{s.label}</span>
            <div className="an-bar-track">
              <div className="an-bar-fill" style={{ width: `${((s.fans / max) * 100).toFixed(1)}%` }} />
            </div>
            <span className="an-src-val">{fmt(s.fans)}</span>
          </div>
        ))}
        {!sources.length && <p className="muted">Нет данных.</p>}
      </div>
    </div>
  );
}
