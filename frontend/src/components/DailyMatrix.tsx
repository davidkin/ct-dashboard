import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { DailyReport, isAdminConfigured, patchPartner } from "../api";

/* Дневная матрица трафика (день × кампания) в дизайн-системе профиля (an-/dm-),
   тема-адаптивная, без Google-Sheets грида. Колонки Дата + Total зафиксированы
   слева (sticky) — остаются видимыми при горизонтальном скролле по кампаниям.
   Total: агрегаты по дню + разбивка по кампаниям. Raw: только клики/фаны. */

const intFmt = (n: number | null): string => (n == null ? "" : n.toLocaleString("en-US"));
const money = (n: number | null): string => (n == null ? "" : `$${n.toFixed(2)}`);
const pct = (n: number | null): string => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
const dmy = (d: string): string =>
  new Date(`${d}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });

/* data-атрибуты для выделяемой ячейки (пусто, если значения нет — не выделяется) */
const dsel = (
  key: string,
  value: number | null | undefined,
  kind: "int" | "money",
): Record<string, string> =>
  value != null ? { "data-k": key, "data-v": String(value), "data-kind": kind } : {};

type Campaigns = DailyReport["campaigns"];
type Rows = DailyReport["rows"];

/* Зафиксированный слева блок: Дата + 4 колонки Total. Ширины фиксированы,
   left-офсеты кумулятивны — так sticky-колонки не разъезжаются. */
const DATE_W = 58;
const TOTAL_COLS = [
  { key: "clicks", label: "Клики", w: 72 },
  { key: "fans", label: "Фаны", w: 64 },
  { key: "cr", label: "Конверт", w: 70 },
  { key: "pay", label: "Сумма", w: 84 },
] as const;
const totalLeft = (i: number) => DATE_W + TOTAL_COLS.slice(0, i).reduce((s, c) => s + c.w, 0);
const LAST_TOTAL = TOTAL_COLS.length - 1;

interface SelStats { count: number; sum: number; money: boolean }

/* Выделение ячеек мышью (клик / drag / Ctrl-клик) + сумма выделенного.
   Работает через делегирование на контейнере: ячейки помечены data-k / data-v /
   data-kind. Класс подсветки вешаем на DOM напрямую — без ре-рендера тысяч ячеек. */
function useCellSelection(resetDeps: unknown[]) {
  const selRef = useRef(new Map<string, { value: number; kind: string; el: HTMLElement }>());
  const draggingRef = useRef(false);
  const [stats, setStats] = useState<SelStats | null>(null);

  const recompute = () => {
    const items = [...selRef.current.values()];
    if (!items.length) return setStats(null);
    setStats({
      count: items.length,
      sum: items.reduce((s, i) => s + i.value, 0),
      money: items.every((i) => i.kind === "money"),
    });
  };
  const clear = () => {
    for (const { el } of selRef.current.values()) el.classList.remove("dm-sel");
    selRef.current.clear();
    setStats(null);
  };
  const add = (td: HTMLElement) => {
    const k = td.dataset.k;
    if (!k || selRef.current.has(k)) return;
    const value = parseFloat(td.dataset.v ?? "");
    if (Number.isNaN(value)) return;
    selRef.current.set(k, { value, kind: td.dataset.kind ?? "int", el: td });
    td.classList.add("dm-sel");
  };
  const toggle = (td: HTMLElement) => {
    const k = td.dataset.k;
    if (!k) return;
    const cur = selRef.current.get(k);
    if (cur) {
      cur.el.classList.remove("dm-sel");
      selRef.current.delete(k);
    } else add(td);
  };

  const cell = (e: React.MouseEvent): HTMLElement | null =>
    (e.target as HTMLElement).closest<HTMLElement>("td[data-k]");

  const onMouseDown = (e: React.MouseEvent) => {
    const td = cell(e);
    if (!td) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) toggle(td);
    else {
      clear();
      add(td);
    }
    draggingRef.current = true;
    recompute();
  };
  const onMouseOver = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const td = cell(e);
    if (td) {
      add(td);
      recompute();
    }
  };

  useEffect(() => {
    const up = () => (draggingRef.current = false);
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);
  // сброс выделения при смене вкладки / данных
  useEffect(() => clear(), resetDeps); // eslint-disable-line react-hooks/exhaustive-deps

  return { onMouseDown, onMouseOver, stats, clear };
}

function SumPopup({ stats, onClear }: { stats: SelStats; onClear: () => void }) {
  const fmt = (n: number) =>
    stats.money ? `$${n.toFixed(2)}` : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

  /* Перетаскивание окна. pos=null → дефолтное место (CSS: слева-снизу).
     Тащим за грип; крестик из drag исключён. Клампим в границы вьюпорта. */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  function onGripDown(e: React.MouseEvent) {
    const box = boxRef.current!.getBoundingClientRect();
    grab.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    setPos({ left: box.left, top: box.top });
    e.preventDefault();
  }
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const g = grab.current;
      const el = boxRef.current;
      if (!g || !el) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      const left = Math.min(Math.max(0, e.clientX - g.dx), window.innerWidth - w);
      const top = Math.min(Math.max(0, e.clientY - g.dy), window.innerHeight - h);
      setPos({ left, top });
    };
    const up = () => (grab.current = null);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, []);

  const style: React.CSSProperties = pos
    ? { left: pos.left, top: pos.top, right: "auto", bottom: "auto" }
    : {};

  return (
    <div className="dm-sum-popup" role="status" ref={boxRef} style={style}>
      <span className="dm-sum-grip" title="Перетащить" onMouseDown={onGripDown}>⠿</span>
      <div className="dm-sum-main">
        <span className="dm-sum-lbl">Сумма</span>
        <b className="dm-sum-val">{fmt(stats.sum)}</b>
      </div>
      <div className="dm-sum-sub">
        <span>Ячеек: <b>{stats.count}</b></span>
        <span>Среднее: <b>{fmt(stats.sum / stats.count)}</b></span>
      </div>
      <button className="dm-sum-x" onClick={onClear} title="Сбросить">
        ✕
      </button>
    </div>
  );
}

export default function DailyMatrix({
  campaigns,
  rows,
  partnerId,
  onChanged,
}: {
  campaigns: Campaigns;
  rows: Rows;
  partnerId: number;
  onChanged?: () => void;
}) {
  const [tab, setTab] = useState<"total" | "raw">("total");

  /* Notes & Conditions: СPF по тирам + Revshare (из кампаний партнёра).
     CPF резолвится с приоритетом партнёра → правка идёт в партнёра (patchPartner). */
  const freeCpf = campaigns.find((c) => c.tier === "free")?.cpf ?? null;
  const paidCpf = campaigns.find((c) => c.tier === "paid")?.cpf ?? null;
  const revshare = campaigns.find((c) => c.revshare != null)?.revshare ?? null;
  const hasFree = campaigns.some((c) => c.tier === "free");
  const hasPaid = campaigns.some((c) => c.tier === "paid");
  const canEdit = isAdminConfigured();

  async function saveCpf(field: "cpf_free" | "cpf_paid", value: number | null) {
    await patchPartner(partnerId, { [field]: value });
    onChanged?.();
  }

  const sel = useCellSelection([tab, rows]);

  return (
    <div className="an-card">
      <div className="an-card-head">
        <h3>
          Таблица трафика <span className="faint">· {rows.length} дней</span>
        </h3>
        <div className="dm-seg" role="group" aria-label="Вид таблицы">
          <button className={`dm-seg-btn${tab === "total" ? " active" : ""}`} onClick={() => setTab("total")}>
            Total
          </button>
          <button className={`dm-seg-btn${tab === "raw" ? " active" : ""}`} onClick={() => setTab("raw")}>
            Raw
          </button>
        </div>
      </div>

      {/* Notes & Conditions */}
      <div className="dm-notes">
        <span className="dm-notes-lbl">Notes &amp; Conditions</span>
        {hasFree && (
          <CpfNote label="СPF Free" value={freeCpf} editable={canEdit} onSave={(v) => saveCpf("cpf_free", v)} />
        )}
        {hasPaid && (
          <CpfNote label="СPF Paid" value={paidCpf} editable={canEdit} onSave={(v) => saveCpf("cpf_paid", v)} />
        )}
        <span className="dm-note">
          Revshare <b>{revshare != null ? pct(revshare) : "—"}</b>
        </span>
      </div>

      {!rows.length ? (
        <p className="muted" style={{ padding: "0 20px 20px" }}>
          Нет данных за период.
        </p>
      ) : (
        <div className="dm-scroll" onMouseDown={sel.onMouseDown} onMouseOver={sel.onMouseOver}>
          {tab === "total" ? (
            <TotalMatrix campaigns={campaigns} rows={rows} />
          ) : (
            <RawMatrix campaigns={campaigns} rows={rows} />
          )}
        </div>
      )}

      {sel.stats && <SumPopup stats={sel.stats} onClear={sel.clear} />}
    </div>
  );
}

/* Редактируемый CPF-чип: клик (у админа) → инпут, Enter/blur сохраняет. */
function CpfNote({
  label,
  value,
  editable,
  onSave,
}: {
  label: string;
  value: number | null;
  editable: boolean;
  onSave: (v: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  function begin() {
    if (!editable) return;
    setDraft(value != null ? String(value) : "");
    setEditing(true);
  }
  async function commit() {
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    setEditing(false);
    if (next != null && Number.isNaN(next)) return;
    if (next === value) return;
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <span className="dm-note dm-note-edit">
        {label}{" "}
        <input
          autoFocus
          type="number"
          step="0.01"
          min="0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </span>
    );
  }
  return (
    <span
      className={`dm-note${editable ? " dm-note-btn" : ""}${saving ? " dm-note-saving" : ""}`}
      onClick={begin}
      title={editable ? "Редактировать CPF" : undefined}
    >
      {label} <b>{value != null ? money(value) : "—"}</b>
      {editable && <span className="dm-note-pen">✎</span>}
    </span>
  );
}

function TotalMatrix({ campaigns, rows }: { campaigns: Campaigns; rows: Rows }) {
  const foot = useMemo(() => {
    const per = new Map<number, { clicks: number; fans: number; payout: number }>();
    campaigns.forEach((c) => per.set(c.link_id, { clicks: 0, fans: 0, payout: 0 }));
    let gClicks = 0, gFans = 0, gPay = 0;
    for (const r of rows) {
      gClicks += r.total.clicks ?? 0;
      gFans += r.total.subs ?? 0;
      gPay += r.total.payout ?? 0;
      for (const c of campaigns) {
        const cell = r.cells[String(c.link_id)];
        if (!cell) continue;
        const a = per.get(c.link_id)!;
        a.clicks += cell.clicks ?? 0;
        a.fans += cell.subs;
        a.payout += cell.payout;
      }
    }
    return { per, gClicks, gFans, gPay };
  }, [campaigns, rows]);

  /* sticky-пропсы для i-й Total-колонки (последняя — с правой границей блока) */
  const frz = (i: number, extra = ""): { className: string; style: React.CSSProperties } => ({
    className: `num${extra ? " " + extra : ""} dm-frz${i === LAST_TOTAL ? " dm-frz-edge" : ""}`,
    style: { left: totalLeft(i), width: TOTAL_COLS[i].w, minWidth: TOTAL_COLS[i].w },
  });

  return (
    <table className="dm-table">
        <thead>
          <tr>
            <th className="dm-frz dm-date-col" rowSpan={2} style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
              Дата
            </th>
            <th className="dm-frz dm-frz-edge dm-grp" colSpan={4} style={{ left: DATE_W }}>
              Total
            </th>
            {campaigns.map((c) => (
              <th key={c.link_id} className="dm-grp dm-grp-sep" colSpan={4}>
                [{c.campaign_code}]
              </th>
            ))}
          </tr>
          <tr>
            {TOTAL_COLS.map((col, i) => (
              <th key={col.key} {...frz(i)}>
                {col.label}
              </th>
            ))}
            {campaigns.map((c) => (
              <Fragment key={c.link_id}>
                <th className="num dm-grp-sep">Клики</th>
                <th className="num">Фаны</th>
                <th className="num">CR</th>
                <th className="num">Сумма</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td className="dm-frz dm-date-col dm-date" style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
                {dmy(r.date)}
              </td>
              <td {...frz(0)} {...dsel(`tc-${r.date}`, r.total.clicks, "int")}>{intFmt(r.total.clicks)}</td>
              <td {...frz(1, "dm-b")} {...dsel(`tf-${r.date}`, r.total.subs, "int")}>{intFmt(r.total.subs)}</td>
              <td {...frz(2, "muted")}>{pct(r.total.cr)}</td>
              <td {...frz(3, "accent")} {...dsel(`tp-${r.date}`, r.total.payout, "money")}>{money(r.total.payout)}</td>
              {campaigns.map((c) => {
                const cell = r.cells[String(c.link_id)];
                return (
                  <Fragment key={c.link_id}>
                    <td className="num dm-grp-sep" {...dsel(`c${c.link_id}cl-${r.date}`, cell?.clicks, "int")}>{intFmt(cell?.clicks ?? null)}</td>
                    <td className="num" {...dsel(`c${c.link_id}f-${r.date}`, cell?.subs || null, "int")}>{cell?.subs ? cell.subs : ""}</td>
                    <td className="num muted">{pct(cell?.cr ?? null)}</td>
                    <td className="num" {...dsel(`c${c.link_id}p-${r.date}`, cell?.payout || null, "money")}>{cell?.payout ? money(cell.payout) : ""}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="dm-total-row">
            <td className="dm-frz dm-date-col dm-date" style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
              Total
            </td>
            <td {...frz(0, "dm-b")}>{intFmt(foot.gClicks)}</td>
            <td {...frz(1, "dm-b")}>{intFmt(foot.gFans)}</td>
            <td {...frz(2)}>{foot.gClicks ? pct(foot.gFans / foot.gClicks) : "—"}</td>
            <td {...frz(3, "accent")}>{money(foot.gPay)}</td>
            {campaigns.map((c) => {
              const a = foot.per.get(c.link_id)!;
              return (
                <Fragment key={c.link_id}>
                  <td className="num dm-b dm-grp-sep">{a.clicks ? intFmt(a.clicks) : ""}</td>
                  <td className="num dm-b">{a.fans ? a.fans : ""}</td>
                  <td className="num">{a.clicks ? pct(a.fans / a.clicks) : "—"}</td>
                  <td className="num">{a.payout ? money(a.payout) : ""}</td>
                </Fragment>
              );
            })}
          </tr>
        </tfoot>
      </table>
  );
}

function RawMatrix({ campaigns, rows }: { campaigns: Campaigns; rows: Rows }) {
  return (
    <table className="dm-table">
        <thead>
          <tr>
            <th className="dm-frz dm-frz-edge dm-date-col" rowSpan={2} style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
              Дата
            </th>
            {campaigns.map((c) => (
              <th key={c.link_id} className="dm-grp dm-grp-sep" colSpan={2}>
                [{c.campaign_code}]
              </th>
            ))}
          </tr>
          <tr>
            {campaigns.map((c) => (
              <Fragment key={c.link_id}>
                <th className="num dm-grp-sep">Клики</th>
                <th className="num">Фаны</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td className="dm-frz dm-frz-edge dm-date-col dm-date" style={{ left: 0, width: DATE_W, minWidth: DATE_W }}>
                {dmy(r.date)}
              </td>
              {campaigns.map((c) => {
                const cell = r.cells[String(c.link_id)];
                return (
                  <Fragment key={c.link_id}>
                    <td className="num dm-grp-sep" {...dsel(`rc${c.link_id}cl-${r.date}`, cell?.clicks, "int")}>{intFmt(cell?.clicks ?? null)}</td>
                    <td className="num" {...dsel(`rc${c.link_id}f-${r.date}`, cell ? cell.subs : null, "int")}>{cell?.subs ? cell.subs : cell ? 0 : ""}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
  );
}
