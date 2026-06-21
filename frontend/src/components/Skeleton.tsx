/** Shimmer-плейсхолдер для загрузки */
export function Skeleton({ height = 16, width = "100%", style }: { height?: number | string; width?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height, width, ...style }} />;
}

export function TableSkeleton({ rows = 8, cols = 9 }: { rows?: number; cols?: number }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: 14, borderBottom: "1px solid var(--border)", display: "flex", gap: 12 }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} height={12} width={`${60 + (i % 3) * 20}px`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ padding: 14, borderBottom: "1px solid var(--border)", display: "flex", gap: 12 }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height={14} width={`${50 + ((r + c) % 4) * 25}px`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StatSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="stat-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="stat">
          <Skeleton height={10} width={60} />
          <Skeleton height={24} width={80} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}
