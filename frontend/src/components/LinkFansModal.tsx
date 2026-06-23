import { useEffect, useMemo, useState } from "react";
import { api, Link, LinkSpender, LinkSubscriber } from "../api";

const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;

/** ISO string → "05.03.2026 14:23" (Moscow local time) */
const formatDateTime = (iso: string | null): string => {
  if (!iso) return "—";
  const d = parseDate(iso);
  if (!d) return "—";
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};

/** ISO string → "05.03" — short day for grouping */
const formatDay = (iso: string | null): string => {
  if (!iso) return "без даты";
  const d = parseDate(iso);
  if (!d) return "без даты";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
};

/** ISO string → "2026-03-05" — key for grouping */
const dayKey = (iso: string | null): string => {
  if (!iso) return "no-date";
  const d = parseDate(iso);
  if (!d) return "no-date";
  return d.toISOString().slice(0, 10);
};

function parseDate(iso: string): Date | null {
  if (!iso) return null;
  /* SQLite даёт `2026-03-05 14:23:00` без таймзоны → считаем UTC */
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T");
  const withZ = /[Z+]/.test(normalized) ? normalized : `${normalized}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Tab = "subscribers" | "spenders";
type View = "list" | "byDay";
const PAGE = 50;

/**
 * Drill-down per-link: показывает кого ссылка реально привела.
 * Два режима:
 *   - "Список" — плоский поименный список с датой когда мы впервые увидели фана
 *   - "По дням" — сгруппировано по day (как в Adult Angels Sheet)
 *
 * `first_seen_at` = момент первого появления в API → прокси-дата подписки
 * с точностью до интервала sync (5 часов).
 */
export function LinkFansModal({ link, onClose }: { link: Link; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("spenders");
  const [view, setView] = useState<View>("byDay");
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

  /** Сброс пагинации при изменении поиска / view */
  useEffect(() => { setPage(1); }, [search, view]);

  const rawList = tab === "spenders" ? (spenders ?? []) : (subs ?? []);
  const filtered = !search
    ? rawList
    : rawList.filter((r: LinkSpender | LinkSubscriber) => {
        const q = search.toLowerCase();
        return (r.username ?? "").toLowerCase().includes(q)
          || (r.of_fan_id ?? "").toLowerCase().includes(q);
      });
  const totalRaw = rawList.length;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  const visible = filtered.slice((page - 1) * PAGE, page * PAGE);

  /** Группировка по дням первого появления (по убыванию даты) */
  const groupedByDay = useMemo(() => {
    if (view !== "byDay") return null;
    const m = new Map<string, { key: string; label: string; items: (LinkSpender | LinkSubscriber)[] }>();
    for (const r of filtered) {
      const k = dayKey(r.first_seen_at);
      if (!m.has(k)) m.set(k, { key: k, label: formatDay(r.first_seen_at), items: [] });
      m.get(k)!.items.push(r);
    }
    return Array.from(m.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
  }, [filtered, view]);

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

          <span style={{ width: 12 }} />
          <div className="scope-tabs" title="Режим отображения">
            <button className={`chip${view === "byDay" ? " active" : ""}`} onClick={() => setView("byDay")}>📅 По дням</button>
            <button className={`chip${view === "list" ? " active" : ""}`} onClick={() => setView("list")}>📋 Список</button>
          </div>

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

          {!loading && totalRaw > 0 && (
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

          {/* ============= ВИД «ПО ДНЯМ» ============= */}
          {!loading && view === "byDay" && groupedByDay && (
            <>
              {groupedByDay.length === 0 && totalRaw === 0 && (
                <div className="empty">
                  По этой ссылке пока никто не {tab === "spenders" ? "заплатил" : "подписался"}
                </div>
              )}
              {groupedByDay.length === 0 && totalRaw > 0 && (
                <div className="empty">По запросу «{search}» ничего не найдено</div>
              )}
              {groupedByDay.map((g) => {
                const subRev = g.items.reduce(
                  (a, r) => a + (("revenue_total" in r) ? Number(r.revenue_total ?? 0) : 0),
                  0,
                );
                return (
                  <div key={g.key} className="day-group">
                    <div className="day-group-header">
                      <span className="day-label">{g.label}</span>
                      <span className="muted" style={{ fontSize: 12 }}>
                        +{g.items.length} {tab === "spenders" ? "платящих" : "подписок"}
                        {tab === "spenders" && subRev > 0 && <> · {money(subRev)}</>}
                      </span>
                    </div>
                    <div className="day-group-fans">
                      {g.items.map((r) => (
                        <a
                          key={r.id}
                          href={`https://onlyfans.com/${r.username ?? ""}`}
                          target="_blank" rel="noopener noreferrer"
                          className="fan-chip"
                          title={`OF ID: ${r.of_fan_id}${"revenue_total" in r && r.revenue_total ? ` · ${money(r.revenue_total)}` : ""}`}
                        >
                          @{r.username ?? r.of_fan_id}
                          {"revenue_total" in r && r.revenue_total > 0 && (
                            <span className="fan-spent">{money(r.revenue_total)}</span>
                          )}
                        </a>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* ============= ВИД «СПИСОК» ============= */}
          {tab === "spenders" && !loading && view === "list" && spenders && (
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Username</th>
                  <th>OnlyFans ID</th>
                  <th>Подписался</th>
                  <th className="num">Spent total</th>
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
                    <td className="muted" style={{ fontSize: 12 }}>{formatDateTime(s.first_seen_at)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(s.revenue_total)}</td>
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

          {tab === "subscribers" && !loading && view === "list" && subs && (
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Username</th>
                  <th>OnlyFans ID</th>
                  <th>Подписался</th>
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
                    <td className="muted" style={{ fontSize: 12 }}>{formatDateTime(s.first_seen_at)}</td>
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

          {view === "list" && total > PAGE && (
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
