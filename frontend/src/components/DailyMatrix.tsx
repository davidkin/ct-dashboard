import { Fragment, useMemo, useState } from "react";
import { DailyReport } from "../api";

/* Дневная матрица трафика (день × кампания) в дизайн-системе профиля (an-/dm-),
   тема-адаптивная, без Google-Sheets грида. Колонки Дата + Total зафиксированы
   слева (sticky) — остаются видимыми при горизонтальном скролле по кампаниям.
   Total: агрегаты по дню + разбивка по кампаниям. Raw: только клики/фаны. */

const intFmt = (n: number | null): string => (n == null ? "" : n.toLocaleString("en-US"));
const money = (n: number | null): string => (n == null ? "" : `$${n.toFixed(2)}`);
const pct = (n: number | null): string => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
const dmy = (d: string): string =>
  new Date(`${d}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });

type Campaigns = DailyReport["campaigns"];
type Rows = DailyReport["rows"];

/* Зафиксированный слева блок: Дата + 4 колонки Total. Ширины фиксированы,
   left-офсеты кумулятивны — так sticky-колонки не разъезжаются. */
const DATE_W = 58;
const TOTAL_COLS = [
  { key: "clicks", label: "Клики", w: 72 },
  { key: "fans", label: "Фаны", w: 64 },
  { key: "cr", label: "Конверт", w: 70 },
  { key: "pay", label: "Сумма", w: 84 },
] as const;
const totalLeft = (i: number) => DATE_W + TOTAL_COLS.slice(0, i).reduce((s, c) => s + c.w, 0);
const LAST_TOTAL = TOTAL_COLS.length - 1;

export default function DailyMatrix({ campaigns, rows }: { campaigns: Campaigns; rows: Rows }) {
  const [tab, setTab] = useState<"total" | "raw">("total");

  /* Notes & Conditions: СPF по тирам + Revshare (из кампаний партнёра) */
  const freeCpf = campaigns.find((c) => c.tier === "free")?.cpf ?? null;
  const paidCpf = campaigns.find((c) => c.tier === "paid")?.cpf ?? null;
  const revshare = campaigns.find((c) => c.revshare != null)?.revshare ?? null;

  return (
    <div className="an-card">
      <div className="an-card-head">
        <h3>
          Таблица трафика <span className="faint">· {rows.length} дней</span>
        </h3>
        <div className="dm-seg" role="group" aria-label="Вид таблицы">
          <button className={`dm-seg-btn${tab === "total" ? " active" : ""}`} onClick={() => setTab("total")}>
            Total
          </button>
          <button className={`dm-seg-btn${tab === "raw" ? " active" : ""}`} onClick={() => setTab("raw")}>
            Raw
          </button>
        </div>
      </div>

      {/* Notes & Conditions */}
      <div className="dm-notes">
        <span className="dm-notes-lbl">Notes &amp; Conditions</span>
        {freeCpf != null && (
          <span className="dm-note">
            СPF Free <b>{money(freeCpf)}</b>
          </span>
        )}
        {paidCpf != null && (
          <span className="dm-note">
            СPF Paid <b>{money(paidCpf)}</b>
          </span>
        )}
        <span className="dm-note">
          Revshare <b>{revshare != null ? pct(revshare) : "—"}</b>
        </span>
      </div>

      {!rows.length ? (
        <p className="muted" style={{ padding: "0 20px 20px" }}>
          Нет данных за период.
        </p>
      ) : tab === "total" ? (
        <TotalMatrix campaigns={campaigns} rows={rows} />
      ) : (
        <RawMatrix campaigns={campaigns} rows={rows} />
      )}
    </div>
  );
}

function TotalMatrix({ campaigns, rows }: { campaigns: Campaigns; rows: Rows }) {
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

  /* sticky-пропсы для i-й Total-колонки (последняя — с правой границей блока) */
  const frz = (i: number, extra = ""): { className: string; style: React.CSSProperties } => ({
    className: `num${extra ? " " + extra : ""} dm-frz${i === LAST_TOTAL ? " dm-frz-edge" : ""}`,
    style: { left: totalLeft(i), width: TOTAL_COLS[i].w, minWidth: TOTAL_COLS[i].w },
  });

  return (
    <div className="dm-scroll">
      <table className="dm-table">
        <thead>
          <tr>
            <th className="dm-frz dm-date-col" rowSpan={2} style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
              Дата
            </th>
            <th className="dm-frz dm-frz-edge dm-grp" colSpan={4} style={{ left: DATE_W }}>
              Total
            </th>
            {campaigns.map((c) => (
              <th key={c.link_id} className="dm-grp dm-grp-sep" colSpan={4}>
                [{c.campaign_code}]
              </th>
            ))}
          </tr>
          <tr>
            {TOTAL_COLS.map((col, i) => (
              <th key={col.key} {...frz(i)}>
                {col.label}
              </th>
            ))}
            {campaigns.map((c) => (
              <Fragment key={c.link_id}>
                <th className="num dm-grp-sep">Клики</th>
                <th className="num">Фаны</th>
                <th className="num">CR</th>
                <th className="num">Сумма</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td className="dm-frz dm-date-col dm-date" style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
                {dmy(r.date)}
              </td>
              <td {...frz(0)}>{intFmt(r.total.clicks)}</td>
              <td {...frz(1, "dm-b")}>{intFmt(r.total.subs)}</td>
              <td {...frz(2, "muted")}>{pct(r.total.cr)}</td>
              <td {...frz(3, "accent")}>{money(r.total.payout)}</td>
              {campaigns.map((c) => {
                const cell = r.cells[String(c.link_id)];
                return (
                  <Fragment key={c.link_id}>
                    <td className="num dm-grp-sep">{intFmt(cell?.clicks ?? null)}</td>
                    <td className="num">{cell?.subs ? cell.subs : ""}</td>
                    <td className="num muted">{pct(cell?.cr ?? null)}</td>
                    <td className="num">{cell?.payout ? money(cell.payout) : ""}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="dm-total-row">
            <td className="dm-frz dm-date-col dm-date" style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
              Total
            </td>
            <td {...frz(0, "dm-b")}>{intFmt(foot.gClicks)}</td>
            <td {...frz(1, "dm-b")}>{intFmt(foot.gFans)}</td>
            <td {...frz(2)}>{foot.gClicks ? pct(foot.gFans / foot.gClicks) : "—"}</td>
            <td {...frz(3, "accent")}>{money(foot.gPay)}</td>
            {campaigns.map((c) => {
              const a = foot.per.get(c.link_id)!;
              return (
                <Fragment key={c.link_id}>
                  <td className="num dm-b dm-grp-sep">{a.clicks ? intFmt(a.clicks) : ""}</td>
                  <td className="num dm-b">{a.fans ? a.fans : ""}</td>
                  <td className="num">{a.clicks ? pct(a.fans / a.clicks) : "—"}</td>
                  <td className="num">{a.payout ? money(a.payout) : ""}</td>
                </Fragment>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function RawMatrix({ campaigns, rows }: { campaigns: Campaigns; rows: Rows }) {
  return (
    <div className="dm-scroll">
      <table className="dm-table">
        <thead>
          <tr>
            <th className="dm-frz dm-frz-edge dm-date-col" rowSpan={2} style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
              Дата
            </th>
            {campaigns.map((c) => (
              <th key={c.link_id} className="dm-grp dm-grp-sep" colSpan={2}>
                [{c.campaign_code}]
              </th>
            ))}
          </tr>
          <tr>
            {campaigns.map((c) => (
              <Fragment key={c.link_id}>
                <th className="num dm-grp-sep">Клики</th>
                <th className="num">Фаны</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td className="dm-frz dm-frz-edge dm-date-col dm-date" style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
                {dmy(r.date)}
              </td>
              {campaigns.map((c) => {
                const cell = r.cells[String(c.link_id)];
                return (
                  <Fragment key={c.link_id}>
                    <td className="num dm-grp-sep">{intFmt(cell?.clicks ?? null)}</td>
                    <td className="num">{cell?.subs ? cell.subs : cell ? 0 : ""}</td>
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
