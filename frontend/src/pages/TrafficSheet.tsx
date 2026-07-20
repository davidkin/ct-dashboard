import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { DailyReport, DailySnapshotInfo, fetchExportReport, isExportConfigured } from "../api";

/* Партнёры для дропдауна (id → лейбл), по промпту. Меняется только partner в fetch;
   контракт /export и рендер таблицы неизменны. Креатор пока фиксируем Nekoletta Free
   (Free/Velora-скоуп); список креаторов статичный — листы партнёров за Basic-auth не тянем. */
const PARTNERS: Array<{ id: number; label: string }> = [
  { id: 6,   label: "Adult Angels (@adultangels)" },
  { id: 43,  label: "TraffZone" },
  { id: 37,  label: "@nosenkko" },
  { id: 29,  label: "@awe2me" },
  { id: 286, label: "@rprstsw88 (Roma)" },
  { id: 273, label: "@magosym (Maga)" },
  { id: 306, label: "@vetalmg (Vitaliy)" },
  { id: 299, label: "@diamlan (Dima)" },
  { id: 296, label: "@postoffice4 (Sasha Post Office)" },
  { id: 26,  label: "@chyrtyyy (Gleb)" },
  { id: 38,  label: "@kantniy (Ruslan)" },
  { id: 307, label: "@pullupinmyx6 (Sasha)" },
  { id: 33,  label: "@Skivly (Konstantin)" },
  { id: 5,   label: "@innawork83 (Inna)" },
  { id: 270, label: "@sahssssss" },
  { id: 268, label: "@Celestrix001" },
  { id: 267, label: "@ZernoTag" },
  { id: 3,   label: "@ElmoSaniBoi (Elmar)" },
];
/* Free/Paid линки лежат в ОДНОЙ таблице. Тир-фильтр (серверный, через &tier=):
   Все = объединённый набор, Free / Paid = только этот срез (бэк сам пересчитывает Total). */
type Tier = "" | "free" | "paid";
const TIER_OPTIONS: Array<{ v: Tier; label: string }> = [
  { v: "", label: "Все" },
  { v: "free", label: "Free" },
  { v: "paid", label: "Paid" },
];

/* Начальный партнёр: из ?partner= в URL (чтобы refresh сохранял выбор), иначе первый. */
function initialPartnerId(): number {
  const q = Number(new URLSearchParams(window.location.search).get("partner"));
  return PARTNERS.some((p) => p.id === q) ? q : PARTNERS[0].id;
}

/* ── форматтеры под вид Google Sheets ── */
const intFmt = (n: number | null): string => (n == null ? "" : n.toLocaleString("en-US"));
const money = (n: number | null): string => (n == null ? "" : `$${n.toFixed(2)}`);
const pct = (n: number | null): string => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
const dmy = (d: string): string =>
  new Date(`${d}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });

type SheetTab = "total" | "raw";

export default function TrafficSheet() {
  const [partnerId, setPartnerId] = useState<number>(initialPartnerId);
  const [tier, setTier] = useState<Tier>(""); // "" = объединённый Free+Paid
  const [from, setFrom] = useState("2026-06-01");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<DailyReport | null>(null);
  const [tab, setTab] = useState<SheetTab>("total");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Держим выбранного партнёра в ?partner= — refresh сохраняет выбор. */
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("partner", String(partnerId));
    window.history.replaceState(null, "", url.toString());
  }, [partnerId]);

  /* Данные тянем напрямую с задеплоенного /export (read-only, токен в query). */
  const load = useCallback(() => {
    if (!isExportConfigured()) {
      setError("VITE_API_BASE / VITE_EXPORT_TOKEN не заданы в .env.local");
      return;
    }
    setLoading(true);
    setError(null);
    fetchExportReport({ partner: partnerId, tier: tier || undefined, from: from || undefined, to: to || undefined, all: true, source: "combined" })
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [partnerId, tier, from, to]);

  useEffect(() => { load(); }, [load]);

  const campaigns = report?.campaigns ?? [];
  const rows = report?.rows ?? [];
  const summary = report?.summary;
  const snapshot = report?.snapshot;

  /* Notes & Conditions — CPF / Revshare берём с кампаний партнёра */
  const cpf = campaigns[0]?.cpf ?? null;
  const revshare = campaigns.find((c) => c.revshare != null)?.revshare ?? 0;

  /* данные графика: Total клики + Total фаны по дням */
  const chartData = useMemo(
    () => rows.map((r) => ({ date: dmy(r.date), Клики: r.total.clicks, Фаны: r.total.subs })),
    [rows],
  );

  const partnerLabel = PARTNERS.find((p) => p.id === partnerId)?.label ?? "";
  const partnerName = report?.campaigns[0]?.partner_name ?? partnerLabel;

  return (
    <div className="gs-doc">
      {/* ── Панель управления ── */}
      <div className="gs-controls">
        <select className="gs-select" value={partnerId} onChange={(e) => setPartnerId(Number(e.target.value))}>
          {PARTNERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <div className="gs-seg" role="group" aria-label="Tier">
          {TIER_OPTIONS.map((t) => (
            <button
              key={t.v || "all"}
              className={`gs-seg-btn${tier === t.v ? " active" : ""}`}
              onClick={() => setTier(t.v)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="gs-ctl-label">с</span>
        <input className="gs-select" type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to || undefined} />
        <span className="gs-ctl-label">по</span>
        <input className="gs-select" type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} />
        <button className="gs-tab" onClick={load} disabled={loading}>{loading ? "загрузка…" : "⟳ Обновить"}</button>
        {error && <span className="gs-ctl-label" style={{ color: "#c00" }}>Ошибка: {error}</span>}
      </div>

      {/* ── Скоркарты по тирам + блок «Сегодня» ── */}
      <div className="gs-cards">
        <ScoreCard label="Free" accent="#4285F4" data={summary?.free} />
        <ScoreCard label="Paid" accent="#EA4335" data={summary?.paid} />
        <ScoreCard label="Всего" accent="#111" data={summary?.all} />
        {snapshot && <TodayBlock key={snapshot.next_capture_at} snap={snapshot} onExpire={load} />}
      </div>

      {/* ── Шапка: заголовок таблицы + Notes & Conditions ── */}
      <div className="gs-top">
        <div className="gs-title-block">
          <div className="gs-sheet-title">
            [{tier ? (tier === "paid" ? "PAID_" : "FREE_") : ""}{partnerName}]_traffic_tracking
          </div>
          <div className="gs-sheet-sub">{campaigns.length} компаний · {rows.length} дней</div>
        </div>
        <div className="gs-notes">
          <div className="gs-notes-hdr">Notes &amp; Conditions</div>
          <div className="gs-notes-row"><span>СPF</span><b>{cpf != null ? money(cpf) : "—"}</b></div>
          <div className="gs-notes-row"><span>Revshare</span><b>{pct(revshare)}</b></div>
          <div className="gs-notes-row gs-notes-comment"><span>Comments:</span><i>—</i></div>
        </div>
      </div>

      {/* ── График «Клики за залив & Фаны за залив» ── */}
      <div className="gs-chart-card">
        <div className="gs-chart-title">Клики за залив &amp; Фаны за залив</div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#e6e6e6" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#555" }} tickLine={false} axisLine={{ stroke: "#ccc" }} minTickGap={12} />
            <YAxis tick={{ fontSize: 11, fill: "#555" }} tickLine={false} axisLine={{ stroke: "#ccc" }} width={44} />
            <Tooltip contentStyle={{ fontFamily: "Arial", fontSize: 12, border: "1px solid #ccc" }} />
            <Legend wrapperStyle={{ fontFamily: "Arial", fontSize: 12 }} />
            <Line type="monotone" dataKey="Клики" stroke="#4285F4" strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="Фаны" stroke="#EA4335" strokeWidth={2} dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── Табы Total / Raw Data ── */}
      <div className="gs-tabs">
        <button className={`gs-tab${tab === "total" ? " active" : ""}`} onClick={() => setTab("total")}>Total</button>
        <button className={`gs-tab${tab === "raw" ? " active" : ""}`} onClick={() => setTab("raw")}>Raw Data</button>
      </div>

      {tab === "total" ? (
        <TotalTable campaigns={campaigns} rows={rows} />
      ) : (
        <RawTable campaigns={campaigns} rows={rows} />
      )}
    </div>
  );
}

/* ═══════════ Скоркарты по тирам (из summary) ═══════════ */
function ScoreCard({ label, accent, data }: { label: string; accent: string; data?: { clicks: number; fans: number } }) {
  const clicks = data?.clicks ?? 0;
  const fans = data?.fans ?? 0;
  return (
    <div className="gs-card">
      <div className="gs-card-label" style={{ color: accent }}>{label}</div>
      <div className="gs-card-nums">
        <div><b>{clicks.toLocaleString("en-US")}</b> <span>кликов</span></div>
        <div><b>{fans.toLocaleString("en-US")}</b> <span>фанов</span></div>
      </div>
    </div>
  );
}

/* ═══════════ Блок «Сегодня» + живой отсчёт до следующего снепшота ═══════════ */
function TodayBlock({ snap, onExpire }: { snap: DailySnapshotInfo; onExpire: () => void }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const firedRef = useRef(false);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = new Date(snap.next_capture_at).getTime() - nowMs;

  /* Отсчёт дошёл до 0 → джоб пишет в capture_time; ждём ~90с и рефетчим,
     чтобы last_snapshot прокатился на новый день. */
  useEffect(() => {
    if (remaining <= 0 && !firedRef.current) {
      firedRef.current = true;
      const t = setTimeout(onExpire, 90_000);
      return () => clearTimeout(t);
    }
  }, [remaining, onExpire]);

  const hhmmss = (ms: number): string => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };

  return (
    <div className="gs-today">
      <div className="gs-today-hdr">
        Сегодня: {snap.today} <span className="gs-today-tz">({snap.tz})</span>
      </div>
      <div className="gs-today-row">
        За {snap.last_snapshot_day ?? "—"}:{" "}
        <b>{snap.last_snapshot.clicks.toLocaleString("en-US")}</b> кликов /{" "}
        <b>{snap.last_snapshot.fans.toLocaleString("en-US")}</b> фанов
      </div>
      <div className="gs-today-row">
        Следующий снепшот через <b className="gs-today-cd">{remaining > 0 ? hhmmss(remaining) : "00:00:00"}</b>
        <span className="gs-today-tz"> (в {snap.capture_time} {snap.tz})</span>
      </div>
    </div>
  );
}

/* ═══════════ TOTAL ═══════════ */
function TotalTable({ campaigns, rows }: { campaigns: DailyReport["campaigns"]; rows: DailyReport["rows"] }) {
  const foot = useMemo(() => {
    const per = new Map<number, { clicks: number; fans: number; payout: number }>();
    campaigns.forEach((c) => per.set(c.link_id, { clicks: 0, fans: 0, payout: 0 }));
    let gClicks = 0, gFans = 0, gPay = 0;
    for (const r of rows) {
      gClicks += r.total.clicks ?? 0;
      gFans += r.total.subs ?? 0;
      gPay += r.total.payout ?? 0;
      for (const c of campaigns) {
        const cell = r.cells[String(c.link_id)];
        if (!cell) continue;
        const a = per.get(c.link_id)!;
        a.clicks += cell.clicks ?? 0;
        a.fans += cell.subs;
        a.payout += cell.payout;
      }
    }
    return { per, gClicks, gFans, gPay };
  }, [campaigns, rows]);

  return (
    <div className="gs-scroll">
      <table className="gs-table">
        <thead>
          <tr>
            <th className="gs-freeze" rowSpan={2}>Дата</th>
            <th className="gs-grp" colSpan={5}>Total</th>
            {campaigns.map((c) => <th key={c.link_id} className="gs-grp" colSpan={4}>[{c.campaign_code}]</th>)}
          </tr>
          <tr>
            <th className="gs-sub" style={{ minWidth: 96 }}>Клики за залив</th>
            <th className="gs-sub" style={{ minWidth: 92 }}>Фаны за залив</th>
            <th className="gs-sub">Конверт</th>
            <th className="gs-sub">Сумма</th>
            <th className="gs-sub" style={{ minWidth: 70 }}>Status</th>
            {campaigns.map((c) => (
              <Fragment key={c.link_id}>
                <th className="gs-sub">Клики</th>
                <th className="gs-sub">Фаны</th>
                <th className="gs-sub">CR</th>
                <th className="gs-sub">Сумма</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td className="gs-freeze gs-date">{dmy(r.date)}</td>
              <td className="gs-num">{intFmt(r.total.clicks)}</td>
              <td className="gs-num gs-b">{intFmt(r.total.subs)}</td>
              <td className="gs-num">{pct(r.total.cr)}</td>
              <td className="gs-num">{money(r.total.payout)}</td>
              <td className="gs-num" />
              {campaigns.map((c) => {
                const cell = r.cells[String(c.link_id)];
                return (
                  <Fragment key={c.link_id}>
                    <td className="gs-num">{intFmt(cell?.clicks ?? null)}</td>
                    <td className="gs-num gs-b">{cell?.subs ? cell.subs : ""}</td>
                    <td className="gs-num">{pct(cell?.cr ?? null)}</td>
                    <td className="gs-num">{cell?.payout ? money(cell.payout) : ""}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="gs-total-row">
            <td className="gs-freeze gs-date">Total</td>
            <td className="gs-num gs-b">{intFmt(foot.gClicks)}</td>
            <td className="gs-num gs-b">{intFmt(foot.gFans)}</td>
            <td className="gs-num">{foot.gClicks ? pct(foot.gFans / foot.gClicks) : "—"}</td>
            <td className="gs-num gs-b">{money(foot.gPay)}</td>
            <td className="gs-num" />
            {campaigns.map((c) => {
              const a = foot.per.get(c.link_id)!;
              return (
                <Fragment key={c.link_id}>
                  <td className="gs-num gs-b">{a.clicks ? intFmt(a.clicks) : ""}</td>
                  <td className="gs-num gs-b">{a.fans ? a.fans : ""}</td>
                  <td className="gs-num">{a.clicks ? pct(a.fans / a.clicks) : "—"}</td>
                  <td className="gs-num">{a.payout ? money(a.payout) : ""}</td>
                </Fragment>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/* ═══════════ RAW DATA ═══════════ */
function RawTable({ campaigns, rows }: { campaigns: DailyReport["campaigns"]; rows: DailyReport["rows"] }) {
  return (
    <div className="gs-scroll">
      <table className="gs-table">
        <thead>
          <tr>
            <th className="gs-freeze" rowSpan={2}>ДАТА</th>
            {campaigns.map((c) => <th key={c.link_id} className="gs-grp" colSpan={2}>[{c.campaign_code}]</th>)}
          </tr>
          <tr>
            {campaigns.map((c) => (
              <Fragment key={c.link_id}>
                <th className="gs-sub">КЛИКИ ВСЕ</th>
                <th className="gs-sub">ФАНЫ ВСЕ</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td className="gs-freeze gs-date">{dmy(r.date)}</td>
              {campaigns.map((c) => {
                const cell = r.cells[String(c.link_id)];
                return (
                  <Fragment key={c.link_id}>
                    <td className="gs-num">{intFmt(cell?.clicks ?? null)}</td>
                    <td className="gs-num">{cell?.subs ? cell.subs : (cell ? 0 : "")}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
