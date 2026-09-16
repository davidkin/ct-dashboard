import { FormEvent, useState } from "react";
import { login } from "../api";

/**
 * Одно окно на вход и на первую регистрацию сразу: если почта в вайт-листе
 * и аккаунта ещё нет — заводит его этим же паролем (слать письма нечем,
 * SMTP на сервере не настроен). Если аккаунт уже есть — обычный вход.
 */
export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">C</div>
        <h1 className="login-title">Couture Dashboard</h1>
        <p className="login-sub">Почта должна быть в списке доступа. Первый вход сам заводит аккаунт.</p>

        <label className="login-field">
          Почта
          <input
            className="input"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@couture.dev"
          />
        </label>
        <label className="login-field">
          Пароль
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="не короче 6 символов"
          />
        </label>

        {error && <p className="pm-err login-err">{error}</p>}

        <button type="submit" className="btn login-submit" disabled={busy || !email || password.length < 6}>
          {busy ? "Входим…" : "Войти"}
        </button>
      </form>
    </div>
  );
}
