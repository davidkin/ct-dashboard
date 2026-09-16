import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useTheme } from "./hooks/useTheme";
import { useAuth } from "./hooks/useAuth";
import { logout } from "./api";
import { ModelSwitch } from "./components/ModelSwitch";
import PartnerManage from "./pages/PartnerManage";
import Login from "./pages/Login";

const ROLE_LABEL: Record<string, string> = { admin: "админ", affiliate_manager: "аффилейт-менеджер" };

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [showAdd, setShowAdd] = useState(false);
  const { user, loading } = useAuth();

  if (loading) return <div className="auth-loading" />;
  if (!user) return <Login />;

  const initials = user.email.slice(0, 2).toUpperCase();

  return (
    <>
      <header className="app-header">
        <div className="app-brand">
          <Link to="/" className="logo-mark" title="Общая аналитика">
            C
          </Link>
          <nav className="app-nav">
            <NavLink to="/" end className={({ isActive }) => `app-nav-link${isActive ? " active" : ""}`}>
              Аналитика
            </NavLink>
            <NavLink to="/glossary" className={({ isActive }) => `app-nav-link${isActive ? " active" : ""}`}>
              Глоссарий
            </NavLink>
            {user.role === "admin" && (
              <NavLink to="/admin/users" className={({ isActive }) => `app-nav-link${isActive ? " active" : ""}`}>
                Доступ
              </NavLink>
            )}
          </nav>
        </div>
        <div className="app-header-actions">
          <ModelSwitch />
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Переключить на светлую" : "Переключить на тёмную"}
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
          <button className="app-user" type="button" onClick={() => void logout()} title="Выйти">
            <span className="app-user-txt">
              <span className="app-user-name">{user.email}</span>
              <span className="app-user-role">{ROLE_LABEL[user.role] ?? user.role}</span>
            </span>
            <span className="app-user-ava">{initials}</span>
          </button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <button className="fab-add" type="button" onClick={() => setShowAdd(true)} title="Добавить партнёра">
        +
      </button>
      {showAdd && <PartnerManage onClose={() => setShowAdd(false)} />}
    </>
  );
}
