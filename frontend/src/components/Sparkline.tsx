import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";

interface Point {
  day: string;
  clicks: number;
}

/**
 * Маленький inline-график тренда (7 дней) — без осей, без сетки.
 * Если данных меньше двух точек, рисуем плоскую линию-плейсхолдер.
 */
export function Sparkline({
  data,
  width = 90,
  height = 32,
  color,
}: {
  data: Point[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const stroke = color ?? "var(--accent)";

  if (data.length === 0) {
    return (
      <span className="muted" style={{ fontSize: 11, display: "inline-block", width, textAlign: "center" }}>
        нет данных
      </span>
    );
  }

  /* Recharts требует >=2 точек чтобы что-то нарисовать */
  const points = data.length === 1
    ? [{ day: data[0].day, clicks: data[0].clicks }, { day: data[0].day, clicks: data[0].clicks }]
    : data;

  return (
    <div style={{ width, height, display: "inline-block" }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
          <defs>
            <linearGradient id={`spark-grad-${stroke}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.4} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip
            contentStyle={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              fontSize: 11,
              padding: "4px 8px",
              color: "var(--text)",
            }}
            labelStyle={{ color: "var(--muted)" }}
            formatter={(v) => [Number(v).toLocaleString("en-US"), "clicks"]}
            cursor={false}
          />
          <Area
            type="monotone"
            dataKey="clicks"
            stroke={stroke}
            strokeWidth={1.5}
            fill={`url(#spark-grad-${stroke})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
