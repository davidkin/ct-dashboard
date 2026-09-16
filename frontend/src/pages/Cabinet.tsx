import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { CabinetData, DailyReport, fetchCabinet } from "../api";
import { useTheme } from "../hooks/useTheme";
import DailyMatrix from "../components/DailyMatrix";
import DateRangePicker from "../components/DateRangePicker";
import { SortTh } from "./PartnerDetail";
import { aggregateCampaigns, campaignTotals, CampSort, DEFAULT_CAMP_SORT } from "../lib/campaignAgg";

const money = (n: number) => `$${n.toFixed(2)}`;
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (n: number | null) => (n == null ? "—" : (n * 100).toFixed(1) + "%");

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function totals(rep: DailyReport) {
  let clicks = 0, fans = 0, payout = 0;
  for (const r of rep.rows) {
    clicks += r.total.clicks ?? 0;
    fans += r.total.subs ?? 0;
    payout += r.total.payout ?? 0;
  }
  return { clicks, fans, payout, cr: clicks > 0 ? fans / clicks : null };
}

/**
 * Личный кабинет траффера. Открывается по секретной ссылке, без логина —
 * ровно как shared report в OnlyMonster. Только чтение: DailyMatrix сам
 * прячет редактирование CPF, потому что здесь нет сессии.
 */
export default function Cabinet() {
  const { token } = useParams<{ token: string }>();
  const [theme, toggleTheme] = useTheme();
  const [data, setData] = useState<CabinetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(daysAgoISO(29));
  const [to, setTo] = useState(todayISO());

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    fetchCabinet(token, from, to)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [token, from, to]);

  if (error) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="login-logo">C</div>
          <h1 className="login-title">Ссылка недоступна</h1>
          <p className="login-sub">{error}</p>
        </div>
      </div>
    );
  }

  const t = data ? totals(data.report) : null;

  const [campSort, setCampSort] = useState<CampSort>(DEFAULT_CAMP_SORT);
  const campaigns = useMemo(() => aggregateCampaigns(data?.report ?? null, campSort), [data, campSort]);
  const campTotals = useMemo(() => campaignTotals(campaigns), [campaigns]);
  /* Открыт по умолчанию: в кабинете это единственное место со списком ссылок,
     в отличие от карточки партнёра, где рядом есть ещё несколько блоков. */
  const [campOpen, setCampOpen] = useState(true);

  return (
    <div className="cabinet-shell">
      <header className="app-header">
        <div className="app-brand">
          <div className="logo-mark">C</div>
          <span className="cabinet-title">{data ? data.partner.display_name : "Личный кабинет"}</span>
          {data?.partner.telegram && <span className="an-partner-tg">{data.partner.telegram}</span>}
        </div>
        <div className="app-header-actions">
          <DateRangePicker from={from} to={to} onChange={(f, tt) => { setFrom(f); setTo(tt); }} />
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Переключить на светлую" : "Переключить на тёмную"}
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      <main className="app-main">
      <div className="an">
        {loading && !data && <p className="muted">Загружаю…</p>}
        {t && (
          <div className="an-kpis pd-kpis">
            <div className="an-kpi">
              <div className="an-kpi-label">Клики</div>
              <div className="an-kpi-val">{fmt(t.clicks)}</div>
              {data?.report.summary && (
                <div className="an-kpi-sub">
                  Free {fmt(data.report.summary.free.clicks)} · VIP {fmt(data.report.summary.paid.clicks)}
                </div>
              )}
            </div>
            <div className="an-kpi">
              <div className="an-kpi-label">Фаны</div>
              <div className="an-kpi-val">{fmt(t.fans)}</div>
              {data?.report.summary && (
                <div className="an-kpi-sub">
                  Free {fmt(data.report.summary.free.fans)} · VIP {fmt(data.report.summary.paid.fans)}
                </div>
              )}
            </div>
            <div className="an-kpi">
              <div className="an-kpi-label">Конверт</div>
              <div className="an-kpi-val">{t.cr != null ? `${(t.cr * 100).toFixed(1)}%` : "—"}</div>
            </div>
            <div className="an-kpi">
              <div className="an-kpi-label">Выплата</div>
              <div className="an-kpi-val accent">{money(t.payout)}</div>
            </div>
          </div>
        )}
        {data && (
          <DailyMatrix
            campaigns={data.report.campaigns}
            rows={data.report.rows}
            partnerId={data.partner.id}
          />
        )}

        {/* Полные ссылки по кампаниям + итог по каждой — тот же список, что видит
            админ на карточке партнёра, продублирован здесь снизу для траффера. */}
        {data && campaigns.length > 0 && (
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
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => (
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
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="dm-total-row">
                      <td>Total</td>
                      <td />
                      <td />
                      <td className="num">{fmt(campTotals.clicks)}</td>
                      <td className="num">{fmt(campTotals.fans)}</td>
                      <td className="num">{pct(campTotals.cr)}</td>
                      <td className="num accent">{money(campTotals.payout)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      </main>
    </div>
  );
}
