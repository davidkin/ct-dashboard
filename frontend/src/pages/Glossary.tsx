import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  addGlossaryLinks,
  patchPartner,
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

/** Инициалы для аватарки партнёра — как в таблице аналитики. */
function initials(name: string): string {
  const clean = name.replace(/^@/, "").trim();
  const parts = clean.split(/[\s|]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2);
  return letters.toUpperCase();
}

type ProblemFilter = "all" | "no_cpf" | "untracked" | "not_in_om" | "any";

/** Что именно не так со ссылкой. null — всё в порядке. */
function problemKind(l: GlossaryLink): Exclude<ProblemFilter, "all" | "any"> | null {
  if (!l.cpf) return "no_cpf";
  if (!l.tracked) return "untracked";
  if (l.in_om === false) return "not_in_om";
  return null;
}

const PROBLEM_LABEL: Record<Exclude<ProblemFilter, "all" | "any">, string> = {
  no_cpf: "нет CPF",
  untracked: "нет привязки к OM",
  not_in_om: "нет в OnlyMonster",
};

const SOURCES = ["Instagram", "Facebook", "TikTok", "Telegram", "X", "Reddit", "Other"];

export default function Glossary() {
  const [partners, setPartners] = useState<GlossaryPartner[]>([]);
  const [meta, setMeta] = useState<GlossaryMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState(false);

  const [search, setSearch] = useState("");
  const [model, setModel] = useState("all");
  const [source, setSource] = useState("all");
  const [tier, setTier] = useState<"all" | "free" | "paid">("all");
  /* По умолчанию показываем только активных: потерянные партнёры только мешают. */
  const [status, setStatus] = useState<"all" | "active" | "lost">("active");
  const [type, setType] = useState("all");
  const [problemFilter, setProblemFilter] = useState<ProblemFilter>("all");
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

  /** Источники, которые реально встречаются в данных — их и предлагаем в фильтре. */
  /** Типы партнёров, которые реально встречаются: In-house / External. */
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const p of partners) if (p.type) set.add(p.type);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [partners]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const p of partners) for (const l of p.links) if (l.source) set.add(l.source);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [partners]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return partners
      .map((p) => {
        const links = p.links.filter((l) => {
          if (model !== "all" && l.model !== model) return false;
          if (source !== "all" && (l.source ?? "") !== source) return false;
          if (tier !== "all" && l.tier !== tier) return false;
          if (problemFilter === "any" && !problemKind(l)) return false;
          if (problemFilter !== "all" && problemFilter !== "any" && problemKind(l) !== problemFilter) return false;
          if (!q) return true;
          return (
            l.campaign_code.toLowerCase().includes(q) ||
            p.display_name.toLowerCase().includes(q) ||
            (p.telegram ?? "").toLowerCase().includes(q)
          );
        });
        return { ...p, links };
      })
      .filter((p) => status === "all" || p.status === status)
      .filter((p) => type === "all" || (p.type ?? "") === type)
      .filter((p) => {
        if (p.links.length > 0) return true;
        if (problemFilter !== "all" || model !== "all" || source !== "all" || tier !== "all") return false;
        if (!q) return true;
        return p.display_name.toLowerCase().includes(q) || (p.telegram ?? "").toLowerCase().includes(q);
      });
  }, [partners, search, model, source, tier, problemFilter, status, type]);

  const toggleOpen = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  if (!isAdminConfigured()) {
    return (
      <div className="an fadeUp">
        <div className="an-card">
          <div className="an-card-head">
            <h3>Глоссарий</h3>
          </div>
          <p className="gl-empty">
            Не заданы админ-креды (VITE_ADMIN_USER / VITE_ADMIN_PASS) — страница работает под админом.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="an fadeUp">
      <div className="an-toolbar">
        <div className="seg">
          <button
            type="button"
            className={`seg-btn${model === "all" ? " active" : ""}`}
            onClick={() => setModel("all")}
          >
            Все модели
          </button>
          {(meta?.models ?? []).map((m) => (
            <button
              key={m.group}
              type="button"
              className={`seg-btn${model === m.group ? " active" : ""}`}
              onClick={() => setModel(m.group)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="gl-toolbar-right">
          <button
            type="button"
            className={`btn ghost${verify ? " active" : ""}`}
            disabled={loading}
            onClick={() => {
              const next = !verify;
              setVerify(next);
              void load(next);
            }}
            title="Сверить каждую ссылку с OnlyMonster (медленнее)"
          >
            {verify ? "Сверка с OM: вкл" : "Сверить с OM"}
          </button>
          <button type="button" className="btn" onClick={() => setNewPartner(true)}>
            Новый партнёр
          </button>
        </div>
      </div>

      {error && <p className="pm-err">Ошибка: {error}</p>}
      {meta?.om_errors.map((e) => (
        <p key={e} className="pm-err">
          OM: {e}
        </p>
      ))}

      <div className="an-card">
        <div className="an-card-head">
          <h3>
            Партнёры <span className="faint">· {filtered.length}</span>
          </h3>
          {meta && (
            <div className="an-card-head-actions gl-counters">
              <span className="gl-count">{meta.links} ссылок</span>
              {meta.hidden_links > 0 && (
                <span className="gl-count" title="Ссылки отключённых моделей остаются в базе, но в глоссарии не показываются">
                  скрыто {meta.hidden_links}
                </span>
              )}
              {meta.no_cpf > 0 && <span className="gl-chip-warn">{meta.no_cpf} без CPF</span>}
              {meta.untracked > 0 && <span className="gl-chip-warn">{meta.untracked} без привязки к OM</span>}
              {meta.orphans.length > 0 && <span className="gl-chip-warn">{meta.orphans.length} без партнёра</span>}
            </div>
          )}
        </div>

        <div className="an-table-wrap">
          <table className="an-table gl-partners">
            <thead>
              <tr>
                <th className="an-rownum-h" />
                <th>Партнёр</th>
                <th>Статус</th>
                <th>Источник</th>
                <th className="num">Ссылок</th>
                <th>Проблемы</th>
                <th>Отчёт OM</th>
                <th />
              </tr>
              <tr className="gl-filter-row">
                <th />
                <th>
                  <div className="gl-filter-cell">
                    <div className="input-with-icon gl-head-search">
                      <span className="input-icon">⌕</span>
                      <input
                        className="input"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Партнёр, хэндл, код…"
                      />
                    </div>
                    <select className="input gl-head-filter" value={type} onChange={(e) => setType(e.target.value)}>
                      <option value="all">Все типы партнёров</option>
                      {types.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th>
                  <select
                    className="input gl-head-filter"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as "all" | "active" | "lost")}
                  >
                    <option value="all">Все статусы</option>
                    <option value="active">Active</option>
                    <option value="lost">Lost</option>
                  </select>
                </th>
                <th>
                  <select
                    className="input gl-head-filter"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                  >
                    <option value="all">Все источники</option>
                    {sources.map((src) => (
                      <option key={src} value={src}>
                        {src}
                      </option>
                    ))}
                  </select>
                </th>
                <th className="num">
                  <select
                    className="input gl-head-filter"
                    value={tier}
                    onChange={(e) => setTier(e.target.value as "all" | "free" | "paid")}
                  >
                    <option value="all">Все типы</option>
                    <option value="free">Free</option>
                    <option value="paid">Paid</option>
                  </select>
                </th>
                <th>
                  <select
                    className="input gl-head-filter"
                    value={problemFilter}
                    onChange={(e) => setProblemFilter(e.target.value as ProblemFilter)}
                  >
                    <option value="all">Все ссылки</option>
                    <option value="any">Только проблемные</option>
                    <option value="no_cpf">Без CPF</option>
                    <option value="untracked">Без привязки к OM</option>
                    <option value="not_in_om">Нет в OnlyMonster</option>
                  </select>
                </th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr className="gl-norow">
                  <td colSpan={8} className="muted">
                    Загружаю…
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr className="gl-norow">
                  <td colSpan={8} className="muted">
                    Ничего не найдено.
                  </td>
                </tr>
              )}
              {!loading &&
                filtered.map((p) => {
                  const isOpen = open.has(p.id);
                  const problems = p.links.filter((l) => problemKind(l)).length;
                  return [
                    <tr key={p.id} className={isOpen ? "gl-open" : undefined} onClick={() => toggleOpen(p.id)}>
                      <td className="an-rownum gl-caret">{isOpen ? "▾" : "▸"}</td>
                      <td>
                        <div className="an-partner">
                          <span className="an-ava">{initials(p.display_name)}</span>
                          <div className="an-partner-txt">
                            <span className="an-partner-name">
                              <Link
                                className="gl-partner-link"
                                to={`/partners/${p.id}`}
                                onClick={(e) => e.stopPropagation()}
                                title="Открыть карточку партнёра с его таблицей трафика"
                              >
                                {p.display_name}
                              </Link>
                              <TypeSelect partner={p} types={types} onChanged={() => void load()} />
                            </span>
                            {p.telegram && <span className="an-partner-tg">{p.telegram}</span>}
                          </div>
                        </div>
                      </td>
                      <td>
                        <StatusTag partner={p} onChanged={() => void load()} />
                      </td>
                      <td className="muted">{p.source ?? "—"}</td>
                      <td className="num">{p.links.length}</td>
                      <td>
                        {problems > 0 ? (
                          <span className="gl-chip-warn">{problems}</span>
                        ) : p.status === "active" && p.links.length === 0 ? (
                          <span
                            className="gl-alert"
                            title="Партнёр активен, но у него нет ни одной ссылки — лить ему нечего"
                          >
                            !
                          </span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="gl-om-cell">
                        <OmReportCell partner={p} onChanged={() => void load()} />
                      </td>
                      <td className="gl-actions">
                        <button
                          type="button"
                          className="btn ghost btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAddFor(p);
                          }}
                        >
                          + ссылки
                        </button>
                      </td>
                    </tr>,
                    ...(isOpen
                      ? p.links.length === 0
                        ? [
                            <tr key={`${p.id}-empty`} className="gl-link-row gl-norow">
                              <td />
                              <td colSpan={7} className="muted">
                                Ссылок нет.
                              </td>
                            </tr>,
                          ]
                        : p.links.map((l) => <LinkRow key={l.id} link={l} onChanged={() => void load()} />)
                      : []),
                  ];
                })}
            </tbody>
          </table>
        </div>
      </div>


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

/** Ссылка на shared-отчёт партнёра в OnlyMonster: открыть или вписать/заменить. */
function OmReportCell({ partner, onChanged }: { partner: GlossaryPartner; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(partner.om_report_url ?? "");
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  async function save(e: React.SyntheticEvent) {
    e.stopPropagation();
    const value = url.trim();
    if (value === (partner.om_report_url ?? "")) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await patchPartner(partner.id, { om_report_url: value || null });
      setEditing(false);
      onChanged();
    } catch (e2) {
      setSaveErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <>
      {saveErr && <div className="gl-inline-err pm-err">{saveErr}</div>}
      <input
        className="input gl-om-input"
        autoFocus
        value={url}
        disabled={busy}
        placeholder="https://dashboard.onlymonster.ai/shared-report/…"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save(e);
          if (e.key === "Escape") {
            setUrl(partner.om_report_url ?? "");
            setEditing(false);
          }
        }}
      />
      </>
    );
  }

  return partner.om_report_url ? (
    <span className="gl-om-wrap">
      <a
        className="gl-om-link"
        href={partner.om_report_url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Открыть отчёт партнёра в OnlyMonster"
      >
        отчёт
      </a>
      <button
        type="button"
        className="gl-om-edit"
        title="Изменить ссылку"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        ✎
      </button>
    </span>
  ) : (
    <button
      type="button"
      className="gl-om-add"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      title="Вставить ссылку на shared-отчёт партнёра из OnlyMonster"
    >
      + отчёт
    </button>
  );
}

/** Тип партнёра: In-house / External. Правится прямо в строке. */
function TypeSelect({
  partner,
  types,
  onChanged,
}: {
  partner: GlossaryPartner;
  types: string[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const options = types.length ? types : ["In-house", "External"];
  const value = partner.type ?? "";
  const tone = value.toLowerCase().includes("in-house") ? " in-house" : value ? " external" : "";

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    e.stopPropagation();
    setBusy(true);
    setErr(null);
    try {
      await patchPartner(partner.id, { type: e.target.value || null });
      onChanged();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  if (err) {
    return (
      <span className="gl-inline-err pm-err" title={err}>
        не сохранилось
      </span>
    );
  }

  return (
    <select
      className={`gl-type-select${tone}`}
      value={value}
      disabled={busy}
      onClick={(e) => e.stopPropagation()}
      onChange={change}
      title="Тип партнёра"
    >
      <option value="">тип не задан</option>
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/** Статус партнёра: селект active / lost, сохраняется сразу при выборе. */
function StatusTag({ partner, onChanged }: { partner: GlossaryPartner; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /* Старый бэкенд поля не отдаёт — тогда селекта просто нет. */
  if (!partner.status) return null;

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    e.stopPropagation();
    const next = e.target.value === "active";
    setBusy(true);
    setErr(null);
    try {
      await patchPartner(partner.id, { active: next });
      onChanged();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  if (err) {
    return (
      <span className="gl-inline-err pm-err" title={err}>
        не сохранилось
      </span>
    );
  }

  return (
    <select
      className={`gl-status-select gl-status-${partner.status}`}
      value={partner.status}
      disabled={busy}
      onClick={(e) => e.stopPropagation()}
      onChange={change}
      title="Статус партнёра"
    >
      <option value="active">active</option>
      <option value="lost">lost</option>
    </select>
  );
}

function LinkRow({ link, onChanged }: { link: GlossaryLink; onChanged: () => void }) {
  const kind = problemKind(link);
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

  /* Колонки те же, что у таблицы партнёров: кампания под партнёром, источник
     под источником, CPF в числовой колонке, статус под проблемами. */
  return (
    <tr className="gl-link-row">
      <td />
      <td>
        <div className="gl-link-main">
          <span className="gl-code">{link.campaign_code}</span>
          <span className={`pm-tier pm-tier-${link.tier}`}>{link.tier}</span>
          <span className="gl-model">{link.model ?? link.creator}</span>
        </div>
        <div className="gl-link-sub">
          <a className="gl-link-url" href={link.of_url} target="_blank" rel="noreferrer" title="Открыть ссылку OnlyFans">
            {link.of_url}
          </a>
          {link.of_tracking_link_id !== null && (
            <span className="gl-om-id" title="id трекинг-ссылки в OnlyMonster — по нему сверяется ночной сбор">
              OM {link.of_tracking_link_id}
            </span>
          )}
        </div>
      </td>
      <td />
      <td className="muted">{link.source ?? "—"}</td>
      <td className="num gl-cpf-cell">
        <span className={`gl-cpf-wrap${kind === "no_cpf" || err ? " warn" : ""}`}>
          <span className="gl-cpf-cur">$</span>
          <input
            className="gl-cpf"
            title={kind === "no_cpf" ? "CPF не задан — выплата по этой ссылке считается нулём" : undefined}
            value={cpf}
            disabled={busy}
            onChange={(e) => setCpf(e.target.value)}
            onBlur={saveCpf}
            onKeyDown={(e) => e.key === "Enter" && saveCpf()}
            placeholder="0.00"
          />
        </span>
        {err && <div className="pm-err gl-inline-err">{err}</div>}
      </td>
      <td>
        {kind && kind !== "no_cpf" ? (
          <span className="gl-chip-warn">{PROBLEM_LABEL[kind]}</span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td />
      <td className="gl-actions">
        <button
          type="button"
          className="gl-del"
          disabled={busy}
          onClick={remove}
          title={`Удалить ${link.campaign_code} из глоссария`}
        >
          ✕
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
              <input className="input" value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="1.20" />
            </label>
            <label>
              Источник
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
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
            className="input pm-search"
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
          <button type="button" className="btn" disabled={busy} onClick={submit}>
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
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя" />
            </label>
            <label>
              Telegram
              <input className="input" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@handle" />
            </label>
            <label>
              Источник
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
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
          <button type="button" className="btn" disabled={busy} onClick={submit}>
            {busy ? "Создаю…" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
}
