import React, { useState } from "react";
import { createPartner, isAdminConfigured, NewPartnerLink } from "../api";

/* Фаза A: создание нового партнёра в приложении (не в Google Sheet).
   Два режима: "auto" (tracking из OM по коду) и "manual" (всё руками).
   Пишет через POST /api/partners. «Таблицу» не трогает — партнёр появится в ней сам. */

type LinkRow = NewPartnerLink & { _id: number };

let rowSeq = 1;
const emptyRow = (): LinkRow => ({
  _id: rowSeq++,
  campaign_code: "",
  tier: "free",
  cpf_free: null,
  cpf_paid: null,
  source: "",
  of_url: "",
});

const SOURCES = ["Instagram", "Facebook", "TikTok", "Telegram", "Other"];

export default function PartnerManage({ onClose }: { onClose: () => void }) {
  const [display_name, setName] = useState("");
  const [telegram, setTelegram] = useState("");
  const [source, setSource] = useState("Instagram");
  const [wallet, setWallet] = useState("");
  const [network, setNetwork] = useState("");
  const [monthly_fee, setFee] = useState<string>("");
  const [rows, setRows] = useState<LinkRow[]>([emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setRow = (id: number, patch: Partial<LinkRow>) =>
    setRows((rs) => rs.map((r) => (r._id === id ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, emptyRow()]);
  const delRow = (id: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r._id !== id) : rs));

  const num = (s: unknown) => (s === "" || s == null ? null : Number(s));

  async function submit() {
    setError(null);
    setResult(null);
    if (!display_name.trim()) return setError("Укажи имя/хэндл партнёра");
    const links = rows
      .filter((r) => r.campaign_code.trim())
      .map((r) => ({
        campaign_code: r.campaign_code.trim(),
        tier: r.tier,
        cpf_free: r.tier === "free" ? num(r.cpf_free) : null,
        cpf_paid: r.tier === "paid" ? num(r.cpf_paid) : null,
        source: r.source || source || null,
        of_url: r.of_url?.trim() || null,
      }));
    if (!links.length) return setError("Добавь хотя бы одну кампанию (campaign_code)");
    setBusy(true);
    try {
      const res = await createPartner({
        partner: {
          display_name: display_name.trim(),
          telegram: telegram.trim() || undefined,
          source: source || undefined,
          wallet: wallet.trim() || undefined,
          network: network.trim() || undefined,
          monthly_fee: monthly_fee === "" ? null : Number(monthly_fee),
        },
        links,
        mode: "auto", // невидимо дорезолвливаем tracking-id из OM по коду; линковку партнёр↔коды ведём вручную
      });
      const warn =
        res.unmatched_om?.length ? ` ⚠️ не нашлись в OM: ${res.unmatched_om.join(", ")}` : "";
      setResult(`Партнёр создан (id ${res.partner_id}), линков: ${res.links_created}.${warn}`);
      // сброс кампаний, партнёрские поля оставляем на случай второй попытки
      setRows([emptyRow()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const shell = (inner: React.ReactNode) => (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pm-wrap" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} title="закрыть">✕</button>
        {inner}
      </div>
    </div>
  );

  if (!isAdminConfigured()) {
    return shell(
      <>
        <h2>Новый партнёр</h2>
        <p className="muted">
          Не заданы админ-креды (VITE_ADMIN_USER / VITE_ADMIN_PASS) в .env.local — запись недоступна.
        </p>
      </>,
    );
  }

  return shell(
    <>
      <h2>Новый партнёр</h2>

      <p className="muted" style={{ margin: "8px 0 4px" }}>
        Заводим партнёра и его кампании вручную (как в глоссарии). tracking-id подтянется из OM
        по campaign_code автоматически; OF-ссылку можно указать вручную, если кода ещё нет в OM.
      </p>

      <div className="pm-grid">
        <label>Имя / хэндл*<input value={display_name} onChange={(e) => setName(e.target.value)} placeholder="@handle или имя" /></label>
        <label>Telegram<input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@tg" /></label>
        <label>Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>Кошелёк<input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x… / адрес" /></label>
        <label>Сеть<input value={network} onChange={(e) => setNetwork(e.target.value)} placeholder="ETH / TRON / BTC…" /></label>
        <label>Monthly fee<input type="number" value={monthly_fee} onChange={(e) => setFee(e.target.value)} placeholder="0" /></label>
      </div>

      <h3>Кампании (линки)</h3>
      <table className="pm-links">
        <thead>
          <tr>
            <th>campaign_code*</th><th>tier</th><th>CPF</th><th>source</th>
            <th>OF-ссылка (опц.)</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r._id}>
              <td><input value={r.campaign_code} onChange={(e) => setRow(r._id, { campaign_code: e.target.value })} placeholder="camp_123 / camp_paid_45" /></td>
              <td>
                <select value={r.tier} onChange={(e) => setRow(r._id, { tier: e.target.value as "free" | "paid" })}>
                  <option value="free">free</option>
                  <option value="paid">paid</option>
                </select>
              </td>
              <td>
                <input
                  type="number" step="0.1" style={{ width: 70 }}
                  value={(r.tier === "free" ? r.cpf_free : r.cpf_paid) ?? ""}
                  onChange={(e) => setRow(r._id, r.tier === "free" ? { cpf_free: e.target.value as never } : { cpf_paid: e.target.value as never })}
                  placeholder="1.5"
                />
              </td>
              <td>
                <select value={r.source ?? ""} onChange={(e) => setRow(r._id, { source: e.target.value })}>
                  <option value="">(как у партнёра)</option>
                  {SOURCES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </td>
              <td><input value={r.of_url ?? ""} onChange={(e) => setRow(r._id, { of_url: e.target.value })} placeholder="https://onlyfans.com/… (если нет в OM)" /></td>
              <td><button type="button" onClick={() => delRow(r._id)} title="удалить">✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="pm-add" onClick={addRow}>+ кампания</button>

      <div className="pm-actions">
        <button type="button" className="pm-submit" disabled={busy} onClick={submit}>
          {busy ? "Создаю…" : "Создать партнёра"}
        </button>
      </div>

      {result && <p className="pm-ok">{result}</p>}
      {error && <p className="pm-err">Ошибка: {error}</p>}
    </>,
  );
}
