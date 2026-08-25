import { useEffect, useState } from "react";
import { fetchIntegrity, isExportConfigured, type IntegrityReport } from "../api";

/**
 * Самопроверка данных. Ручных таблиц для сверки больше нет, поэтому дыры
 * должен показывать сам дашборд: пропущенный день съёмки, разошедшийся с OM
 * счётчик и кампании, которые есть в OM, но не заведены у нас.
 *
 * Когда всё чисто — свёрнутая зелёная строка, чтобы не мешала.
 */
export function IntegrityPanel() {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = (refresh = false) => {
    if (!isExportConfigured()) return;
    setBusy(true);
    fetchIntegrity(refresh)
      .then((r) => { setReport(r); setError(null); if (r.status !== "ok") setOpen(true); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (error) return <div className="integrity integrity-fail">Самопроверка недоступна: {error}</div>;
  if (!report) return null;

  const campaigns = report.untracked.filter((l) => l.is_campaign);
  const withTraffic = campaigns.filter((l) => l.clicks > 0);
  const own = report.untracked.filter((l) => !l.is_campaign);

  const title =
    report.status === "ok"
      ? "Данные сходятся с OnlyMonster"
      : report.status === "warn"
        ? `Есть кампании в OM без учёта: ${report.untracked_with_traffic}`
        : "Найдены расхождения";

  return (
    <div className={`integrity integrity-${report.status}`}>
      <div className="integrity-head">
        <button type="button" className="integrity-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} {title}
        </button>
        <span className="integrity-meta">
          проверено {new Date(report.checked_at).toLocaleString("ru-RU")}
        </span>
        <button type="button" className="integrity-refresh" onClick={() => load(true)} disabled={busy}>
          {busy ? "проверяю…" : "проверить сейчас"}
        </button>
      </div>

      {open && (
        <div className="integrity-body">
          {report.gaps.length > 0 && (
            <div className="integrity-block">
              <b>Дни без снимка ({report.gaps.length})</b> — трафик за эти дни восстановить нельзя:
              <div>{report.gaps.join(", ")}</div>
            </div>
          )}

          {report.drift.length > 0 && (
            <div className="integrity-block">
              <b>Счётчик разошёлся с OM ({report.drift.length})</b> — похоже на пропущенную съёмку:
              <table className="integrity-table">
                <thead>
                  <tr><th>кампания</th><th>у нас</th><th>в OM</th><th>разница</th><th>снимок</th></tr>
                </thead>
                <tbody>
                  {report.drift.slice(0, 20).map((d) => (
                    <tr key={d.link_id}>
                      <td>{d.campaign_code}<span className="integrity-dim"> {d.partner ?? ""}</span></td>
                      <td>{d.our_cumulative.toLocaleString("ru-RU")}</td>
                      <td>{d.om_cumulative.toLocaleString("ru-RU")}</td>
                      <td className="integrity-bad">+{d.diff.toLocaleString("ru-RU")}</td>
                      <td>{d.last_snapshot_day ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {campaigns.length > 0 && (
            <div className="integrity-block">
              <b>Кампании в OM, которых нет в базе ({campaigns.length}, с трафиком {withTraffic.length})</b>
              {" "}— их трафик проходит мимо дашборда:
              <table className="integrity-table">
                <thead>
                  <tr><th>кампания</th><th>модель</th><th>клики</th><th>фаны</th></tr>
                </thead>
                <tbody>
                  {campaigns.slice(0, 30).map((l) => (
                    <tr key={l.om_id}>
                      <td>{l.name}</td>
                      <td>{l.creator}</td>
                      <td className={l.clicks > 0 ? "integrity-bad" : undefined}>{l.clicks.toLocaleString("ru-RU")}</td>
                      <td>{l.fans.toLocaleString("ru-RU")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {own.length > 0 && (
            <div className="integrity-block integrity-dim">
              Ещё {own.length} ссылок модели (twitter, reddit и т.п.) — не партнёрские, не ведём.
            </div>
          )}

          {report.errors.length > 0 && (
            <div className="integrity-block integrity-bad">Ошибки проверки: {report.errors.join("; ")}</div>
          )}

          {report.status === "ok" && (
            <div className="integrity-block">
              Дыр нет: снимки за последние {report.days_checked} дней на месте, счётчики сходятся с OM.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
