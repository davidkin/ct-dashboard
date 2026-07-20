import React, { useEffect, useMemo, useState } from "react";
import { createPartner, fetchOmLinks, isAdminConfigured, NewPartnerLink, OmLink } from "../api";

/* Фаза A: создание партнёра. Линки пока создаются на стороне OM, поэтому кампании
   ВЫБИРАЕМ из списка OM (селект с поиском), а не вводим руками. tier выводим из кода/аккаунта.
   CPF — свойство ПАРТНЁРА. «Таблицу» не трогает. */

const SOURCES = ["Instagram", "Facebook", "TikTok", "Telegram", "Other"];
const NETWORKS = ["BEP-20", "ERC-20", "TRC-20"];

export default function PartnerManage({ onClose }: { onClose: () => void }) {
  const [display_name, setName] = useState("");
  const [telegram, setTelegram] = useState("");
  const [source, setSource] = useState("Instagram");
  const [wallet, setWallet] = useState("");
  const [network, setNetwork] = useState("BEP-20");
  const [monthly_fee, setFee] = useState("");
  const [cpfFree, setCpfFree] = useState("");
  const [cpfPaid, setCpfPaid] = useState("");

  const [omLinks, setOmLinks] = useState<OmLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(true);
  const [linksErr, setLinksErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdminConfigured()) {
      setLoadingLinks(false);
      return;
    }
    fetchOmLinks()
      .then((links) => setOmLinks(links))
      .catch((e) => setLinksErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingLinks(false));
  }, []);

  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return omLinks;
    return omLinks.filter(
      (l) => l.code.toLowerCase().includes(q) || (l.assigned_to ?? "").toLowerCase().includes(q),
    );
  }, [omLinks, search]);

  async function submit() {
    setError(null);
    setResult(null);
    if (!display_name.trim()) return setError("Укажи имя/хэндл партнёра");
    const links: NewPartnerLink[] = omLinks
      .filter((l) => selected.has(l.id))
      .map((l) => ({
        campaign_code: l.code,
        tier: l.tier,
        of_tracking_link_id: l.id,
        of_url: l.url,
        source: source || null,
      }));
    if (!links.length) return setError("Выбери хотя бы одну кампанию из OM");
    setBusy(true);
    try {
      const res = await createPartner({
        partner: {
          display_name: display_name.trim(),
          telegram: telegram.trim() || undefined,
          source: source || undefined,
          wallet: wallet.trim() || undefined,
          network: network || undefined,
          monthly_fee: num(monthly_fee),
          cpf_free: num(cpfFree),
          cpf_paid: num(cpfPaid),
        },
        links,
        mode: "manual", // id уже есть из пикера — резолвить из OM не нужно
      });
      setResult(`Партнёр создан (id ${res.partner_id}), линков: ${res.links_created}.`);
      setSelected(new Set());
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
        <p className="muted">Не заданы админ-креды (VITE_ADMIN_USER / VITE_ADMIN_PASS) в .env.local — запись недоступна.</p>
      </>,
    );
  }

  return shell(
    <>
      <h2>Новый партнёр</h2>

      <section className="pm-section">
        <h3>Данные партнёра</h3>
        <div className="pm-grid">
          <label>Имя / хэндл*<input value={display_name} onChange={(e) => setName(e.target.value)} placeholder="@handle или имя" /></label>
          <label>Telegram<input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@tg" /></label>
          <label>Source
            <select value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map((s) => <option key={s}>{s}</option>)}</select>
          </label>
          <label>Free CPF<input type="number" step="0.1" value={cpfFree} onChange={(e) => setCpfFree(e.target.value)} placeholder="1.5" /></label>
          <label>Paid CPF<input type="number" step="0.1" value={cpfPaid} onChange={(e) => setCpfPaid(e.target.value)} placeholder="3.0" /></label>
          <label>Monthly fee<input type="number" value={monthly_fee} onChange={(e) => setFee(e.target.value)} placeholder="0" /></label>
          <label>Кошелёк<input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x… / адрес" /></label>
          <label>Сеть
            <select value={network} onChange={(e) => setNetwork(e.target.value)}>{NETWORKS.map((n) => <option key={n}>{n}</option>)}</select>
          </label>
        </div>
      </section>

      <section className="pm-section">
        <div className="pm-links-head">
          <h3>Кампании из OM</h3>
          <span className="muted">выбрано: {selected.size}</span>
        </div>
        <input className="pm-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="поиск по коду…" />
        {loadingLinks && <p className="muted">Загружаю линки из OM…</p>}
        {linksErr && <p className="pm-err">OM: {linksErr}</p>}
        {!loadingLinks && !linksErr && (
          <div className="pm-picker">
            {filtered.map((l) => (
              <label key={l.id} className={`pm-pick-row${selected.has(l.id) ? " sel" : ""}`}>
                <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                <span className="pm-pick-code">{l.code}</span>
                <span className={`pm-tier pm-tier-${l.tier}`}>{l.tier}</span>
                <span className="muted pm-pick-stats">{l.clicks} кл · {l.subscribers} фан</span>
                {l.assigned_to && <span className="pm-assigned">уже у: {l.assigned_to}</span>}
              </label>
            ))}
            {!filtered.length && <p className="muted">Ничего не найдено.</p>}
          </div>
        )}
      </section>

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
