import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { api } from "./api";
import { Hint } from "./components/Hint";
import { useTheme } from "./hooks/useTheme";

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [ofConfigured, setOfConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    api.health().then((h) => setOfConfigured(h.of_api_configured));
  }, []);

  return (
    <>
      <header className="app-header">
        <Link to="/" style={{ color: "inherit", textDecoration: "none" }}>
          <h1>
            <span className="logo-mark">C</span>
            Couture Dashboard
          </h1>
        </Link>
        <div className="app-header-actions">
          <div className="status">
            {ofConfigured === null && <span className="muted">…</span>}
            {ofConfigured === false && (
              <>
                <span className="status-dot bad" />
                <span className="muted">
                  OnlyFansAPI: не подключён
                  <Hint text="Без API-ключа значения Clicks / Subs / Revenue не подтягиваются. Заполни ONLYFANSAPI_KEY в .env." />
                </span>
              </>
            )}
            {ofConfigured === true && (
              <>
                <span className="status-dot good" />
                <span className="muted">OnlyFansAPI: онлайн</span>
              </>
            )}
          </div>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Переключить на светлую" : "Переключить на тёмную"}
          >
            {theme === "dark" ? "☀" : "🌙"}
          </button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </>
  );
}
