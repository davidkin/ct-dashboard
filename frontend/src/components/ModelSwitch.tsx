import { useModel } from "../hooks/useModel";

/**
 * Переключатель моделей в шапке: «Все» + по кнопке на модель.
 * Когда модель одна — переключать нечего, но её имя всё равно показываем:
 * должно быть видно, по какой модели смотришь цифры.
 */
export function ModelSwitch() {
  const { model, setModel, models } = useModel();
  if (!models.length) return null;
  if (models.length === 1) {
    return (
      <div className="model-switch" role="group" aria-label="Модель">
        <span className="model-switch-single">{models[0].label}</span>
      </div>
    );
  }

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
