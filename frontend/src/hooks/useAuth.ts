import { useEffect, useState } from "react";
import { fetchSession, getSession, onSessionChange, SessionUser } from "../api";

/** Текущая сессия + флаг первой загрузки (пока не знаем, залогинен ли браузер). */
export function useAuth(): { user: SessionUser | null; loading: boolean } {
  const [user, setUser] = useState<SessionUser | null>(getSession());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const off = onSessionChange(setUser);
    fetchSession().finally(() => setLoading(false));
    return off;
  }, []);

  return { user, loading };
}
