import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AnalyticsPartner,
  DailyReport,
  fetchAnalytics,
  fetchExportReport,
  fetchReplyStats,
  isAdmin,
  isAdminConfigured,
  patchPartner,
  ReplyStatsCampaign,
  setPayoutStatus,
} from "../api";
import { useModel } from "../hooks/useModel";
import DailyMatrix from "../components/DailyMatrix";
import DateRangePicker from "../components/DateRangePicker";
import OmReconcile from "../components/OmReconcile";
import ReplyStatsWidget from "../components/ReplyStatsWidget";
import { aggregateCampaigns, campaignTotals, CampSort, DEFAULT_CAMP_SORT } from "../lib/campaignAgg";

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

/** Заголовок-сортировщик: клик меняет колонку, повторный — направление. */
export function SortTh({
  label,
  col,
  sort,
  onSort,
  num,
}: {
  label: string;
  col: CampSort["key"];
  sort: CampSort;
  onSort: (s: CampSort) => void;
  num?: boolean;
}) {
  const active = sort.key === col;
  return (
    <th
      className={`pd-sort-th${num ? " num" : ""}${active ? " active" : ""}`}
      onClick={() => onSort({ key: col, dir: active && sort.dir === "asc" ? "desc" : "asc" })}
      title="Сортировать"
    >
      {label}
      <span className="pd-sort-caret">{active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
    </th>
  );
}

export default function PartnerDetail() {
  const { model } = useModel();
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
  const [replyByCode, setReplyByCode] = useState<Map<string, ReplyStatsCampaign>>(new Map());

  useEffect(() => {
    setLoading(true);
    setErr(null);
    Promise.all([
      fetchAnalytics({ from, to, model: model || undefined }),
      fetchExportReport({ partner: pid, from, to, all: true, source: "combined", model: model || undefined }),
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
  }, [pid, from, to, reloadNonce, model]);

  /* Конверсия в ответ по кампаниям — за всё время (не по периоду страницы,
     та же логика, что в ReplyStatsWidget), для колонок в таблице «Кампании». */
  useEffect(() => {
    let alive = true;
    fetchReplyStats({ partnerId: pid, from: "2020-01-01" })
      .then((r) => {
        if (!alive) return;
        setReplyByCode(new Map(r.campaigns.map((c) => [c.campaign_code, c])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pid, reloadNonce]);

  /* Сортировка таблицы кампаний: по умолчанию по номеру кампании, free перед paid. */
  const [campSort, setCampSort] = useState<CampSort>(DEFAULT_CAMP_SORT);
  const campaigns = useMemo(() => aggregateCampaigns(rep, campSort), [rep, campSort]);
  const totals = useMemo(() => campaignTotals(campaigns), [campaigns]);

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

  /* Free/VIP разбивка тех же чисел, что уже в totals — считаем из тех же campaigns,
     чтобы сумма Free+VIP всегда сходилась с общим числом наверху. */
  const tierSplit = (pick: (c: (typeof campaigns)[number]) => number) => {
    const free = campaigns.filter((c) => c.tier === "free").reduce((s, c) => s + pick(c), 0);
    const paid = campaigns.filter((c) => c.tier === "paid").reduce((s, c) => s + pick(c), 0);
    return `Free ${fmt(free)} · VIP ${fmt(paid)}`;
  };

  const kpis = [
    { label: "Клики", value: fmt(totals.clicks), accent: false, sub: tierSplit((c) => c.clicks) },
    { label: "Фаны", value: fmt(totals.fans), accent: false, sub: tierSplit((c) => c.fans) },
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
            disabled={!isAdmin()}
            title={isAdmin() ? undefined : "Выплаты переключает только админ"}
          >
            {status === "done" ? "Выплата: Готов" : "Выплата: Ожидает"}
          </button>
          <button
            className="btn ghost"
            onClick={toggleArchive}
            disabled={!isAdmin()}
            title={isAdmin() ? undefined : "Архивирует только админ"}
          >
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
            {k.sub && <div className="an-kpi-sub">{k.sub}</div>}
          </div>
        ))}
      </div>

      {/* виджеты «Тотал залив» + «Общая выплата» по этому партнёру (свой диапазон) */}
      <PartnerTotalsWidgets pid={pid} />

      {/* конверсия "фан ответил на приветку" — вынесена наверх, видное место, всегда развёрнута */}
      <ReplyStatsWidget partnerId={pid} collapsible={false} />

      {/* персональная таблица трафика (день × кампания) — сразу под «Итоги за период» */}
      {rep && (
        <DailyMatrix
          campaigns={rep.campaigns}
          rows={rep.rows}
          partnerId={pid}
          onChanged={() => setReloadNonce((n) => n + 1)}
        />
      )}

      {/* сверка тоталов с OM (истина) */}
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
                  <SortTh label="Кампания" col="code" sort={campSort} onSort={setCampSort} />
                  <th>Тир</th>
                  <th>Ссылка</th>
                  <SortTh label="Клики" col="clicks" sort={campSort} onSort={setCampSort} num />
                  <SortTh label="Фаны" col="fans" sort={campSort} onSort={setCampSort} num />
                  <SortTh label="Конверт" col="cr" sort={campSort} onSort={setCampSort} num />
                  <SortTh label="Выплата" col="payout" sort={campSort} onSort={setCampSort} num />
                  <th className="num" title="Фанов, ответивших на приветку хоть раз, из посчитанных фоновым процессом">
                    Ответили на приветку
                  </th>
                  <th className="num">%</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const rs = replyByCode.get(c.code);
                  return (
                    <tr key={c.link_id} style={{ cursor: "default" }}>
                      <td>{c.code}</td>
                      <td>
                        <span className={`tag pd-tier-${c.tier}`}>{c.tier}</span>
                      </td>
                      <td className="pd-camp-url">
                        <a href={c.of_url} target="_blank" rel="noreferrer">
                          {c.of_url}
                        </a>
                      </td>
                      <td className="num">{fmt(c.clicks)}</td>
                      <td className="num">{fmt(c.fans)}</td>
                      <td className="num muted">{pct(c.clicks > 0 ? c.fans / c.clicks : null)}</td>
                      <td className="num accent">{money(c.payout)}</td>
                      <td className="num muted">{rs ? `${rs.replied}/${rs.total}` : "—"}</td>
                      <td className="num muted">{rs ? `${rs.pct.toFixed(0)}%` : "—"}</td>
                    </tr>
                  );
                })}
                {!campaigns.length && (
                  <tr>
                    <td colSpan={9} className="muted" style={{ textAlign: "center", padding: 24 }}>
                      Нет кампаний за период.
                    </td>
                  </tr>
                )}
              </tbody>
              {campaigns.length > 0 && (
                <tfoot>
                  <tr className="dm-total-row">
                    <td>Total</td>
                    <td />
                    <td />
                    <td className="num">{fmt(totals.clicks)}</td>
                    <td className="num">{fmt(totals.fans)}</td>
                    <td className="num">{pct(totals.cr)}</td>
                    <td className="num accent">{money(totals.payout)}</td>
                    <td />
                    <td />
                  </tr>
                </tfoot>
              )}
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
  const { model } = useModel();
  const [wFrom, setWFrom] = useState(addDays(todayISO(), -29));
  const [wTo, setWTo] = useState(todayISO());
  const [rep, setRep] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchExportReport({ partner: pid, from: wFrom, to: wTo, all: true, source: "combined", model: model || undefined })
      .then((r) => alive && setRep(r))
      .catch(() => alive && setRep(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [pid, wFrom, wTo, model]);

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

