import { Link } from "react-router-dom";
import { PartnerRow, TrendsResponse } from "../api";
import { Hint } from "./Hint";

/**
 * Виджет «Топ-движение» — два столбца:
 *  - Топ-5 партнёров за всё время по revenue
 *  - Топ-5 «движение за период» (по trend-API, дельта revenue/subs vs прошлый период)
 *
 * Если истории snapshot-ов меньше чем нужно — показываем плашку
 * «нужно ≥N дней» вместо чисел дельты.
 */
export function TopMovers({ partners, trends }: { partners: PartnerRow[]; trends: TrendsResponse | null }) {
  const byRevenue = [...partners]
    .filter((p) => (p.revenue_total ?? 0) > 0 || (p.clicks_total ?? 0) > 0)
    .sort((a, b) =>
      (b.revenue_total ?? 0) - (a.revenue_total ?? 0)
      || (b.clicks_total ?? 0) - (a.clicks_total ?? 0)
    )
    .slice(0, 5);

  const movers = trends
    ? [...trends.data]
        .sort((a, b) => b.delta.clicks - a.delta.clicks)
        .slice(0, 5)
    : [];

  return (
    <div className="movers-grid">
      <div className="card movers-card">
        <h2 style={{ margin: 0, fontSize: 14 }}>
          🔥 Топ-5 по активности
          <Hint text="Партнёры с максимальной выручкой / кликами за всё время." />
        </h2>
        <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>За всё время</div>
        <div className="movers-list">
          {byRevenue.map((p, i) => (
            <Link
              key={p.id}
              to={`/partners/${p.id}`}
              className="row"
              style={{ color: "inherit", textDecoration: "none" }}
            >
              <span className="name">
                <span className="muted" style={{ marginRight: 8 }}>{i + 1}.</span>
                {p.display_name}
              </span>
              <span className="delta up">
                {p.revenue_total ? `$${p.revenue_total.toFixed(0)}` : "—"} ·
                {" "}{p.clicks_total?.toLocaleString("en-US") ?? 0} clicks
              </span>
            </Link>
          ))}
          {byRevenue.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>Пока никто не привёл трафика.</div>
          )}
        </div>
      </div>

      <div className="card movers-card">
        <h2 style={{ margin: 0, fontSize: 14 }}>
          📊 Движение за {trends?.meta.days ?? 7} дней
          <Hint text={`Сравнение текущего периода с прошлым (той же длины). Считается из snapshots — снимков которые делаются при каждом sync.`} />
        </h2>
        <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          ▲ рост · ▼ падение vs прошлый период
        </div>

        {!trends && <div className="muted" style={{ fontSize: 12 }}>Загружаю…</div>}

        {trends && !trends.meta.enough_history && (
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            ⏳ В БД накоплено только <b>{trends.meta.history_days}</b> дн. snapshot-ов.
            Чтобы виджет показывал содержательное «текущий vs прошлый период»,
            нужно ≥ <b>{trends.meta.days * 2}</b> дн. истории. Sync продолжается каждые 5 часов —
            динамика появится автоматически.
          </div>
        )}

        {trends && trends.meta.enough_history && movers.length === 0 && (
          <div className="muted" style={{ fontSize: 12 }}>Партнёров с активностью пока нет.</div>
        )}

        {trends && trends.meta.enough_history && movers.length > 0 && (
          <div className="movers-list">
            {movers.map((m, i) => {
              const dClicks = m.delta.clicks;
              const pct = m.delta_pct.clicks;
              const up = dClicks >= 0;
              return (
                <Link
                  key={m.id}
                  to={`/partners/${m.id}`}
                  className="row"
                  style={{ color: "inherit", textDecoration: "none" }}
                >
                  <span className="name">
                    <span className="muted" style={{ marginRight: 8 }}>{i + 1}.</span>
                    {m.display_name}
                  </span>
                  <span className={`delta ${up ? "up" : "down"}`}>
                    {up ? "▲" : "▼"} {Math.abs(dClicks).toLocaleString("en-US")} clicks
                    {pct !== null && <span className="muted" style={{ marginLeft: 6 }}>
                      ({(pct * 100).toFixed(0)}%)
                    </span>}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
