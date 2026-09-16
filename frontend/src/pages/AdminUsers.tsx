import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { addToWhitelist, fetchWhitelist, getSession, removeFromWhitelist, Role, WhitelistEntry } from "../api";

/** Вайт-лист почт: кому можно войти в дашборд и с какой ролью. Только для admin —
    и на бэке, и здесь: не-админ просто не видит этот пункт меню. */
export default function AdminUsers() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<WhitelistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("affiliate_manager");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (getSession()?.role !== "admin") {
      navigate("/", { replace: true });
      return;
    }
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchWhitelist());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await addToWhitelist(email.trim().toLowerCase(), role);
      setEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: string) {
    if (!confirm(`Убрать ${e} из списка доступа?`)) return;
    try {
      await removeFromWhitelist(e);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const roleLabel = (r: string) => (r === "admin" ? "Админ" : "Аффилейт-менеджер");

  return (
    <div className="an fadeUp">
      <div className="an-card">
        <div className="an-card-head">
          <h3>Список доступа</h3>
        </div>
        <form className="au-form" onSubmit={submit}>
          <input
            className="input"
            type="email"
            placeholder="почта"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="affiliate_manager">Аффилейт-менеджер</option>
            <option value="admin">Админ</option>
          </select>
          <button type="submit" className="btn" disabled={busy || !email}>
            Добавить
          </button>
        </form>
        {error && <p className="pm-err" style={{ padding: "0 20px" }}>{error}</p>}

        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th>Почта</th>
                <th>Роль</th>
                <th>Статус</th>
                <th>Добавил</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} className="muted">
                    Загружаю…
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((r) => (
                  <tr key={r.email}>
                    <td>{r.email}</td>
                    <td>{roleLabel(r.role)}</td>
                    <td className="muted">
                      {r.registered
                        ? r.user_active
                          ? "аккаунт создан"
                          : "аккаунт отключён"
                        : "ждёт первого входа"}
                    </td>
                    <td className="muted">{r.added_by ?? "—"}</td>
                    <td className="gl-actions">
                      <button type="button" className="gl-del" onClick={() => remove(r.email)} title="Убрать доступ">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    Список пуст.
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
