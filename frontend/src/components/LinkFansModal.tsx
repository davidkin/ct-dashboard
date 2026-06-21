import { useEffect, useState } from "react";
import { api, Link, LinkSpender, LinkSubscriber } from "../api";

const money = (n: number | null): string =>
  n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;
const formatDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T") + (iso.includes("Z") || iso.includes("+") ? "" : "Z"));
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};

type Tab = "subscribers" | "spenders";
const PAGE = 50;

/**
 * Drill-down per-link: показывает кого ссылка реально привела.
 * Лениво подтягивает с backend (он кэширует 60 минут, иначе идёт в OF API).
 * Пагинация локальная: по 50 на страницу.
 */
export function LinkFansModal({ link, onClose }: { link: Link; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("spenders");
  const [subs, setSubs] = useState<LinkSubscriber[] | null>(null);
  const [spenders, setSpenders] = useState<LinkSpender[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const loadSubs = async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const r = await api.linkSubscribers(link.id, refresh);
      setSubs(r.data); setSource(r.source);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };
  const loadSpenders = async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const r = await api.linkSpenders(link.id, refresh);
      setSpenders(r.data); setSource(r.source);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (tab === "subscribers" && subs === null) loadSubs();
    if (tab === "spenders" && spenders === null) loadSpenders();
    setPage(1);
    setSearch("");
  }, [tab]);

  /** Сброс пагинации при изменении поиска */
  useEffect(() => { setPage(1); }, [search]);

  const rawList = tab === "spenders" ? (spenders ?? []) : (subs ?? []);
  const currentList = !search
    ? rawList
    : rawList.filter((r: LinkSpender | LinkSubscriber) => {
        const q = search.toLowerCase();
        return (r.username ?? "").toLowerCase().includes(q)
          || (r.of_fan_id ?? "").toLowerCase().includes(q);
      });
  const total = currentList.length;
  const totalRaw = rawList.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  const visible = currentList.slice((page - 1) * PAGE, page * PAGE);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>
              {link.creator} · {link.campaign_code}
            </h2>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              <a href={link.of_url} target="_blank" rel="noopener noreferrer">{link.of_url}</a>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} title="Закрыть">×</button>
        </div>

        <div className="modal-tabs">
          <button
            className={`chip${tab === "spenders" ? " active" : ""}`}
            onClick={() => setTab("spenders")}
          >
            💰 Spenders ({spenders?.length ?? link.spenders_count ?? "?"})
          </button>
          <button
            className={`chip${tab === "subscribers" ? " active" : ""}`}
            onClick={() => setTab("subscribers")}
          >
            👥 Subscribers ({subs?.length ?? link.subscribers_count ?? "?"})
          </button>
          <span style={{ flex: 1 }} />
          {source && <span className="muted" style={{ fontSize: 11 }}>источник: {source === "cache" ? "кэш (< 60 мин)" : "OF API"}</span>}
          <button
            className="btn ghost"
            onClick={() => tab === "subscribers" ? loadSubs(true) : loadSpenders(true)}
            disabled={loading}
            title="Обновить из OF API"
            style={{ padding: "4px 12px" }}
          >
            {loading ? "…" : "↻ Обновить"}
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="alert" style={{ color: "var(--bad)" }}>{error}</div>}
          {loading && <div className="loading">Загружаю…</div>}

          {!loading && rawList && totalRaw > 0 && (
            <div className="modal-search-row">
              <div className="input-with-icon" style={{ flex: 1, maxWidth: 320 }}>
                <span className="input-icon">🔎</span>
                <input
                  className="input"
                  placeholder="Поиск по username или OF ID…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {search && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {total} из {totalRaw}
                </span>
              )}
              {search && (
                <button className="btn-icon" onClick={() => setSearch("")} title="Сбросить поиск">×</button>
              )}
            </div>
          )}

          {tab === "spenders" && !loading && spenders && (
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Username</th>
                  <th>OnlyFans ID</th>
                  <th className="num">Spent total</th>
                  <th>Расчёт</th>
                </tr>
              </thead>
              <tbody>
                {(visible as LinkSpender[]).map((s, i) => (
                  <tr key={s.id}>
                    <td className="muted">{(page - 1) * PAGE + i + 1}</td>
                    <td>
                      <a href={`https://onlyfans.com/${s.username ?? ""}`} target="_blank" rel="noopener noreferrer">
                        @{s.username ?? "—"}
                      </a>
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>{s.of_fan_id}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(s.revenue_total)}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{formatDate(s.calculated_at)}</td>
                  </tr>
                ))}
                {total === 0 && totalRaw > 0 && (
                  <tr><td colSpan={5} className="empty">По запросу «{search}» ничего не найдено</td></tr>
                )}
                {totalRaw === 0 && (
                  <tr><td colSpan={5} className="empty">По этой ссылке пока никто не заплатил</td></tr>
                )}
              </tbody>
            </table>
          )}

          {tab === "subscribers" && !loading && subs && (
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Username</th>
                  <th>OnlyFans ID</th>
                  <th>Подписка истекает</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {(visible as LinkSubscriber[]).map((s, i) => (
                  <tr key={s.id}>
                    <td className="muted">{(page - 1) * PAGE + i + 1}</td>
                    <td>
                      <a href={`https://onlyfans.com/${s.username ?? ""}`} target="_blank" rel="noopener noreferrer">
                        @{s.username ?? "—"}
                      </a>
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>{s.of_fan_id}</td>
                    <td className="muted">{formatDate(s.subscribed_at)}</td>
                    <td>
                      <span className={`tag ${s.is_active ? "in" : ""}`}>
                        {s.is_active ? "активен" : "истёк"}
                      </span>
                    </td>
                  </tr>
                ))}
                {total === 0 && totalRaw > 0 && (
                  <tr><td colSpan={5} className="empty">По запросу «{search}» ничего не найдено</td></tr>
                )}
                {totalRaw === 0 && (
                  <tr><td colSpan={5} className="empty">По этой ссылке пока никто не подписался</td></tr>
                )}
              </tbody>
            </table>
          )}

          {total > PAGE && (
            <div className="pagination" style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, total)} из {total}
              </div>
              <div className="pagination-actions">
                <button className="btn ghost" onClick={() => setPage(page - 1)} disabled={page <= 1}>‹ Назад</button>
                <span className="muted" style={{ fontSize: 12, padding: "0 8px" }}>
                  стр. {page} / {totalPages}
                </span>
                <button className="btn ghost" onClick={() => setPage(page + 1)} disabled={page >= totalPages}>Вперёд ›</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
