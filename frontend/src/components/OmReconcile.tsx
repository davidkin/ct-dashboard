import { useEffect, useState } from "react";
import { fetchOmTotals, OmTotalsReport } from "../api";

/* Сверка тоталов: OM (истина по трафик-линкам, кумулятив за всё время) vs
   сумма из ручной таблицы. Показывает Δ по каждой кампании + итог, подсвечивает
   расхождения. partnerId — скоуп по партнёру (иначе по всем). */

const fmt = (n: number | null) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n)));
const delta = (om: number | null, sheet: number) => (om == null ? null : om - sheet);

export default function OmReconcile({ partnerId }: { partnerId?: number }) {
  const [rep, setRep] = useState<OmTotalsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setErr(null);
    fetchOmTotals({ partner: partnerId, refresh })
      .then(setRep)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  };
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchOmTotals({ partner: partnerId })
      .then((r) => alive && setRep(r))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [partnerId]);

  const rows = (rep?.links ?? [])
    .filter((l) => (l.om_clicks ?? 0) > 0 || l.sheet_clicks > 0 || (l.om_fans ?? 0) > 0 || l.sheet_fans > 0)
    .sort((a, b) => Math.abs((b.om_clicks ?? 0) - b.sheet_clicks) - Math.abs((a.om_clicks ?? 0) - a.sheet_clicks));

  const t = rep?.totals;
  const ageMin = rep?.cache_age_ms != null ? Math.floor(rep.cache_age_ms / 60000) : null;

  return (
    <div className="an-card">
      <div className="an-card-head">
        <h3>
          Сверка с OM <span className="faint">· тотал по трафик-линкам</span>
        </h3>
        <button className="btn ghost" onClick={() => load(true)} disabled={refreshing || loading}>
          {refreshing ? "обновляю…" : "⟳ Обновить OM"}
          {ageMin != null && !refreshing ? ` · ${ageMin}м` : ""}
        </button>
      </div>

      {err && <div className="alert" style={{ margin: "0 20px 16px" }}>{err}</div>}
      {loading && !rep && <p className="muted" style={{ padding: "0 20px 20px" }}>Загружаю OM…</p>}

      {rep && (
        <>
          {t && (
            <div className="omr-totals">
              <OmrStat label="OM клики" value={fmt(t.om_clicks)} accent />
              <OmrStat label="Таблица клики" value={fmt(t.sheet_clicks)} />
              <OmrStat label="Δ клики" value={fmt(t.om_clicks - t.sheet_clicks)} diff={t.om_clicks - t.sheet_clicks} />
              <OmrStat label="OM фаны" value={fmt(t.om_fans)} accent />
              <OmrStat label="Таблица фаны" value={fmt(t.sheet_fans)} />
              <OmrStat label="Δ фаны" value={fmt(t.om_fans - t.sheet_fans)} diff={t.om_fans - t.sheet_fans} />
            </div>
          )}
          <div className="an-table-wrap">
            <table className="an-table omr-table">
              <thead>
                <tr>
                  <th>Кампания</th>
                  <th className="num">OM клики</th>
                  <th className="num">Табл. клики</th>
                  <th className="num">Δ</th>
                  <th className="num">OM фаны</th>
                  <th className="num">Табл. фаны</th>
                  <th className="num">Δ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const dc = delta(l.om_clicks, l.sheet_clicks);
                  const df = delta(l.om_fans, l.sheet_fans);
                  return (
                    <tr key={l.link_id} className={dc && dc !== 0 ? "omr-mismatch" : ""}>
                      <td>{l.campaign_code}</td>
                      <td className="num accent">{fmt(l.om_clicks)}</td>
                      <td className="num">{fmt(l.sheet_clicks)}</td>
                      <td className={`num ${dc ? (dc > 0 ? "up" : "down") : "muted"}`}>{dc == null ? "—" : (dc > 0 ? "+" : "") + fmt(dc)}</td>
                      <td className="num accent">{fmt(l.om_fans)}</td>
                      <td className="num">{fmt(l.sheet_fans)}</td>
                      <td className={`num ${df ? (df > 0 ? "up" : "down") : "muted"}`}>{df == null ? "—" : (df > 0 ? "+" : "") + fmt(df)}</td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 24 }}>
                      Нет данных для сверки.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="muted omr-note">
            OM — источник истины (кумулятив за всё время). «Δ &gt; 0» = в таблице недозаполнено против OM.
          </p>
        </>
      )}
    </div>
  );
}

function OmrStat({ label, value, accent, diff }: { label: string; value: string; accent?: boolean; diff?: number }) {
  const cls = diff != null && diff !== 0 ? (diff > 0 ? "up" : "down") : accent ? "accent" : "";
  return (
    <div className="omr-stat">
      <div className="an-kpi-label">{label}</div>
      <div className={`omr-stat-val ${cls}`}>{value}</div>
    </div>
  );
}
