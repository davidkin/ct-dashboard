import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useTheme } from "./hooks/useTheme";
import PartnerManage from "./pages/PartnerManage";

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [showAdd, setShowAdd] = useState(false);

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
            <NavLink to="/traffic" className={({ isActive }) => `app-nav-link${isActive ? " active" : ""}`}>
              Трафик
            </NavLink>
          </nav>
        </div>
        <div className="app-header-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Переключить на светлую" : "Переключить на тёмную"}
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
          <div className="app-user">
            <span className="app-user-txt">
              <span className="app-user-name">CT Manager</span>
              <span className="app-user-role">admin</span>
            </span>
            <span className="app-user-ava">CT</span>
          </div>
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
