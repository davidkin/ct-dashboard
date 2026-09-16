import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CabinetData, DailyReport, fetchCabinet } from "../api";
import { useTheme } from "../hooks/useTheme";
import DailyMatrix from "../components/DailyMatrix";
import DateRangePicker from "../components/DateRangePicker";

const money = (n: number) => `$${n.toFixed(2)}`;
const fmt = (n: number) => n.toLocaleString("en-US");

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
        {loading && !data && <p className="muted">Загружаю…</p>}
        {t && (
          <div className="an-kpis pd-kpis">
            <div className="an-kpi">
              <div className="an-kpi-label">Клики</div>
              <div className="an-kpi-val">{fmt(t.clicks)}</div>
            </div>
            <div className="an-kpi">
              <div className="an-kpi-label">Фаны</div>
              <div className="an-kpi-val">{fmt(t.fans)}</div>
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
      </main>
    </div>
  );
}
