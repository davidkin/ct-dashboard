import { useEffect, useMemo, useRef, useState } from "react";

/* Кастомный range-календарь в дизайн-системе приложения (тема-адаптивный).
   Заменяет пару нативных <input type="date">. Выбор диапазона в одном
   календаре: 1-й клик — старт, 2-й — конец; пресеты справа. */

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m: m - 1, d };
};
const fmtRu = (s: string) => {
  const { y, m, d } = parse(s);
  return `${pad(d)}.${pad(m + 1)}.${y}`;
};
const todayISO = () => {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth(), t.getDate());
};
const addDaysISO = (s: string, delta: number) => {
  const { y, m, d } = parse(s);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
};

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

interface Cell { d: string; day: number; out: boolean }

/* сетка месяца (пн-первый), с хвостами соседних месяцев */
function monthGrid(year: number, month: number): Cell[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // пн=0
  const cells: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(year, month, 1 - lead + i);
    cells.push({
      d: iso(dt.getFullYear(), dt.getMonth(), dt.getDate()),
      day: dt.getDate(),
      out: dt.getMonth() !== month,
    });
  }
  return cells;
}

export default function DateRangePicker({
  from,
  to,
  onChange,
  max,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  max?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => parse(from));
  const [pending, setPending] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const maxD = max ?? todayISO();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPending(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // при открытии показываем месяц начала диапазона
  useEffect(() => {
    if (open) setView(parse(from));
  }, [open, from]);

  const grid = useMemo(() => monthGrid(view.y, view.m), [view]);

  const selStart = pending ?? from;
  const selEnd = pending ? (hover && hover >= pending ? hover : pending) : to;

  function pickDay(d: string) {
    if (d > maxD) return;
    if (!pending) {
      setPending(d);
      setHover(d);
    } else if (d >= pending) {
      onChange(pending, d);
      setPending(null);
      setHover(null);
      setOpen(false);
    } else {
      setPending(d); // клик раньше старта → новый старт
      setHover(d);
    }
  }

  function applyPreset(f: string, t: string) {
    onChange(f, t);
    setPending(null);
    setHover(null);
    setOpen(false);
  }

  const monthNav = (delta: number) => {
    const m = view.m + delta;
    const y = view.y + Math.floor(m / 12);
    setView({ y, m: ((m % 12) + 12) % 12, d: 1 });
  };

  const today = todayISO();

  return (
    <div className="drp" ref={ref}>
      <button className="drp-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="muted">с</span> <b>{fmtRu(from)}</b>
        <span className="muted">по</span> <b>{fmtRu(to)}</b>
        <span className="drp-cal">▾</span>
      </button>

      {open && (
        <div className="drp-pop">
          <div className="drp-cal-side">
            <div className="drp-head">
              <button className="drp-nav" onClick={() => monthNav(-1)} title="Пред. месяц">‹</button>
              <span className="drp-title">{MONTHS[view.m]} {view.y}</span>
              <button className="drp-nav" onClick={() => monthNav(1)} title="След. месяц">›</button>
            </div>
            <div className="drp-grid drp-wd">
              {WD.map((w) => (
                <span key={w} className="drp-wd-cell">{w}</span>
              ))}
            </div>
            <div className="drp-grid">
              {grid.map((c) => {
                const isStart = c.d === selStart;
                const isEnd = c.d === selEnd;
                const inRange = c.d > selStart && c.d < selEnd;
                const disabled = c.d > maxD;
                const cls = [
                  "drp-day",
                  c.out ? "out" : "",
                  disabled ? "disabled" : "",
                  isStart || isEnd ? "end" : "",
                  inRange ? "inrange" : "",
                  c.d === today ? "today" : "",
                ].filter(Boolean).join(" ");
                return (
                  <button
                    key={c.d}
                    className={cls}
                    disabled={disabled}
                    onMouseEnter={() => pending && setHover(c.d)}
                    onClick={() => pickDay(c.d)}
                  >
                    {c.day}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="drp-presets">
            <button onClick={() => applyPreset(today, today)}>Сегодня</button>
            <button onClick={() => applyPreset(addDaysISO(today, -6), today)}>7 дней</button>
            <button onClick={() => applyPreset(addDaysISO(today, -29), today)}>30 дней</button>
            <button onClick={() => applyPreset(addDaysISO(today, -89), today)}>90 дней</button>
            <button onClick={() => applyPreset(today.slice(0, 8) + "01", today)}>Этот месяц</button>
          </div>
        </div>
      )}
    </div>
  );
}
