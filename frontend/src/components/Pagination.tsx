/**
 * Простая пагинация. Не делаем лоадеры, всё локально в памяти.
 */
export function Pagination({
  page, totalPages, pageSize, totalItems, onPageChange, onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
}) {
  if (totalItems === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);

  return (
    <div className="pagination">
      <div className="muted" style={{ fontSize: 12 }}>
        {from}–{to} из {totalItems}
      </div>
      <div className="pagination-actions">
        <select
          value={pageSize}
          onChange={(e) => { onPageSizeChange(Number(e.target.value)); onPageChange(1); }}
          className="input"
          title="Сколько строк на странице"
        >
          <option value={10}>10 / стр</option>
          <option value={25}>25 / стр</option>
          <option value={50}>50 / стр</option>
          <option value={100}>100 / стр</option>
          <option value={9999}>Все</option>
        </select>
        <button
          className="btn ghost"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >‹ Назад</button>
        <span className="muted" style={{ fontSize: 12, padding: "0 8px" }}>
          стр. {page} / {Math.max(1, totalPages)}
        </span>
        <button
          className="btn ghost"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >Вперёд ›</button>
      </div>
    </div>
  );
}
