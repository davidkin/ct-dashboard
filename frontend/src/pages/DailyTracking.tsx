import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, DailyCell, DailyReport } from "../api";
import { CreatorSwitcher } from "../components/CreatorSwitcher";
import { PeriodPicker } from "../components/PeriodPicker";
import { Hint } from "../components/Hint";
import { TableSkeleton } from "../components/Skeleton";

const intFmt = (n: number | null): string => (n == null ? "—" : n.toLocaleString("en-US"));
const moneyFmt = (n: number | null): string => (n == null ? "—" : `$${n.toFixed(2)}`);
const pctFmt = (n: number | null): string => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const dayLabel = (d: string): string =>
  new Date(`${d}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
const dayLabelFull = (d: string): string =>
  new Date(`${d}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

const deltaFmt = (n: number | null): string => (n == null ? "—" : n > 0 ? `+${n}` : `${n}`);
const deltaClass = (n: number | null): string => (n == null || n === 0 ? "" : n > 0 ? "delta-up" : "delta-down");

/** Четыре ячейки одной компании за день: Клики · Фаны · CR · Сумма. */
function CampCells({ cell }: { cell?: DailyCell }) {
  const clicks = cell?.clicks ?? null;
  const subs = cell?.subs ?? 0;
  const cr = cell?.cr ?? null;
  const payout = cell?.payout ?? 0;
  return (
    <>
      <td className={`num daily-bd ${clicks ? "" : "daily-zero"}`}>{intFmt(clicks)}</td>
      <td className={`num ${subs ? "strong" : "daily-zero"}`}>{subs}</td>
      <td className={`num ${cr != null ? "" : "daily-zero"}`}>{pctFmt(cr)}</td>
      <td className={`num ${payout ? "" : "daily-zero"}`}>{moneyFmt(payout)}</td>
    </>
  );
}

export default function DailyTracking() {
  const [params] = useSearchParams();
  const creator = params.get("creator") || undefined;
  const [report, setReport] = useState<DailyReport | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .dailyTracking({ creator, from: from || undefined, to: to || undefined, all: showAll })
      .then((r) => { setReport(r); setErr(false); })
      .catch((e) => { setMsg(`Ошибка загрузки: ${e}`); setErr(true); })
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [creator, from, to, showAll]);

  const doCapture = async () => {
    setCapturing(true);
    setMsg(null);
    try {
      const res = await api.dailyCapture();
      if (res.error) { setMsg(`Ошибка: ${res.error}`); setErr(true); }
      else if (res.data) {
        const d = res.data;
        setErr(false);
        setMsg(`Снимок за ${dayLabelFull(d.day)}: компаний ${d.links_captured}, OM sync — ${d.om_synced ? "да" : "нет"}` +
          (d.errors.length ? `; ошибки: ${d.errors.join("; ")}` : ""));
        load();
      }
    } catch (e) {
      setMsg(`Ошибка: ${e}`);
      setErr(true);
    } finally {
      setCapturing(false);
    }
  };

  /* Итоги за весь период (footer-строка): сумма по компаниям + grand total. */
  const footer = useMemo(() => {
    if (!report) return null;
    const perCamp = new Map<number, { clicks: number; clicksHas: boolean; subs: number; payout: number }>();
    for (const c of report.campaigns) perCamp.set(c.link_id, { clicks: 0, clicksHas: false, subs: 0, payout: 0 });
    let gClicks = 0, gClicksHas = false, gSubs = 0, gPayout = 0;
    for (const row of report.rows) {
      for (const c of report.campaigns) {
        const cell = row.cells[String(c.link_id)];
        if (!cell) continue;
        const agg = perCamp.get(c.link_id)!;
        if (cell.clicks != null) { agg.clicks += cell.clicks; agg.clicksHas = true; }
        agg.subs += cell.subs;
        agg.payout += cell.payout;
      }
      if (row.total.clicks != null) { gClicks += row.total.clicks; gClicksHas = true; }
      gSubs += row.total.subs;
      gPayout += row.total.payout;
    }
    return {
      perCamp,
      grand: { clicks: gClicksHas ? gClicks : null, subs: gSubs, payout: gPayout },
    };
  }, [report]);

  return (
    <section className="dashboard-section">
      <div className="section-header">
        <div>
          <h2>Дневной трекинг</h2>
          <p>
            Авто-аналог ручной таблицы: клики + фаны по каждой компании за день, тотал за день и дельта.
            Снимок счётчика кликов делается ночью в 23:55 по Киеву; фаны считаются по реальным датам подписки.
          </p>
        </div>
        <div className="section-actions">
          <button className="btn" onClick={doCapture} disabled={capturing}>
            {capturing ? "Снимаю…" : "Снять снимок сейчас"}
          </button>
        </div>
      </div>

      <CreatorSwitcher />

      {msg && (
        <div className="alert" style={{ color: err ? "var(--bad)" : "var(--good)" }}>
          {msg}
        </div>
      )}

      <PeriodPicker
        from={from}
        to={to}
        onChange={(f, t) => { setFrom(f); setTo(t); }}
        label="Период"
        labelHint="Дни считаются по таймзоне Europe/Kyiv. По умолчанию — последние 30 дней."
        rightHint={report ? `${report.campaigns.length} компаний · ${report.rows.length} дней` : undefined}
      />

      <div className="toolbar" style={{ marginTop: 8 }}>
        <label className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Показывать компании без активности
        </label>
        {report?.clicks_available_from && (
          <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
            Дневные клики доступны с {dayLabelFull(report.clicks_available_from)}
            <Hint text="Раньше этой даты ночной снимок счётчика кликов не делался — клики задним числом восстановить нельзя. Фаны есть за всю историю (реальные даты подписки)." />
          </span>
        )}
      </div>

      {!report || loading ? (
        <TableSkeleton rows={8} cols={10} />
      ) : report.campaigns.length === 0 ? (
        <div className="empty" style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>
          Нет активности за выбранный период.
        </div>
      ) : (
        <div className="daily-scroll">
          <table className="data daily-table">
            <thead>
              <tr>
                <th className="daily-sticky" rowSpan={2}>Дата</th>
                <th className="num daily-total-grp daily-bd" colSpan={5}>Total за день</th>
                {report.campaigns.map((c) => (
                  <th key={c.link_id} className="num daily-camp-grp daily-bd" colSpan={4}>
                    {c.campaign_code}
                    <span className="daily-cpf">
                      CPF ${c.cpf.toFixed(2)}
                      {!creator && <> · {c.creator.replace("Nekoletta ", "")}</>}
                    </span>
                  </th>
                ))}
              </tr>
              <tr>
                <th className="num daily-bd">Клики</th>
                <th className="num">Фаны</th>
                <th className="num">CR</th>
                <th className="num">Сумма</th>
                <th className="num">Δ<Hint text="Изменение дневного объёма фанов к предыдущему дню." /></th>
                {report.campaigns.map((c) => (
                  <Fragment key={c.link_id}>
                    <th className="num daily-bd">Клики</th>
                    <th className="num">Фаны</th>
                    <th className="num">CR</th>
                    <th className="num">Сумма</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.date}>
                  <td className="daily-sticky">{dayLabel(row.date)}</td>
                  <td className="num daily-total-cell daily-bd">{intFmt(row.total.clicks)}</td>
                  <td className="num daily-total-cell strong">{intFmt(row.total.subs)}</td>
                  <td className="num daily-total-cell">{pctFmt(row.total.cr)}</td>
                  <td className="num daily-total-cell">{moneyFmt(row.total.payout)}</td>
                  <td className={`num daily-total-cell ${deltaClass(row.total.subs_delta)}`}>
                    {deltaFmt(row.total.subs_delta)}
                  </td>
                  {report.campaigns.map((c) => (
                    <CampCells key={c.link_id} cell={row.cells[String(c.link_id)]} />
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="daily-foot">
                <td className="daily-sticky">Σ период</td>
                <td className="num daily-bd">{intFmt(footer?.grand.clicks ?? null)}</td>
                <td className="num strong">{intFmt(footer?.grand.subs ?? null)}</td>
                <td className="num">
                  {footer && footer.grand.clicks ? pctFmt(footer.grand.subs / footer.grand.clicks) : "—"}
                </td>
                <td className="num">{moneyFmt(footer?.grand.payout ?? null)}</td>
                <td className="num">—</td>
                {report.campaigns.map((c) => {
                  const agg = footer?.perCamp.get(c.link_id);
                  const clicks = agg?.clicksHas ? agg.clicks : null;
                  return (
                    <Fragment key={c.link_id}>
                      <td className="num daily-bd">{intFmt(clicks)}</td>
                      <td className="num strong">{intFmt(agg?.subs ?? null)}</td>
                      <td className="num">{clicks && agg ? pctFmt(agg.subs / clicks) : "—"}</td>
                      <td className="num">{moneyFmt(agg?.payout ?? null)}</td>
                    </Fragment>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
