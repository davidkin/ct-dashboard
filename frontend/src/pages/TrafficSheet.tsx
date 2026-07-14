import { Fragment, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api, Creator, DailyReport, PartnerRow } from "../api";

/* ── форматтеры под вид Google Sheets ── */
const intFmt = (n: number | null): string => (n == null ? "" : n.toLocaleString("en-US"));
const money = (n: number | null): string => (n == null ? "" : `$${n.toFixed(2)}`);
const pct = (n: number | null): string => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
const dmy = (d: string): string =>
  new Date(`${d}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });

type SheetTab = "total" | "raw";

export default function TrafficSheet() {
  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [partnerId, setPartnerId] = useState<number | "">("");
  const [creator, setCreator] = useState<string>("Nekoletta Free");
  const [from, setFrom] = useState("2026-06-01");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<DailyReport | null>(null);
  const [tab, setTab] = useState<SheetTab>("total");
  const [loading, setLoading] = useState(false);

  /* партнёры + креаторы; дефолт — Adult Angels */
  useEffect(() => {
    api.partners().then((rows) => {
      const sorted = [...rows].sort((a, b) => a.display_name.localeCompare(b.display_name));
      setPartners(sorted);
      const aa = sorted.find((p) => p.display_name === "Adult Angels");
      if (aa) setPartnerId(aa.id);
    }).catch(console.error);
    api.creators().then(setCreators).catch(console.error);
  }, []);

  useEffect(() => {
    if (partnerId === "") return;
    setLoading(true);
    api.dailyTracking({ partner: partnerId, creator, from: from || undefined, to: to || undefined, all: true, source: "combined" })
      .then(setReport)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [partnerId, creator, from, to]);

  const campaigns = report?.campaigns ?? [];
  const rows = report?.rows ?? [];

  /* Накопительный Total за весь период (клики + фаны) — как в листе */
  const grand = useMemo(() => {
    let clicks = 0, fans = 0;
    for (const r of rows) { clicks += r.total.clicks ?? 0; fans += r.total.subs ?? 0; }
    return { clicks, fans };
  }, [rows]);

  /* Notes & Conditions — CPF / Revshare берём с кампаний партнёра */
  const cpf = campaigns[0]?.cpf ?? null;
  const revshare = campaigns.find((c) => c.revshare != null)?.revshare ?? 0;

  /* данные графика: Total клики + Total фаны по дням */
  const chartData = useMemo(
    () => rows.map((r) => ({ date: dmy(r.date), Клики: r.total.clicks, Фаны: r.total.subs })),
    [rows],
  );

  const creatorOptions = useMemo(() => {
    const names = new Set<string>(["Nekoletta Free", "Nekoletta Vip"]);
    creators.forEach((c) => names.add(c.name));
    return [...names];
  }, [creators]);

  return (
    <div className="gs-doc">
      {/* ── Панель управления ── */}
      <div className="gs-controls">
        <select className="gs-select" value={partnerId} onChange={(e) => setPartnerId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">— партнёр —</option>
          {partners.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </select>
        <select className="gs-select" value={creator} onChange={(e) => setCreator(e.target.value)}>
          {creatorOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="gs-ctl-label">с</span>
        <input className="gs-select" type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to || undefined} />
        <span className="gs-ctl-label">по</span>
        <input className="gs-select" type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} />
        {loading && <span className="gs-ctl-label">загрузка…</span>}
      </div>

      {/* ── Накопительный Total за весь период ── */}
      <div className="gs-grand">
        <div className="gs-grand-item">
          <span className="gs-grand-label">Клики за залив</span>
          <span className="gs-grand-val">{grand.clicks.toLocaleString("en-US")}</span>
        </div>
        <div className="gs-grand-sep" />
        <div className="gs-grand-item">
          <span className="gs-grand-label">Фаны за залив</span>
          <span className="gs-grand-val gs-grand-fans">{grand.fans.toLocaleString("en-US")}</span>
        </div>
      </div>

      {/* ── Шапка: заголовок таблицы + Notes & Conditions ── */}
      <div className="gs-top">
        <div className="gs-title-block">
          <div className="gs-sheet-title">
            [{creator.includes("Vip") ? "PAID" : "FREE"}_{partnerId ? partners.find((p) => p.id === partnerId)?.display_name : ""}]_traffic_tracking
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
