import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, DailyCampaign, DailyCell, DailyReport, DailyRow, PartnerRow } from "../api";
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

interface PartnerGroup {
  key: string;
  partnerId: number | null;
  name: string;
  campaigns: DailyCampaign[];
}

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

/** Дневной мини-грид одного партнёра: его компании-колонки + собственный Total за день. */
function PartnerSection({
  group,
  rows,
  creator,
  collapsed,
  onToggle,
}: {
  group: PartnerGroup;
  rows: DailyRow[];
  creator?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { dayRows, foot, summary } = useMemo(() => {
    const campaigns = group.campaigns;
    const dayRows = rows.map((row) => {
      let clicks = 0, clicksHas = false, subs = 0, payout = 0;
      for (const c of campaigns) {
        const cell = row.cells[String(c.link_id)];
        if (!cell) continue;
        if (cell.clicks != null) { clicks += cell.clicks; clicksHas = true; }
        subs += cell.subs;
        payout += cell.payout;
      }
      const totalClicks = clicksHas ? clicks : null;
      const cr = totalClicks != null && totalClicks > 0 ? subs / totalClicks : null;
      return { date: row.date, cells: row.cells, total: { clicks: totalClicks, subs, cr, payout } };
    });

    const perCamp = new Map<number, { clicks: number; clicksHas: boolean; subs: number; payout: number }>();
    for (const c of campaigns) perCamp.set(c.link_id, { clicks: 0, clicksHas: false, subs: 0, payout: 0 });
    let gC = 0, gCH = false, gS = 0, gP = 0;
    for (const r of dayRows) {
      for (const c of campaigns) {
        const cell = r.cells[String(c.link_id)];
        if (!cell) continue;
        const a = perCamp.get(c.link_id)!;
        if (cell.clicks != null) { a.clicks += cell.clicks; a.clicksHas = true; }
        a.subs += cell.subs;
        a.payout += cell.payout;
      }
      if (r.total.clicks != null) { gC += r.total.clicks; gCH = true; }
      gS += r.total.subs;
      gP += r.total.payout;
    }
    return { dayRows, foot: { perCamp, grand: { clicks: gCH ? gC : null, subs: gS, payout: gP } }, summary: { clicks: gCH ? gC : null, subs: gS, payout: gP } };
  }, [group, rows]);

  const summaryText =
    `${group.campaigns.length} комп · ${summary.subs} фанов · ${moneyFmt(summary.payout)}` +
    (summary.clicks != null ? ` · ${intFmt(summary.clicks)} кликов` : "");

  return (
    <div className={`daily-partner-section${collapsed ? " collapsed" : ""}`}>
      <button className="daily-partner-head" onClick={onToggle}>
        <span className="daily-collapse">{collapsed ? "▸" : "▾"}</span>
        <span className="daily-partner-name">{group.name}</span>
        <span className="daily-partner-summary">{summaryText}</span>
      </button>

      {!collapsed && (
        <div className="daily-scroll">
          <table className="data daily-table">
            <thead>
              <tr>
                <th className="daily-sticky" rowSpan={2}>Дата</th>
                <th className="num daily-total-grp daily-bd" colSpan={4}>Total за день</th>
                {group.campaigns.map((c) => (
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
                {group.campaigns.map((c) => (
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
              {dayRows.map((row) => (
                <tr key={row.date}>
                  <td className="daily-sticky">{dayLabel(row.date)}</td>
                  <td className="num daily-total-cell daily-bd">{intFmt(row.total.clicks)}</td>
                  <td className="num daily-total-cell strong">{intFmt(row.total.subs)}</td>
                  <td className="num daily-total-cell">{pctFmt(row.total.cr)}</td>
                  <td className="num daily-total-cell">{moneyFmt(row.total.payout)}</td>
                  {group.campaigns.map((c) => (
                    <CampCells key={c.link_id} cell={row.cells[String(c.link_id)]} />
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="daily-foot">
                <td className="daily-sticky">Σ период</td>
                <td className="num daily-bd">{intFmt(foot.grand.clicks)}</td>
                <td className="num strong">{intFmt(foot.grand.subs)}</td>
                <td className="num">{foot.grand.clicks ? pctFmt(foot.grand.subs / foot.grand.clicks) : "—"}</td>
                <td className="num">{moneyFmt(foot.grand.payout)}</td>
                {group.campaigns.map((c) => {
                  const agg = foot.perCamp.get(c.link_id)!;
                  const clicks = agg.clicksHas ? agg.clicks : null;
                  return (
                    <Fragment key={c.link_id}>
                      <td className="num daily-bd">{intFmt(clicks)}</td>
                      <td className="num strong">{intFmt(agg.subs)}</td>
                      <td className="num">{clicks ? pctFmt(agg.subs / clicks) : "—"}</td>
                      <td className="num">{moneyFmt(agg.payout)}</td>
                    </Fragment>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

export default function DailyTracking() {
  const [params] = useSearchParams();
  const creator = params.get("creator") || undefined;
  const [report, setReport] = useState<DailyReport | null>(null);
  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [partnerId, setPartnerId] = useState<number | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.partners().then((rows) =>
      setPartners([...rows].sort((a, b) => a.display_name.localeCompare(b.display_name))),
    ).catch(console.error);
  }, []);

  const load = () => {
    setLoading(true);
    api
      .dailyTracking({ creator, from: from || undefined, to: to || undefined, all: showAll, partner: partnerId || undefined })
      .then((r) => { setReport(r); setErr(false); })
      .catch((e) => { setMsg(`Ошибка загрузки: ${e}`); setErr(true); })
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [creator, from, to, showAll, partnerId]);

  const doImport = async () => {
    setImporting(true);
    setMsg(null);
    try {
      const res = await api.dailyImportSheet();
      if (res.error) { setMsg(`Ошибка импорта: ${res.error}`); setErr(true); }
      else {
        const arr = (res.data as Array<{ tab: string; rows_imported: number; campaigns_matched: string[]; min_day: string | null; max_day: string | null }>) ?? [];
        setErr(false);
        setMsg("Импорт из таблицы: " + arr.map((r) => `${r.tab} — ${r.rows_imported} строк (${r.campaigns_matched.length} комп, ${r.min_day}…${r.max_day})`).join(" · "));
        load();
      }
    } catch (e) {
      setMsg(`Ошибка импорта: ${e}`);
      setErr(true);
    } finally {
      setImporting(false);
    }
  };

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

  /* Группы партнёров (кампании из бэка уже отсортированы по партнёру). */
  const groups = useMemo<PartnerGroup[]>(() => {
    if (!report) return [];
    const map = new Map<string, PartnerGroup>();
    const order: string[] = [];
    for (const c of report.campaigns) {
      const key = String(c.partner_id ?? "none");
      if (!map.has(key)) {
        map.set(key, { key, partnerId: c.partner_id, name: c.partner_name ?? "— без партнёра", campaigns: [] });
        order.push(key);
      }
      map.get(key)!.campaigns.push(c);
    }
    return order.map((k) => map.get(k)!);
  }, [report]);

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const allCollapsed = report ? groups.length > 0 && groups.every((g) => collapsed.has(g.key)) : false;
  const toggleAll = () => {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(groups.map((g) => g.key)));
  };

  return (
    <section className="dashboard-section">
      <div className="section-header">
        <div>
          <h2>Дневной трекинг</h2>
          <p>
            Авто-аналог ручной таблицы: по каждому партнёру — его компании, клики + фаны за день, Total за день
            и дельта со вчера. Снимок счётчика кликов — ночью в 23:55 по Киеву; фаны — по реальным датам подписки.
          </p>
        </div>
        <div className="section-actions">
          {groups.length > 0 && (
            <button className="btn ghost" onClick={toggleAll}>
              {allCollapsed ? "Развернуть все" : "Свернуть все"}
            </button>
          )}
          <button className="btn ghost" onClick={doImport} disabled={importing} title="Точный снимок ручной таблицы Traffic Tracking (клики + фаны)">
            {importing ? "Импорт…" : "Импорт из таблицы"}
          </button>
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
        rightHint={report ? `${groups.length} партнёров · ${report.campaigns.length} компаний · ${report.rows.length} дней` : undefined}
      />

      <div className="toolbar" style={{ marginTop: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <select
            className="input"
            value={partnerId}
            onChange={(e) => setPartnerId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">Все партнёры</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
          </select>
          <Hint text="Оставить только одного партнёра — его секцию (лист как в ручной таблице)." />
        </span>
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
      ) : groups.length === 0 ? (
        <div className="empty" style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>
          Нет активности за выбранный период.
        </div>
      ) : (
        <div className="daily-sections">
          {groups.map((g) => (
            <PartnerSection
              key={g.key}
              group={g}
              rows={report.rows}
              creator={creator}
              collapsed={collapsed.has(g.key)}
              onToggle={() => toggle(g.key)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
