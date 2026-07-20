import { Hint } from "./Hint";

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  /** Подпись слева */
  label?: string;
  /** Hint к лейблу */
  labelHint?: string;
  /** Текст справа когда период активен (например «В выбранном окне: 336 fans · $460») */
  rightHint?: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

export function PeriodPicker({ from, to, onChange, label = "Период", labelHint, rightHint }: Props) {
  const set = (a: string, b: string) => onChange(a, b);
  const active = !!(from && to);
  const t = today();

  return (
    <div className="period-row">
      <span className="muted" style={{ fontSize: 12 }}>
        {label}
        {labelHint && <Hint text={labelHint} />}
      </span>
      <input
        className="input"
        type="date"
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        max={to || t}
      />
      <span className="muted" style={{ fontSize: 12 }}>—</span>
      <input
        className="input"
        type="date"
        value={to}
        onChange={(e) => onChange(from, e.target.value)}
        min={from || undefined}
        max={t}
      />
      <div className="period-presets">
        <button className="chip" onClick={() => set(daysAgo(6), t)}>7 дней</button>
        <button className="chip" onClick={() => set(daysAgo(13), t)}>14 дней</button>
        <button className="chip" onClick={() => set(daysAgo(29), t)}>30 дней</button>
        {active && (
          <button className="chip" onClick={() => set("", "")}>За всё время</button>
        )}
      </div>
      {rightHint && (
        <span style={{ fontSize: 12, marginLeft: "auto", color: "var(--accent)", fontWeight: 600 }}>
          {rightHint}
        </span>
      )}
    </div>
  );
}
