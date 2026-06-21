import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, Creator } from "../api";
import { Hint } from "./Hint";

/**
 * Scope-фильтр для таблицы партнёров: «Все» / «Free» / «Vip».
 * Размещается в Dashboard над фильтрами — это про объём данных, а не глобальная навигация.
 * Рядом с каждой моделью — иконка 👤 для перехода в её профиль.
 */
export function CreatorSwitcher() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [params, setParams] = useSearchParams();
  const current = params.get("creator") ?? "";

  useEffect(() => {
    api.creators().then(setCreators).catch(console.error);
  }, []);

  const select = (name: string) => {
    const next = new URLSearchParams(params);
    if (name === "") next.delete("creator");
    else next.set("creator", name);
    setParams(next, { replace: true });
  };

  return (
    <div className="scope-picker">
      <div className="scope-label">
        Объём данных:
        <Hint text="Фильтрует партнёров и их метрики по модели. «Все» = агрегаты по обоим аккаунтам." />
      </div>
      <div className="scope-tabs">
        <button
          className={`chip${current === "" ? " active" : ""}`}
          onClick={() => select("")}
        >
          Все модели
        </button>
        {creators.map((c) => (
          <div key={c.name} className="chip-group">
            <button
              className={`chip${current === c.name ? " active" : ""}`}
              onClick={() => select(c.name)}
              title={c.account_id ? `acct: ${c.account_id}` : "OF API не подключён"}
            >
              {c.name}
              {!c.configured && (
                <span className="badge-warn" title="Account ID не задан">⚠</span>
              )}
            </button>
            <Link
              to={`/creators/${c.slug}`}
              className="chip-profile"
              title={`Открыть профиль ${c.name}`}
            >
              👤
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
