import { useModel } from "../hooks/useModel";

/**
 * Переключатель моделей в шапке: «Все» + по кнопке на модель.
 * Пока модель одна — не показываем, переключать нечего.
 */
export function ModelSwitch() {
  const { model, setModel, models } = useModel();
  if (models.length < 2) return null;

  return (
    <div className="model-switch" role="group" aria-label="Модель">
      <button
        type="button"
        className={`model-switch-btn${model === "" ? " active" : ""}`}
        onClick={() => setModel("")}
      >
        Все
      </button>
      {models.map((m) => (
        <button
          key={m.group}
          type="button"
          className={`model-switch-btn${model === m.group ? " active" : ""}`}
          onClick={() => setModel(m.group)}
          title={`${m.links} кампаний`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
