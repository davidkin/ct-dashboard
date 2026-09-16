import { useEffect, useState } from "react";
import { fetchReplyStats, ReplyStatsReport } from "../api";

/* Конверсия "фан ответил на приветку" — фоновый воркер на бэке понемногу
   обходит фанов через OM API и складывает результат в fan_reply_stats;
   здесь только читаем готовые цифры (может расти постепенно, см. pending). */

function fmtMin(sec: number | null): string {
  if (sec == null) return "—";
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)} мин`;
  return `${(min / 60).toFixed(1)} ч`;
}

export default function ReplyStatsWidget({ partnerId, collapsible = true }: { partnerId?: number; collapsible?: boolean }) {
  const [rep, setRep] = useState<ReplyStatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!collapsible);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchReplyStats({ partnerId })
      .then((r) => alive && setRep(r))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [partnerId]);

  const campaigns = (rep?.campaigns ?? []).filter((c) => c.total >= 3);

  const body = (
    <>
      {err && <div className="alert" style={{ margin: "0 20px 16px" }}>{err}</div>}
      {loading && !rep && <p className="muted" style={{ padding: "0 20px 20px" }}>Считаю…</p>}
      {rep && (
        <>
          <div className="rs-stats">
            <ReplyStat label="Ответили на приветку" value={rep.pct == null ? "—" : `${rep.pct.toFixed(1)}%`} accent />
            <ReplyStat label="Фанов в статистике" value={`${rep.valid}`} />
            <ReplyStat label="Медиана времени ответа" value={fmtMin(rep.median_reply_seconds)} />
            <ReplyStat label="Ещё считается" value={`${rep.pending}`} />
          </div>
          {rep.pending > 0 && (
            <p className="muted rs-note">
              Фоновый процесс постепенно досчитывает остальных ({rep.checked}/{rep.eligible}) — цифры будут расти.
            </p>
          )}
          {campaigns.length > 0 && (
            <div className="an-table-wrap">
              <table className="an-table rs-table">
                <thead>
                  <tr>
                    <th>Кампания</th>
                    <th className="num">Фанов</th>
                    <th className="num">Ответили</th>
                    <th className="num">%</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns
                    .slice()
                    .sort((a, b) => b.total - a.total)
                    .map((c) => (
                      <tr key={c.campaign_code}>
                        <td>{c.campaign_code}</td>
                        <td className="num">{c.total}</td>
                        <td className="num">{c.replied}</td>
                        <td className="num">{c.pct.toFixed(0)}%</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {!campaigns.length && !loading && (
            <p className="muted" style={{ padding: "0 20px 20px" }}>
              Пока недостаточно данных (нужно хотя бы 3 фана на кампанию).
            </p>
          )}
        </>
      )}
    </>
  );

  return (
    <div className="an-card">
      {collapsible ? (
        <div className={`pd-acc-head${open ? " open" : ""}`} onClick={() => setOpen((s) => !s)}>
          <h3>
            Конверсия в ответ <span className="faint">· % фанов, ответивших на приветку</span>
          </h3>
          <span className="pd-acc-caret">▶</span>
        </div>
      ) : (
        <div className="an-card-head">
          <h3>
            Конверсия в ответ <span className="faint">· % фанов, ответивших на приветку</span>
          </h3>
        </div>
      )}
      {(!collapsible || open) && body}
    </div>
  );
}

function ReplyStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rs-stat">
      <div className="an-kpi-label">{label}</div>
      <div className={`rs-stat-val${accent ? " accent" : ""}`}>{value}</div>
    </div>
  );
}
