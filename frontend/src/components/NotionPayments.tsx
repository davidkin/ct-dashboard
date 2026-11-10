import { useEffect, useState } from "react";
import {
  createNotionPayment,
  fetchExportReport,
  fetchPartnerNotion,
  isAdmin,
  PartnerNotion,
  updateNotionPaymentStatus,
} from "../api";

/* Notion на странице партнёра — плавающий виджет в углу (как чат поддержки):
   кошелёк из Partners, инвойсы из Payments со сменой статуса и создание нового. Фаны и сумма подставляются из дашборда за прошлую неделю,
   дата инвойса — понедельник после неё (как в Notion). */

const NOTION_MODELS: Record<string, string> = { Kimi: "Anita", Nikki: "MARIA" };
const STATUSES = ["Waiting", "Review", "HOLD", "Paid"];

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
const ddmm = (day: string | null) => (day ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : "—");
const money2 = (n: number | null) => (n == null ? "—" : "$" + n.toFixed(2).replace(/\.00$/, ""));

export default function NotionPayments({
  partnerId,
  weekStart,
  model,
}: {
  partnerId: number;
  weekStart?: string;
  model?: string;
}) {
  const [data, setData] = useState<PartnerNotion | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    fetchPartnerNotion(partnerId)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [partnerId, nonce]);

  if (data && !data.configured) return null;

  const payments = data?.payments ?? [];
  const p = data?.partner;
  const unpaid = data?.unpaid?.partner ?? 0;

  async function changeStatus(id: string, status: string) {
    setSaving(id);
    setErr(null);
    try {
      const upd = await updateNotionPaymentStatus(id, status);
      setData((d) => d && { ...d, payments: (d.payments ?? []).map((x) => (x.id === id ? { ...x, status: upd.status } : x)) });
      setNonce((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      {open && (
        <div className="nt-panel">
          <div className="nt-panel-head">
            <h3>
              Notion <span className="faint">· выплаты</span>
            </h3>
            <div className="an-card-head-actions">
              {p && (
                <a className="btn ghost btn-sm" href={p.url} target="_blank" rel="noreferrer">
                  Карточка
                </a>
              )}
              {isAdmin() && data?.nick && (
                <button className="btn btn-sm" onClick={() => setFormOpen((s) => !s)}>
                  {formOpen ? "Отмена" : "+ Выплата"}
                </button>
              )}
              <button className="btn ghost btn-sm" onClick={() => setOpen(false)} title="Свернуть">
                ✕
              </button>
            </div>
          </div>

          {data?.unpaid && (
            <div className="nt-unpaid">
              <div>
                <div className="an-kpi-label">Не выплачено партнёру</div>
                <div className="an-kpi-val accent">{money2(data.unpaid.partner)}</div>
              </div>
              <div>
                <div className="an-kpi-label">Не выплачено всего</div>
                <div className="an-kpi-val">{money2(data.unpaid.all)}</div>
              </div>
            </div>
          )}

          <div className="nt-panel-body">
            {err && <div className="alert">{err}</div>}
            {!data && !err && <p className="muted">Загружаю Notion…</p>}
            {data && !data.nick && <p className="muted">У партнёра нет Telegram-ника — не с чем сопоставить Notion.</p>}

            {data?.nick && (
              <div className="nt-wallet muted">
                {p ? (
                  p.wallet ? (
                    <>
                      Кошелёк{p.chain ? ` (${p.chain})` : ""}: <code>{p.wallet}</code>
                      <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(p.wallet).catch(() => {})}>
                        Копировать
                      </button>
                    </>
                  ) : (
                    "Кошелёк в Notion не указан"
                  )
                ) : (
                  "Партнёра нет в Notion Partners — создастся вместе с первой выплатой"
                )}
              </div>
            )}

            {formOpen && data?.nick && (
              <PaymentForm
                partnerId={partnerId}
                weekStart={weekStart}
                defaultModel={model && NOTION_MODELS[model] ? model : "Kimi"}
                next={data.next ?? {}}
                onCreated={() => {
                  setFormOpen(false);
                  setNonce((n) => n + 1);
                }}
              />
            )}

            {data?.nick && (
              <div className="nt-list">
                {payments.slice(0, 20).map((x) => (
                  <div key={x.id} className="nt-item">
                    <div className="nt-item-top">
                      <a href={x.url} target="_blank" rel="noreferrer">
                        {x.title || "—"}
                      </a>
                      <span className="accent">{money2(x.amount)}</span>
                    </div>
                    <div className="nt-item-sub muted">
                      <span>
                        {Object.keys(NOTION_MODELS).find((k) => NOTION_MODELS[k] === x.model) ?? x.model ?? "—"} ·{" "}
                        {ddmm(x.date)} · {x.fans ?? "—"} фанов
                        {x.tx_link && (
                          <>
                            {" · "}
                            <a href={x.tx_link} target="_blank" rel="noreferrer">
                              tx
                            </a>
                          </>
                        )}
                      </span>
                      {isAdmin() ? (
                        <select
                          className={`nt-status nt-st-${(x.status ?? "").toLowerCase()}`}
                          value={x.status ?? ""}
                          disabled={saving === x.id}
                          onChange={(e) => changeStatus(x.id, e.target.value)}
                        >
                          {!x.status && <option value="">—</option>}
                          {STATUSES.map((st) => (
                            <option key={st}>{st}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={`tag nt-st-${(x.status ?? "").toLowerCase()}`}>{x.status ?? "—"}</span>
                      )}
                    </div>
                  </div>
                ))}
                {!payments.length && <p className="muted">В Notion выплат нет.</p>}
              </div>
            )}
          </div>
        </div>
      )}

      <button className={`nt-launcher${open ? " open" : ""}`} onClick={() => setOpen((s) => !s)} title="Выплаты в Notion">
        {open ? "✕" : "$"}
        {!open && unpaid > 0 && <span className="nt-badge">{money2(unpaid)}</span>}
      </button>
    </>
  );
}

function PaymentForm({
  partnerId,
  weekStart,
  defaultModel,
  next,
  onCreated,
}: {
  partnerId: number;
  weekStart?: string;
  defaultModel: string;
  next: Record<string, string>;
  onCreated: () => void;
}) {
  const [model, setModel] = useState(defaultModel);
  const [week, setWeek] = useState(weekStart ?? "");
  const [fans, setFans] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("Waiting");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (weekStart && !week) setWeek(weekStart);
  }, [weekStart, week]);

  /* Подставляем фаны/выплату из дашборда за выбранную неделю (Пн–Вс) и модель. */
  useEffect(() => {
    if (!week) return;
    let alive = true;
    fetchExportReport({ partner: partnerId, from: week, to: addDays(week, 6), all: true, source: "combined", model })
      .then((r) => {
        if (!alive) return;
        setFans(String(r.rows.reduce((s, row) => s + row.total.subs, 0)));
        setAmount(String(Math.round(r.rows.reduce((s, row) => s + row.total.payout, 0) * 100) / 100));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [partnerId, week, model]);

  const date = week ? addDays(week, 7) : "";

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await createNotionPayment(partnerId, {
        model,
        date,
        fans: Number(fans),
        amount: Number(String(amount).replace(",", ".")),
        status,
        notes: notes || undefined,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nt-form">
      <label>
        <span className="an-kpi-label">Модель</span>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {Object.keys(NOTION_MODELS).map((m) => (
            <option key={m} value={m}>
              {m} ({NOTION_MODELS[m]})
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="an-kpi-label">Неделя с (Пн)</span>
        <input type="date" value={week} onChange={(e) => setWeek(e.target.value)} />
      </label>
      <label>
        <span className="an-kpi-label">Фаны</span>
        <input type="number" value={fans} onChange={(e) => setFans(e.target.value)} />
      </label>
      <label>
        <span className="an-kpi-label">Сумма, $</span>
        <input type="text" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        <span className="an-kpi-label">Статус</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="nt-form-notes">
        <span className="an-kpi-label">Заметка</span>
        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="nt-form-foot">
        <span className="muted">
          {next[model] ?? ""} · дата {ddmm(date)}
        </span>
        <button className="btn" onClick={submit} disabled={busy || !date || fans === "" || amount === ""}>
          {busy ? "Создаю…" : "Создать в Notion"}
        </button>
      </div>
      {err && <div className="alert">{err}</div>}
    </div>
  );
}
