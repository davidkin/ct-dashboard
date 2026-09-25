import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BroadcastFan,
  BroadcastStatus,
  fetchBroadcastFans,
  fetchBroadcastStatus,
  getSession,
  startBroadcast,
} from "../api";

const CREATORS = ["Lily Free", "Lily Vip"];

/** Массовая рассылка одинакового сообщения фанам через OM. Только для админа. */
export default function Broadcast() {
  const navigate = useNavigate();
  const [creator, setCreator] = useState(CREATORS[0]);
  const [fans, setFans] = useState<BroadcastFan[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [job, setJob] = useState<BroadcastStatus | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (getSession()?.role !== "admin") {
      navigate("/", { replace: true });
      return;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
    return () => stopPoll();
  }, [creator]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const res = await fetchBroadcastFans(creator);
      setFans(res.fans);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function toggleAll() {
    setSelected((s) => (s.size === fans.length ? new Set() : new Set(fans.map((f) => f.fan_id))));
  }

  function stopPoll() {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function send() {
    if (selected.size === 0) {
      setError("Выбери хотя бы одного фана");
      return;
    }
    if (!text.trim()) {
      setError("Пустой текст сообщения");
      return;
    }
    if (
      !confirm(
        `Отправить одинаковое сообщение ${selected.size} фанам (${creator})?\n\nТекст:\n${text}\n\nЭто нельзя отменить.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await startBroadcast(creator, [...selected], text.trim());
      setJob({ job_id: res.job_id, creator, total: res.total, sent: 0, failed: 0, done: false, results: [] });
      pollRef.current = window.setInterval(async () => {
        try {
          const st = await fetchBroadcastStatus(res.job_id);
          setJob(st);
          if (st.done) stopPoll();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          stopPoll();
        }
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const money = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div className="an fadeUp">
      <div className="an-card">
        <div className="an-card-head">
          <h3>Рассылка сообщений</h3>
          <select className="input" value={creator} onChange={(e) => setCreator(e.target.value)} disabled={!!job && !job.done}>
            {CREATORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="pm-err" style={{ padding: "0 20px" }}>{error}</p>}

        {job && (
          <div style={{ padding: "0 20px 16px" }}>
            <p>
              {job.done ? "Готово" : "Отправляю…"} — отправлено {job.sent}, ошибок {job.failed}, всего {job.total}
              {!job.done && " (~1 сообщение/сек, не закрывай страницу)"}
            </p>
            {job.done && job.failed > 0 && (
              <p className="muted">
                Ошибки: {job.results.filter((r) => !r.ok).map((r) => `${r.fan_id} (${r.error})`).join(", ")}
              </p>
            )}
          </div>
        )}

        <div style={{ padding: "0 20px 16px" }}>
          <textarea
            className="input"
            style={{ width: "100%", minHeight: 80 }}
            placeholder="Текст сообщения — уйдёт одинаковым всем выбранным фанам"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!!job && !job.done}
          />
        </div>

        <div style={{ padding: "0 20px 16px", display: "flex", gap: 12, alignItems: "center" }}>
          <button type="button" className="btn" onClick={send} disabled={loading || (!!job && !job.done)}>
            Отправить рассылку ({selected.size})
          </button>
          <span className="muted">Всего фанов: {fans.length}</span>
        </div>

        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={selected.size === fans.length && fans.length > 0} onChange={toggleAll} />
                </th>
                <th>Fan ID</th>
                <th>Подписан</th>
                <th className="num">Цена</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={4} className="muted">
                    Загружаю…
                  </td>
                </tr>
              )}
              {!loading &&
                fans.map((f) => (
                  <tr key={f.fan_id}>
                    <td>
                      <input type="checkbox" checked={selected.has(f.fan_id)} onChange={() => toggle(f.fan_id)} />
                    </td>
                    <td>{f.fan_id}</td>
                    <td className="muted">{f.subscribed_at?.slice(0, 10) ?? "—"}</td>
                    <td className="num">{money(f.price_gross)}</td>
                  </tr>
                ))}
              {!loading && fans.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Нет фанов.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
