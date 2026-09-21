import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { addCpfHistory, CpfHistoryEntry, DailyReport, deleteCpfHistory, fetchCpfHistory, isAdminConfigured } from "../api";

/* Дневная матрица трафика (день × кампания) в дизайн-системе профиля (an-/dm-),
   тема-адаптивная, без Google-Sheets грида. Колонки Дата + Total зафиксированы
   слева (sticky) — остаются видимыми при горизонтальном скролле по кампаниям.
   Total: агрегаты по дню + разбивка по кампаниям. Raw: только клики/фаны. */

const intFmt = (n: number | null): string => (n == null ? "" : n.toLocaleString("en-US"));
const money = (n: number | null): string => (n == null ? "" : `$${n.toFixed(2)}`);
const pct = (n: number | null): string => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
const dmy = (d: string): string =>
  new Date(`${d}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const weekday = (d: string): string => WD[new Date(`${d}T00:00:00`).getDay()];
const isMonday = (d: string): boolean => new Date(`${d}T00:00:00`).getDay() === 1;
const isWeekend = (d: string): boolean => {
  const g = new Date(`${d}T00:00:00`).getDay();
  return g === 0 || g === 6;
};

/* Ячейка даты: число + день недели (пн–вс) под ним. */
function DateCell({ day, className, style }: { day: string; className: string; style?: React.CSSProperties }) {
  return (
    <td className={className} style={style}>
      <span className="dm-date-d">{dmy(day)}</span>
      <span className="dm-date-w">{weekday(day)}</span>
    </td>
  );
}

/* data-атрибуты для выделяемой ячейки (пусто, если значения нет — не выделяется) */
/* data-free / data-paid — вклад ячейки в каждый тир. У ячейки кампании это всё
   значение целиком, у ячейки Total — её free- и vip-части за этот день. */
const dsel = (
  key: string,
  value: number | null | undefined,
  kind: "int" | "money",
  parts?: { free: number; paid: number } | "free" | "paid",
): Record<string, string> => {
  if (value == null) return {};
  const base = { "data-k": key, "data-v": String(value), "data-kind": kind };
  if (parts === "free") return { ...base, "data-free": String(value), "data-paid": "0" };
  if (parts === "paid") return { ...base, "data-free": "0", "data-paid": String(value) };
  if (parts) return { ...base, "data-free": String(parts.free), "data-paid": String(parts.paid) };
  return base;
};

type Campaigns = DailyReport["campaigns"];
type Rows = DailyReport["rows"];

/* Зафиксированный слева блок: Дата + 4 колонки Total. Ширины фиксированы,
   left-офсеты кумулятивны — так sticky-колонки не разъезжаются. */
const DATE_W = 58;
const TOTAL_COLS = [
  { key: "clicks", label: "Клики", w: 72 },
  { key: "fans", label: "Фаны", w: 64 },
  { key: "cr", label: "Конверт", w: 80 },
  { key: "pay", label: "Сумма", w: 84 },
] as const;
const totalLeft = (i: number) => DATE_W + TOTAL_COLS.slice(0, i).reduce((s, c) => s + c.w, 0);
const LAST_TOTAL = TOTAL_COLS.length - 1;

interface SelStats {
  count: number;
  sum: number;
  money: boolean;
  /** Разбивка выделенного по тирам: null — таких ячеек в выделении нет. */
  free: number | null;
  paid: number | null;
}

/* Выделение ячеек мышью (клик / drag / Ctrl-клик) + сумма выделенного.
   Работает через делегирование на контейнере: ячейки помечены data-k / data-v /
   data-kind. Класс подсветки вешаем на DOM напрямую — без ре-рендера тысяч ячеек. */
function useCellSelection(resetDeps: unknown[]) {
  const selRef = useRef(
    new Map<
      string,
      { value: number; kind: string; free: number | null; paid: number | null; el: HTMLElement }
    >(),
  );
  const draggingRef = useRef(false);
  const [stats, setStats] = useState<SelStats | null>(null);

  const recompute = () => {
    const items = [...selRef.current.values()];
    if (!items.length) return setStats(null);
    /* Разбивку показываем, только если её несут все выделенные ячейки:
       иначе сумма частей не сойдётся с общей и собьёт с толку. */
    const split = items.every((i) => i.free !== null && i.paid !== null);
    setStats({
      count: items.length,
      sum: items.reduce((s, i) => s + i.value, 0),
      money: items.every((i) => i.kind === "money"),
      free: split ? items.reduce((s, i) => s + (i.free ?? 0), 0) : null,
      paid: split ? items.reduce((s, i) => s + (i.paid ?? 0), 0) : null,
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
    const part = (raw: string | undefined) => (raw == null ? null : Number(raw));
    selRef.current.set(k, {
      value,
      kind: td.dataset.kind ?? "int",
      free: part(td.dataset.free),
      paid: part(td.dataset.paid),
      el: td,
    });
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
      {(stats.free !== null || stats.paid !== null) && (
        <div className="dm-sum-tiers">
          <span>
            Фри: <b>{fmt(stats.free ?? 0)}</b>
          </span>
          <span>
            Вип: <b>{fmt(stats.paid ?? 0)}</b>
          </span>
        </div>
      )}
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
  /* Что показывает зафиксированный блок Total: всё, только free или только vip.
     Колонки кампаний при этом не трогаем — страница остаётся прежней. */
  const [totalTier, setTotalTier] = useState<"all" | "free" | "paid">("all");

  /* Notes & Conditions: СPF по тирам + Revshare (из кампаний партнёра).
     CPF резолвится с приоритетом партнёра → правка идёт в партнёра (patchPartner). */
  const freeCpf = campaigns.find((c) => c.tier === "free")?.cpf ?? null;
  const paidCpf = campaigns.find((c) => c.tier === "paid")?.cpf ?? null;
  const revshare = campaigns.find((c) => c.revshare != null)?.revshare ?? null;
  const hasFree = campaigns.some((c) => c.tier === "free");
  const hasPaid = campaigns.some((c) => c.tier === "paid");
  const canEdit = isAdminConfigured();

  const sel = useCellSelection([tab, rows, totalTier]);

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
        {tab === "total" && (hasFree || hasPaid) && (
          <div className="dm-seg" role="group" aria-label="Что считать в Total">
            {(["all", "free", "paid"] as const).map((t) => (
              <button
                key={t}
                className={`dm-seg-btn${totalTier === t ? " active" : ""}`}
                onClick={() => setTotalTier(t)}
                title="Что суммировать в колонке Total"
              >
                {t === "all" ? "Total: всё" : t === "free" ? "Free" : "VIP"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Notes & Conditions */}
      <div className="dm-notes">
        <span className="dm-notes-lbl">Notes &amp; Conditions</span>
        {hasFree && (
          <CpfNote label="СPF Free" tier="free" value={freeCpf} editable={canEdit} partnerId={partnerId} onChanged={onChanged} />
        )}
        {hasPaid && (
          <CpfNote label="СPF Paid" tier="paid" value={paidCpf} editable={canEdit} partnerId={partnerId} onChanged={onChanged} />
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
            <TotalMatrix campaigns={campaigns} rows={rows} totalTier={totalTier} />
          ) : (
            <RawMatrix campaigns={campaigns} rows={rows} />
          )}
        </div>
      )}

      {sel.stats && <SumPopup stats={sel.stats} onClear={sel.clear} />}
    </div>
  );
}

/* CPF-чип: у читателя просто значение, у админа/менеджера клик открывает
   модалку "новая ставка с такого-то числа" + историю прошлых ставок ниже. */
function CpfNote({
  label,
  tier,
  value,
  editable,
  partnerId,
  onChanged,
}: {
  label: string;
  tier: "free" | "paid";
  value: number | null;
  editable: boolean;
  partnerId: number;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="dm-note">
        {label} <b>{value != null ? money(value) : "—"}</b>
        {editable && (
          <button
            type="button"
            className="dm-note-hist-btn"
            onClick={() => setOpen(true)}
            title="Ставка и история изменений"
          >
            🕒
          </button>
        )}
      </span>
      {open && (
        <CpfHistoryModal
          label={label}
          tier={tier}
          current={value}
          partnerId={partnerId}
          onClose={() => setOpen(false)}
          onChanged={() => onChanged?.()}
        />
      )}
    </>
  );
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/* Модалка ставки CPF: форма "новое значение + дата, с которой действует" сверху,
   история прошлых ставок снизу. Прошлые дни отчёта после сохранения не трогаются —
   пересчитывается только то, что было НА и ПОСЛЕ указанной даты. */
function CpfHistoryModal({
  label,
  tier,
  current,
  partnerId,
  onClose,
  onChanged,
}: {
  label: string;
  tier: "free" | "paid";
  current: number | null;
  partnerId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [history, setHistory] = useState<CpfHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [value, setValue] = useState(current != null ? String(current) : "");
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetchCpfHistory(partnerId)
      .then((rows) => setHistory(rows.filter((r) => r.tier === tier)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }
  useEffect(load, [partnerId, tier]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const num = Number(value.replace(",", "."));
    if (!Number.isFinite(num) || num <= 0) {
      setError("Ставка должна быть больше нуля");
      return;
    }
    if (!date) {
      setError("Укажи дату");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addCpfHistory(partnerId, tier, num, date);
      onChanged();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(historyId: number) {
    if (!confirm("Убрать эту запись из истории? Отменить нельзя.")) return;
    setError(null);
    try {
      await deleteCpfHistory(partnerId, historyId);
      onChanged();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pm-wrap" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} title="закрыть">
          ✕
        </button>
        <h2>{label}</h2>
        <p className="muted">
          Ставка действует с указанной даты и позже. Дни до неё считаются по тому, что было — прошлое не
          пересчитывается.
        </p>

        <form className="pm-section" onSubmit={save}>
          <div className="pm-grid">
            <label>
              Новая ставка
              <input
                className="input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="1.50"
                autoFocus
              />
            </label>
            <label>
              Действует с
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>
          {error && <p className="pm-err">{error}</p>}
          <div className="pm-actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Сохраняю…" : "Сохранить"}
            </button>
          </div>
        </form>

        <section className="pm-section">
          <h3>История</h3>
          {loading && <p className="muted">Загружаю…</p>}
          {!loading && history.length === 0 && (
            <p className="muted">Пока нет ни одной дата-привязанной записи — действует текущее значение партнёра.</p>
          )}
          {!loading && history.length > 0 && (
            <table className="an-table cpf-hist-table">
              <thead>
                <tr>
                  <th>Действует с</th>
                  <th className="num">Ставка</th>
                  <th>Кто указал</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.effective_from}</td>
                    <td className="num">{money(h.cpf)}</td>
                    <td className="muted">{h.created_by ?? "—"}</td>
                    <td className="gl-actions">
                      <button type="button" className="gl-del" onClick={() => remove(h.id)} title="Убрать запись (миссклик)">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

function TotalMatrix({
  campaigns,
  rows,
  totalTier,
}: {
  campaigns: Campaigns;
  rows: Rows;
  totalTier: "all" | "free" | "paid";
}) {
  /* Вклад free- и vip-кампаний в каждый день: нужен и для переключателя Total,
     и для разбивки в окне выделения. */
  const dayParts = useMemo(() => {
    const map = new Map<
      string,
      { free: { clicks: number; subs: number; payout: number }; paid: { clicks: number; subs: number; payout: number } }
    >();
    for (const r of rows) {
      const acc = {
        free: { clicks: 0, subs: 0, payout: 0 },
        paid: { clicks: 0, subs: 0, payout: 0 },
      };
      for (const c of campaigns) {
        const cell = r.cells[String(c.link_id)];
        if (!cell) continue;
        const side = c.tier === "paid" ? acc.paid : acc.free;
        side.clicks += cell.clicks ?? 0;
        side.subs += cell.subs;
        side.payout += cell.payout;
      }
      map.set(r.date, acc);
    }
    return map;
  }, [campaigns, rows]);

  /* Дневной Total по выбранному тиру: сервер считает только общий, поэтому для
     free/vip складываем ячейки нужных кампаний прямо здесь. */
  const dayTotals = useMemo(() => {
    const wanted = campaigns.filter((c) => totalTier === "all" || c.tier === totalTier);
    const map = new Map<
      string,
      { clicks: number | null; subs: number | null; payout: number | null; cr: number | null }
    >();
    for (const r of rows) {
      if (totalTier === "all") {
        map.set(r.date, {
          clicks: r.total.clicks ?? null,
          subs: r.total.subs ?? null,
          payout: r.total.payout ?? null,
          cr: r.total.cr ?? null,
        });
        continue;
      }
      /* День без ячеек нужного тира оставляем пустым, как это было для общего Total. */
      let clicks = 0, subs = 0, payout = 0, seen = false;
      for (const c of wanted) {
        const cell = r.cells[String(c.link_id)];
        if (!cell) continue;
        seen = true;
        clicks += cell.clicks ?? 0;
        subs += cell.subs;
        payout += cell.payout;
      }
      map.set(
        r.date,
        seen
          ? { clicks, subs, payout, cr: clicks ? subs / clicks : null }
          : { clicks: null, subs: null, payout: null, cr: null },
      );
    }
    return map;
  }, [campaigns, rows, totalTier]);

  const foot = useMemo(() => {
    const per = new Map<number, { clicks: number; fans: number; payout: number }>();
    campaigns.forEach((c) => per.set(c.link_id, { clicks: 0, fans: 0, payout: 0 }));
    let gClicks = 0, gFans = 0, gPay = 0;
    for (const r of rows) {
      const t = dayTotals.get(r.date);
      gClicks += t?.clicks ?? 0;
      gFans += t?.subs ?? 0;
      gPay += t?.payout ?? 0;
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
  }, [campaigns, rows, dayTotals]);

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
              {totalTier === "all" ? "Total" : totalTier === "free" ? "Total · Free" : "Total · VIP"}
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
            <tr key={r.date} className={`${isMonday(r.date) ? "dm-week-start" : ""}${isWeekend(r.date) ? " dm-weekend" : ""}`}>
              <DateCell day={r.date} className="dm-frz dm-date-col dm-date" style={{ left: 0, width: DATE_W, minWidth: DATE_W }} />
              <td
                {...frz(0)}
                {...dsel(`tc-${r.date}`, dayTotals.get(r.date)?.clicks, "int", {
                  free: dayParts.get(r.date)?.free.clicks ?? 0,
                  paid: dayParts.get(r.date)?.paid.clicks ?? 0,
                })}
              >
                {intFmt(dayTotals.get(r.date)?.clicks ?? null)}
              </td>
              <td
                {...frz(1, "dm-b")}
                {...dsel(`tf-${r.date}`, dayTotals.get(r.date)?.subs, "int", {
                  free: dayParts.get(r.date)?.free.subs ?? 0,
                  paid: dayParts.get(r.date)?.paid.subs ?? 0,
                })}
              >
                {intFmt(dayTotals.get(r.date)?.subs ?? null)}
              </td>
              <td {...frz(2, "muted")}>{pct(dayTotals.get(r.date)?.cr ?? null)}</td>
              <td
                {...frz(3, "accent")}
                {...dsel(`tp-${r.date}`, dayTotals.get(r.date)?.payout, "money", {
                  free: dayParts.get(r.date)?.free.payout ?? 0,
                  paid: dayParts.get(r.date)?.paid.payout ?? 0,
                })}
              >
                {dayTotals.get(r.date)?.payout != null ? money(dayTotals.get(r.date)!.payout!) : ""}
              </td>
              {campaigns.map((c) => {
                const cell = r.cells[String(c.link_id)];
                return (
                  <Fragment key={c.link_id}>
                    <td className="num dm-grp-sep" {...dsel(`c${c.link_id}cl-${r.date}`, cell?.clicks, "int", c.tier)}>{intFmt(cell?.clicks ?? null)}</td>
                    <td className="num" {...dsel(`c${c.link_id}f-${r.date}`, cell?.subs || null, "int", c.tier)}>{cell?.subs ? cell.subs : ""}</td>
                    <td className="num muted">{pct(cell?.cr ?? null)}</td>
                    <td className="num" {...dsel(`c${c.link_id}p-${r.date}`, cell?.payout || null, "money", c.tier)}>{cell?.payout ? money(cell.payout) : ""}</td>
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
            <tr key={r.date} className={`${isMonday(r.date) ? "dm-week-start" : ""}${isWeekend(r.date) ? " dm-weekend" : ""}`}>
              <DateCell day={r.date} className="dm-frz dm-frz-edge dm-date-col dm-date" style={{ left: 0, width: DATE_W, minWidth: DATE_W }} />
              {campaigns.map((c) => {
                const cell = r.cells[String(c.link_id)];
                return (
                  <Fragment key={c.link_id}>
                    <td className="num dm-grp-sep" {...dsel(`rc${c.link_id}cl-${r.date}`, cell?.clicks, "int", c.tier)}>{intFmt(cell?.clicks ?? null)}</td>
                    <td className="num" {...dsel(`rc${c.link_id}f-${r.date}`, cell ? cell.subs : null, "int", c.tier)}>{cell?.subs ? cell.subs : cell ? 0 : ""}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
  );
}
