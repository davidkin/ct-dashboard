import { useEffect, useMemo, useState } from "react";
import {
  addGlossaryLinks,
  createGlossaryPartner,
  deleteGlossaryLink,
  fetchGlossary,
  fetchOmLinks,
  GlossaryLink,
  GlossaryMeta,
  GlossaryPartner,
  GlossaryValidationError,
  isAdminConfigured,
  OmLink,
  patchLink,
} from "../api";

/* Глоссарий: словарь партнёр → ссылки. Повторяет гугл-таблицу, но строка не может
   «выпасть» из-за пустой ячейки — всё, что не проходит проверку, видно на экране. */

const SOURCES = ["Instagram", "Facebook", "TikTok", "Telegram", "X", "Reddit", "Other"];

export default function Glossary() {
  const [partners, setPartners] = useState<GlossaryPartner[]>([]);
  const [meta, setMeta] = useState<GlossaryMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState(false);

  const [search, setSearch] = useState("");
  const [model, setModel] = useState("all");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const [addFor, setAddFor] = useState<GlossaryPartner | null>(null);
  const [newPartner, setNewPartner] = useState(false);

  async function load(withVerify = verify) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchGlossary(withVerify);
      setPartners(res.data);
      setMeta(res.meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isAdminConfigured()) void load(false);
    else setLoading(false);
  }, []);

  const problem = (l: GlossaryLink): string | null => {
    if (!l.cpf) return "нет CPF";
    if (!l.tracked && !l.retired) return "нет привязки к OM";
    if (l.in_om === false && !l.retired) return "нет в OnlyMonster";
    return null;
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return partners
      .map((p) => {
        const links = p.links.filter((l) => {
          if (model !== "all" && l.model !== model) return false;
          if (onlyProblems && !problem(l)) return false;
          if (!q) return true;
          return (
            l.campaign_code.toLowerCase().includes(q) ||
            p.display_name.toLowerCase().includes(q) ||
            (p.telegram ?? "").toLowerCase().includes(q)
          );
        });
        return { ...p, links };
      })
      .filter((p) => {
        if (p.links.length > 0) return true;
        if (onlyProblems || model !== "all") return false;
        if (!q) return true;
        return p.display_name.toLowerCase().includes(q) || (p.telegram ?? "").toLowerCase().includes(q);
      });
  }, [partners, search, model, onlyProblems]);

  const toggleOpen = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  if (!isAdminConfigured()) {
    return (
      <div className="an fadeUp gl-page">
        <h1 className="gl-title">Глоссарий</h1>
        <p className="muted">
          Не заданы админ-креды (VITE_ADMIN_USER / VITE_ADMIN_PASS) — страница работает только на запись и чтение под админом.
        </p>
      </div>
    );
  }

  return (
    <div className="an fadeUp gl-page">
      <div className="gl-head">
        <div>
          <h1 className="gl-title">Глоссарий</h1>
          {meta && (
            <div className="gl-meta">
              <span>{meta.partners} партнёров</span>
              <span>{meta.links} ссылок</span>
              {meta.no_cpf > 0 && <span className="gl-chip-warn">{meta.no_cpf} без CPF</span>}
              {meta.untracked > 0 && <span className="gl-chip-warn">{meta.untracked} без привязки к OM</span>}
              {meta.orphans.length > 0 && <span className="gl-chip-warn">{meta.orphans.length} без партнёра</span>}
            </div>
          )}
        </div>
        <div className="gl-head-actions">
          <button type="button" className="gl-btn" onClick={() => setNewPartner(true)}>
            Новый партнёр
          </button>
          <button
            type="button"
            className="gl-btn gl-btn-ghost"
            disabled={loading}
            onClick={() => {
              const next = !verify;
              setVerify(next);
              void load(next);
            }}
            title="Сверить каждую ссылку с OnlyMonster (медленнее)"
          >
            {verify ? "Сверка с OM включена" : "Сверить с OM"}
          </button>
        </div>
      </div>

      <div className="gl-filters">
        <input
          className="gl-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="поиск по партнёру, хэндлу или коду кампании…"
        />
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="all">Все модели</option>
          {(meta?.models ?? []).map((m) => (
            <option key={m.group} value={m.group}>
              {m.label}
            </option>
          ))}
        </select>
        <label className="gl-check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          только проблемные
        </label>
      </div>

      {loading && <p className="muted">Загружаю…</p>}
      {error && <p className="pm-err">Ошибка: {error}</p>}
      {meta?.om_errors.map((e) => (
        <p key={e} className="pm-err">
          OM: {e}
        </p>
      ))}

      {!loading &&
        filtered.map((p) => {
          const isOpen = open.has(p.id);
          const problems = p.links.filter((l) => problem(l)).length;
          return (
            <section key={p.id} className={`gl-partner${isOpen ? " open" : ""}`}>
              <header className="gl-partner-head" onClick={() => toggleOpen(p.id)}>
                <span className="gl-caret">{isOpen ? "▾" : "▸"}</span>
                <span className="gl-partner-name">{p.display_name}</span>
                {p.telegram && <span className="gl-partner-tg">{p.telegram}</span>}
                {p.source && <span className="gl-partner-src">{p.source}</span>}
                <span className="gl-partner-count">{p.links.length} ссылок</span>
                {problems > 0 && <span className="gl-chip-warn">{problems} с проблемой</span>}
                <button
                  type="button"
                  className="gl-btn gl-btn-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddFor(p);
                  }}
                >
                  Добавить ссылки
                </button>
              </header>

              {isOpen && (
                <div className="gl-links">
                  {p.links.length === 0 && <p className="muted">Ссылок нет.</p>}
                  {p.links.length > 0 && (
                    <table className="gl-table">
                      <thead>
                        <tr>
                          <th>Кампания</th>
                          <th>Модель</th>
                          <th>Тип</th>
                          <th>CPF</th>
                          <th>Источник</th>
                          <th>Ссылка</th>
                          <th>Статус</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {p.links.map((l) => (
                          <LinkRow key={l.id} link={l} problem={problem(l)} onChanged={() => void load()} />
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </section>
          );
        })}

      {!loading && filtered.length === 0 && <p className="muted">Ничего не найдено.</p>}

      {addFor && (
        <AddLinksModal
          partner={addFor}
          onClose={() => setAddFor(null)}
          onDone={() => {
            setAddFor(null);
            void load();
          }}
        />
      )}
      {newPartner && (
        <NewPartnerModal
          onClose={() => setNewPartner(false)}
          onDone={() => {
            setNewPartner(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function LinkRow({
  link,
  problem,
  onChanged,
}: {
  link: GlossaryLink;
  problem: string | null;
  onChanged: () => void;
}) {
  const [cpf, setCpf] = useState(link.cpf === null ? "" : String(link.cpf));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function saveCpf() {
    const value = Number(cpf.replace(",", "."));
    if (cpf.trim() === "" || !Number.isFinite(value) || value <= 0) {
      setErr("CPF должен быть больше нуля");
      return;
    }
    if (value === link.cpf) return;
    setBusy(true);
    setErr(null);
    try {
      await patchLink(link.id, { [link.cpf_field]: value });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Удалить ${link.campaign_code} из глоссария?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteGlossaryLink(link.id);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={problem ? "gl-row-warn" : undefined}>
      <td className="gl-code">{link.campaign_code}</td>
      <td>{link.model ?? link.creator}</td>
      <td>
        <span className={`pm-tier pm-tier-${link.tier}`}>{link.tier}</span>
      </td>
      <td>
        <input
          className="gl-cpf"
          value={cpf}
          disabled={busy}
          onChange={(e) => setCpf(e.target.value)}
          onBlur={saveCpf}
          onKeyDown={(e) => e.key === "Enter" && saveCpf()}
          placeholder="0.00"
        />
        {err && <div className="pm-err gl-inline-err">{err}</div>}
      </td>
      <td>{link.source ?? "—"}</td>
      <td className="gl-url">
        <a href={link.of_url} target="_blank" rel="noreferrer">
          {link.of_url.replace(/^https?:\/\/(www\.)?onlyfans\.com\//, "")}
        </a>
      </td>
      <td>
        {problem ? (
          <span className="gl-chip-warn">{problem}</span>
        ) : (
          <span className="gl-chip-ok">ок</span>
        )}
      </td>
      <td>
        <button type="button" className="gl-btn gl-btn-ghost gl-btn-small" disabled={busy} onClick={remove}>
          Удалить
        </button>
      </td>
    </tr>
  );
}

function AddLinksModal({
  partner,
  onClose,
  onDone,
}: {
  partner: GlossaryPartner;
  onClose: () => void;
  onDone: () => void;
}) {
  const [omLinks, setOmLinks] = useState<OmLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hideAssigned, setHideAssigned] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cpf, setCpf] = useState("");
  const [source, setSource] = useState(partner.source ?? "Instagram");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Array<{ campaign_code: string; error: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOmLinks()
      .then(setOmLinks)
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return omLinks.filter((l) => {
      if (hideAssigned && l.assigned_to) return false;
      if (!q) return true;
      return l.code.toLowerCase().includes(q) || (l.assigned_to ?? "").toLowerCase().includes(q);
    });
  }, [omLinks, search, hideAssigned]);

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  async function submit() {
    setError(null);
    setErrors([]);
    const value = Number(cpf.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) {
      setError("CPF обязателен и должен быть больше нуля");
      return;
    }
    const picked = omLinks.filter((l) => selected.has(l.id));
    if (picked.length === 0) {
      setError("Выбери хотя бы одну ссылку");
      return;
    }
    setBusy(true);
    try {
      await addGlossaryLinks(
        partner.id,
        picked.map((l) => ({
          campaign_code: l.code,
          creator: l.creator,
          cpf: value,
          source: source || null,
        })),
      );
      onDone();
    } catch (e) {
      if (e instanceof GlossaryValidationError) {
        setError(e.message);
        setErrors(e.errors);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pm-wrap" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} title="закрыть">
          ✕
        </button>
        <h2>Ссылки для «{partner.display_name}»</h2>

        <section className="pm-section">
          <div className="pm-grid">
            <label>
              CPF* за фана
              <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="1.20" />
            </label>
            <label>
              Источник
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {SOURCES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="pm-section">
          <div className="pm-links-head">
            <h3>Ссылки из OnlyMonster</h3>
            <span className="muted">выбрано: {selected.size}</span>
          </div>
          <input
            className="pm-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="поиск по коду…"
          />
          <label className="gl-check">
            <input type="checkbox" checked={hideAssigned} onChange={(e) => setHideAssigned(e.target.checked)} />
            скрыть уже привязанные
          </label>
          {loading && <p className="muted">Загружаю ссылки из OM…</p>}
          {loadErr && <p className="pm-err">OM: {loadErr}</p>}
          {!loading && !loadErr && (
            <div className="pm-picker">
              {filtered.map((l) => (
                <label key={l.id} className={`pm-pick-row${selected.has(l.id) ? " sel" : ""}`}>
                  <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                  <span className="pm-pick-code">{l.code}</span>
                  <span className={`pm-tier pm-tier-${l.tier}`}>{l.tier}</span>
                  <span className="muted pm-pick-stats">
                    {l.creator} · {l.clicks} кл · {l.subscribers} фан
                  </span>
                  {l.assigned_to && <span className="pm-assigned">уже у: {l.assigned_to}</span>}
                </label>
              ))}
              {!filtered.length && <p className="muted">Ничего не найдено.</p>}
            </div>
          )}
        </section>

        <div className="pm-actions">
          <button type="button" className="pm-submit" disabled={busy} onClick={submit}>
            {busy ? "Сохраняю…" : `Добавить ${selected.size || ""}`.trim()}
          </button>
        </div>

        {error && <p className="pm-err">{error}</p>}
        {errors.length > 0 && (
          <ul className="gl-errors">
            {errors.map((e) => (
              <li key={e.campaign_code}>
                <b>{e.campaign_code}</b>: {e.error}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NewPartnerModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [telegram, setTelegram] = useState("");
  const [source, setSource] = useState("Instagram");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Укажи имя партнёра");
      return;
    }
    setBusy(true);
    try {
      await createGlossaryPartner({
        display_name: name.trim(),
        telegram: telegram.trim() || null,
        source,
        force,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pm-wrap" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} title="закрыть">
          ✕
        </button>
        <h2>Новый партнёр</h2>
        <section className="pm-section">
          <div className="pm-grid">
            <label>
              Имя*
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя" />
            </label>
            <label>
              Telegram
              <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@handle" />
            </label>
            <label>
              Источник
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {SOURCES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
        </section>
        {error && (
          <>
            <p className="pm-err">{error}</p>
            {error.includes("Хэндл") && (
              <label className="gl-check">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                всё равно создать отдельного партнёра
              </label>
            )}
          </>
        )}
        <div className="pm-actions">
          <button type="button" className="pm-submit" disabled={busy} onClick={submit}>
            {busy ? "Создаю…" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
}
