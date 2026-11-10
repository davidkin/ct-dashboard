import { useEffect, useState } from "react";
import { createNotionPayment, fetchExportReport, fetchPartnerNotion, isAdmin, PartnerNotion } from "../api";

/* Notion на странице партнёра: кошелёк из Partners, последние инвойсы из Payments
   и создание нового. Фаны и сумма подставляются из дашборда за прошлую неделю,
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
  const [formOpen, setFormOpen] = useState(false);

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

  return (
    <div className="an-card">
      <div className="an-card-head">
        <h3>
          Notion <span className="faint">· выплаты</span>
        </h3>
        <div className="an-card-head-actions">
          {p && (
            <a className="btn ghost btn-sm" href={p.url} target="_blank" rel="noreferrer">
              Карточка партнёра
            </a>
          )}
          {isAdmin() && data?.nick && (
            <button className="btn btn-sm" onClick={() => setFormOpen((s) => !s)}>
              {formOpen ? "Отмена" : "Создать выплату"}
            </button>
          )}
        </div>
      </div>

      {err && <div className="alert" style={{ margin: "0 20px 16px" }}>{err}</div>}
      {!data && !err && <p className="muted" style={{ padding: "0 20px 20px" }}>Загружаю Notion…</p>}
      {data && !data.nick && (
        <p className="muted" style={{ padding: "0 20px 20px" }}>У партнёра нет Telegram-ника — не с чем сопоставить Notion.</p>
      )}

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
        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th>Инвойс</th>
                <th>Модель</th>
                <th>Дата</th>
                <th className="num">Фаны</th>
                <th className="num">Сумма</th>
                <th>Статус</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {payments.slice(0, 10).map((x) => (
                <tr key={x.id} style={{ cursor: "default" }}>
                  <td>
                    <a href={x.url} target="_blank" rel="noreferrer">
                      {x.title || "—"}
                    </a>
                  </td>
                  <td className="muted">
                    {Object.keys(NOTION_MODELS).find((k) => NOTION_MODELS[k] === x.model) ?? x.model ?? "—"}
                  </td>
                  <td>{ddmm(x.date)}</td>
                  <td className="num">{x.fans ?? "—"}</td>
                  <td className="num accent">{money2(x.amount)}</td>
                  <td>
                    <span className={`tag nt-st-${(x.status ?? "").toLowerCase()}`}>{x.status ?? "—"}</span>
                  </td>
                  <td>
                    {x.tx_link ? (
                      <a href={x.tx_link} target="_blank" rel="noreferrer">
                        tx
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {!payments.length && (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 24 }}>
                    В Notion выплат нет.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
