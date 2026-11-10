import { useEffect, useState } from "react";
import {
  BulkInvoicePlan,
  createBulkInvoices,
  fetchBulkInvoices,
  fetchPayoutReport,
  setPayoutReportSent,
  PayoutReport,
} from "../api";

/* Массовые инвойсы в Notion: по всем партнёрам модели за неделю.
   Цифры — те же, что в таблице трафика; партнёры — только из глоссария.
   Уже созданные на эту дату инвойсы показываем, но не создаём повторно. */

const MODELS = ["Kimi", "Nikki"];
const STATUSES = ["Waiting", "Review", "HOLD", "Paid"];

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
const ddmm = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const money2 = (n: number) => "$" + n.toFixed(2).replace(/\.00$/, "");

export default function BulkInvoices({
  defaultModel,
  onClose,
}: {
  defaultModel?: string;
  onClose: () => void;
}) {
  const [model, setModel] = useState(
    defaultModel && MODELS.includes(defaultModel) ? defaultModel : "Kimi",
  );
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [plan, setPlan] = useState<BulkInvoicePlan | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState("Waiting");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [tab, setTab] = useState<"create" | "report">("create");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetchBulkInvoices(model, week)
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        setWeek(p.week_start);
        setPicked(
          new Set(
            p.rows.filter((r) => r.state === "ready").map((r) => r.partner_id),
          ),
        );
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [model, week, nonce]);

  const ready = plan?.rows.filter((r) => r.state === "ready") ?? [];
  const chosen = ready.filter((r) => picked.has(r.partner_id));
  const sum = chosen.reduce((s, r) => s + r.amount, 0);

  function toggle(id: number) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function submit() {
    if (!plan) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await createBulkInvoices({
        model,
        week_start: plan.week_start,
        partner_ids: chosen.map((x) => x.partner_id),
        status,
      });
      setResult(
        `Создано: ${r.created.length}` +
          (r.skipped.length
            ? `, пропущено: ${r.skipped.length} (${r.skipped.map((s) => s.reason).join("; ")})`
            : ""),
      );
      setNonce((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal bi-wrap" onClick={(e) => e.stopPropagation()}>
        <button
          className="modal-close"
          type="button"
          onClick={onClose}
          title="закрыть"
        >
          ✕
        </button>
        <div className="bi-head">
          <h3 className="bi-title">Инвойсы в Notion за неделю</h3>
          <div className="dm-seg" role="group">
            <button
              className={`dm-seg-btn${tab === "create" ? " active" : ""}`}
              onClick={() => setTab("create")}
            >
              Создание
            </button>
            <button
              className={`dm-seg-btn${tab === "report" ? " active" : ""}`}
              onClick={() => setTab("report")}
            >
              Отчёт
            </button>
          </div>
        </div>

        <div className="bi-controls">
          <label>
            <span className="an-kpi-label">Модель</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="an-kpi-label">Неделя</span>
            <span className="bi-week">
              <button
                className="btn ghost btn-sm"
                disabled={!week}
                onClick={() => week && setWeek(addDays(week, -7))}
              >
                ←
              </button>
              <b>
                {plan
                  ? `${ddmm(plan.week_start)} – ${ddmm(plan.week_end)}`
                  : "…"}
              </b>
              <button
                className="btn ghost btn-sm"
                disabled={!week}
                onClick={() => week && setWeek(addDays(week, 7))}
              >
                →
              </button>
            </span>
          </label>
          {tab === "create" && (
            <label>
              <span className="an-kpi-label">Статус</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
          {tab === "create" && plan && (
            <span className="muted bi-date">
              Дата инвойса: <b>{ddmm(plan.date)}</b>
            </span>
          )}
        </div>

        {tab === "report" && week && <PayoutReportView weekStart={week} />}

        {tab === "create" && err && <div className="alert">{err}</div>}
        {tab === "create" && result && (
          <div className="bi-result">{result}</div>
        )}
        {tab === "create" && loading && !plan && (
          <p className="muted">Считаю…</p>
        )}

        {tab === "create" && plan && (
          <div className="an-table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={
                        ready.length > 0 && chosen.length === ready.length
                      }
                      onChange={(e) =>
                        setPicked(
                          new Set(
                            e.target.checked
                              ? ready.map((r) => r.partner_id)
                              : [],
                          ),
                        )
                      }
                    />
                  </th>
                  <th>Партнёр</th>
                  <th className="num">Фаны</th>
                  <th className="num">Сумма</th>
                  <th>Инвойс</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr
                    key={r.partner_id}
                    className={r.state !== "ready" ? "bi-off" : ""}
                    style={{ cursor: "default" }}
                  >
                    <td>
                      {r.state === "ready" && (
                        <input
                          type="checkbox"
                          checked={picked.has(r.partner_id)}
                          onChange={() => toggle(r.partner_id)}
                        />
                      )}
                    </td>
                    <td>
                      {r.name} <span className="muted">{r.telegram ?? ""}</span>
                    </td>
                    <td className="num">{r.fans}</td>
                    <td className="num accent">{money2(r.amount)}</td>
                    <td>{r.title ?? "—"}</td>
                    <td className="muted">
                      {r.state === "exists"
                        ? "уже есть"
                        : r.state === "no_nick"
                          ? "нет ника"
                          : r.in_notion_partners
                            ? ""
                            : "новый в Partners"}
                    </td>
                  </tr>
                ))}
                {!plan.rows.length && (
                  <tr>
                    <td
                      colSpan={6}
                      className="muted"
                      style={{ textAlign: "center", padding: 24 }}
                    >
                      За неделю нет фанов ни у одного партнёра.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "create" && (
          <div className="bi-foot">
            <span className="muted">
              Выбрано {chosen.length} · {money2(sum)}
            </span>
            <button
              className="btn"
              disabled={busy || !chosen.length}
              onClick={submit}
            >
              {busy ? "Создаю…" : `Создать ${chosen.length} в Notion`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* Отчёт по оплате: блок текста на партнёра (обе модели сложены), кошелёк из
   Notion Partners. Без кошелька — блок подсвечен. */
function PayoutReportView({ weekStart }: { weekStart: string }) {
  const [rep, setRep] = useState<PayoutReport | null>(null);
  const [all, setAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [onlyUnsent, setOnlyUnsent] = useState(false);

  async function toggleSent(nick: string, sent: boolean) {
    setRep(
      (r) =>
        r && {
          ...r,
          items: r.items.map((i) =>
            i.nick === nick ? { ...i, sent_at: sent ? "now" : null } : i,
          ),
        },
    );
    try {
      await setPayoutReportSent(nick, weekStart, sent);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRep(
        (r) =>
          r && {
            ...r,
            items: r.items.map((i) =>
              i.nick === nick ? { ...i, sent_at: sent ? null : "now" } : i,
            ),
          },
      );
    }
  }

  useEffect(() => {
    let alive = true;
    setErr(null);
    setRep(null);
    fetchPayoutReport(weekStart, all)
      .then((r) => alive && setRep(r))
      .catch(
        (e) => alive && setErr(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [weekStart, all]);

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };
  const sep = "\n\n——\n\n";

  return (
    <div className="bi-report">
      <div className="bi-report-bar">
        <label className="bi-check">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />{" "}
          включая Paid
        </label>
        <label className="bi-check">
          <input
            type="checkbox"
            checked={onlyUnsent}
            onChange={(e) => setOnlyUnsent(e.target.checked)}
          />{" "}
          только не отправленные
        </label>
        {rep && (
          <>
            <span className="muted">
              {rep.items.length} партнёров · {money2(rep.total)} · отправлено{" "}
              {rep.items.filter((i) => i.sent_at).length} из {rep.items.length}
            </span>
            <button
              className="btn btn-sm"
              disabled={!rep.items.length}
              onClick={() =>
                copy(
                  "all",
                  "——\n\n" + rep.items.map((i) => i.text).join(sep) + "\n\n——",
                )
              }
            >
              {copied === "all" ? "Скопировано" : "Скопировать всё"}
            </button>
          </>
        )}
      </div>
      {err && <div className="alert">{err}</div>}
      {!rep && !err && <p className="muted">Собираю отчёт…</p>}
      {rep && rep.missing_wallet.length > 0 && (
        <div className="alert">
          Нет кошелька в Notion Partners:{" "}
          {rep.missing_wallet.map((n) => "@" + n).join(", ")}
        </div>
      )}
      {rep && !rep.items.length && (
        <p className="muted">Нет инвойсов к оплате на эту дату.</p>
      )}
      <div className="bi-report-list">
        {rep?.items
          .filter((i) => !onlyUnsent || !i.sent_at)
          .map((i) => (
            <div
              key={i.nick}
              className={`bi-report-item${i.wallet ? "" : " no-wallet"}${i.sent_at ? " sent" : ""}`}
            >
              <pre>{i.text}</pre>
              <div className="bi-report-side">
                <button
                  className={`bi-sent${i.sent_at ? " on" : ""}`}
                  onClick={() => toggleSent(i.nick, !i.sent_at)}
                  title="Отметить, что отчёт отправлен партнёру"
                >
                  {i.sent_at ? "✓ Отправлен" : "Не отправлен"}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => copy(i.nick, i.text)}
                >
                  {copied === i.nick ? "Скопировано" : "Копировать"}
                </button>
                <span className="muted">
                  {i.invoices
                    .map((x) => `${x.title} · ${x.status ?? "—"}`)
                    .join("\n")}
                </span>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
