import { useEffect, useRef, useState } from "react";
import { fetchReplyStats, recalculateReplyStats, ReplyStatsReport } from "../api";
import DateRangePicker from "./DateRangePicker";

/* Конверсия "фан ответил на приветку" — фоновый воркер на бэке понемногу
   обходит фанов через OM API и складывает результат в fan_reply_stats;
   здесь только читаем готовые цифры (может расти постепенно, см. pending).
   Пока pending>0 и карточка открыта — сам перепроверяет каждые 20с, чтобы
   рост цифр было видно без ручного обновления страницы (это и есть "таймер"
   для фоновой обработки — воркер общий на всех партнёров, поэтому точный ETA
   для конкретного партнёра посчитать нельзя, только нижняя оценка). */

const POLL_MS = 20_000;
/* Пропускная способность воркера: см. BATCH_SIZE/TICK_MS в reply-stats-worker.ts. */
const WORKER_FANS_PER_HOUR = (45 / 90) * 3600;
/* Это метрика "здоровья" воронки, не привязана к периоду страницы (как
   "Сверка с ОМ") — за всё время, иначе на короткой выборке цифры пустые
   и бессмысленные (жаловался David — виджет с 30-дневным окном показывал
   "0.0%, 3 фана" для партнёра, у которого реально 1499 посчитанных). */
const LIFETIME_FROM = "2020-01-01";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtMin(sec: number | null): string {
  if (sec == null) return "—";
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)} мин`;
  return `${(min / 60).toFixed(1)} ч`;
}

function fmtEta(pending: number): string {
  const hours = pending / WORKER_FANS_PER_HOUR;
  if (hours < 1) return `${Math.ceil(hours * 60)} мин`;
  return `${hours.toFixed(1)} ч`;
}

export default function ReplyStatsWidget({ partnerId, collapsible = true }: { partnerId?: number; collapsible?: boolean }) {
  const [rep, setRep] = useState<ReplyStatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!collapsible);
  const [from, setFrom] = useState(LIFETIME_FROM);
  const [to, setTo] = useState(todayISO());
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [recalcNote, setRecalcNote] = useState<string | null>(null);
  const repRef = useRef(rep);
  repRef.current = rep;

  function load() {
    setLoading(true);
    fetchReplyStats({ partnerId, from, to })
      .then(setRep)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchReplyStats({ partnerId, from, to })
      .then((r) => alive && setRep(r))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [partnerId, from, to]);

  /* Живое обновление, пока есть что досчитывать и карточка открыта. */
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      if (!repRef.current || repRef.current.pending <= 0) return;
      fetchReplyStats({ partnerId, from, to })
        .then(setRep)
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [open, partnerId, from, to]);

  /* Ручной пересчёт: гоняет батчи по 80 фанов, пока remaining не станет 0
     (или пока пользователь не уйдёт со страницы) — обходит суточный
     троттлинг фона и не ждёт общую очередь на всех партнёров. */
  async function recalculate() {
    if (partnerId == null || recalcBusy) return;
    setRecalcBusy(true);
    setRecalcNote(null);
    try {
      let totalChecked = 0;
      for (let i = 0; i < 50; i++) {
        const res = await recalculateReplyStats(partnerId, from, to);
        totalChecked += res.checked;
        setRecalcNote(`Пересчитано ${totalChecked}, осталось ~${res.remaining}…`);
        load();
        if (res.remaining <= 0 || res.checked === 0) break;
      }
      setRecalcNote(`Готово — пересчитано ${totalChecked} фанов за выбранный период.`);
    } catch (e) {
      setRecalcNote(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRecalcBusy(false);
    }
  }

  const body = (
    <>
      {err && <div className="alert" style={{ margin: "0 20px 16px" }}>{err}</div>}
      {loading && !rep && <p className="muted" style={{ padding: "0 20px 20px" }}>Считаю…</p>}
      {rep && (
        <>
          <div className="rs-stats">
            <ReplyStat label="Ответили на приветку" value={rep.pct == null ? "—" : `${rep.pct.toFixed(1)}%`} accent />
            <ReplyStat label="Фанов в статистике" value={`${rep.valid}`} />
            <ReplyStat label="Медиана времени ответа" value={fmtMin(rep.median_reply_seconds)} />
            <ReplyStat label="Ещё считается" value={`${rep.pending}`} />
          </div>
          {rep.pending > 0 && (
            <div className="rs-progress-wrap">
              <div className="rs-progress-bar">
                <div className="rs-progress-fill" style={{ width: `${Math.min(100, (rep.checked / Math.max(1, rep.eligible)) * 100)}%` }} />
              </div>
              <p className="muted rs-note">
                Фоновый процесс досчитывает остальных ({rep.checked}/{rep.eligible}) · не быстрее ~{fmtEta(rep.pending)} —
                цифры обновляются сами каждые 20 сек, воркер общий на всех партнёров. Разбивка по кампаниям — в таблице
                «Кампании» ниже.
              </p>
            </div>
          )}
          {recalcNote && <p className="muted rs-note">{recalcNote}</p>}
        </>
      )}
    </>
  );

  const controls = (
    <div className="an-card-head-actions">
      <DateRangePicker from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
      {partnerId != null && (
        <button type="button" className="btn ghost" onClick={recalculate} disabled={recalcBusy}>
          {recalcBusy ? "Считаю…" : "⟳ Пересчитать"}
        </button>
      )}
    </div>
  );

  /* Пикер — position:absolute, разворачивается НИЖЕ шапки. .an-card рубит
     оверфлоу под скруглённые углы (overflow:hidden) — если пикер внутри
     карточки, выпадашка обрезается тем же краем (нашёл David на скрине).
     Тот же класс бага, что был с попапом share-link раньше в этом же
     проекте — решение то же: вынести абсолютно позиционируемый элемент из
     любого overflow:hidden предка. Заголовок+управление — отдельным баром
     НАД карточкой (как «Итоги за период»), сама карточка — только контент. */
  return (
    <>
      <div className="an-widgets-bar">
        {collapsible ? (
          <div className={`pd-acc-head${open ? " open" : ""}`} style={{ flex: 1 }} onClick={() => setOpen((s) => !s)}>
            <h3>
              Конверсия в ответ <span className="faint">· % фанов, ответивших на приветку</span>
            </h3>
            <span className="pd-acc-caret">▶</span>
          </div>
        ) : (
          <h3 className="an-widgets-title">
            Конверсия в ответ <span className="faint">· % фанов, ответивших на приветку</span>
          </h3>
        )}
        {(!collapsible || open) && controls}
      </div>
      {(!collapsible || open) && <div className="an-card rs-card">{body}</div>}
    </>
  );
}

function ReplyStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rs-stat">
      <div className="an-kpi-label">{label}</div>
      <div className={`rs-stat-val${accent ? " accent" : ""}`}>{value}</div>
    </div>
  );
}
