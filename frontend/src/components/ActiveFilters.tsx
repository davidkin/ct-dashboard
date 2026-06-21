interface FilterChip {
  label: string;
  value: string;
  onRemove: () => void;
}

/**
 * Показывает активные фильтры как чипы с крестиком.
 * Если фильтров нет — не рендерит ничего.
 */
export function ActiveFilters({ filters, onClearAll }: { filters: FilterChip[]; onClearAll?: () => void }) {
  if (filters.length === 0) return null;
  return (
    <div className="active-filters">
      <span className="muted" style={{ fontSize: 12 }}>Фильтры:</span>
      {filters.map((f, i) => (
        <span key={i} className="filter-chip">
          {f.label}: <b>{f.value}</b>
          <button onClick={f.onRemove} title="Убрать фильтр">×</button>
        </span>
      ))}
      {onClearAll && filters.length > 1 && (
        <button className="clear-all" onClick={onClearAll}>сбросить все</button>
      )}
    </div>
  );
}
