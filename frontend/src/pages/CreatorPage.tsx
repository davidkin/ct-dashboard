import { useEffect, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import { api, CreatorDetail } from "../api";
import { ActivityChart } from "../components/ActivityChart";
import { Hint } from "../components/Hint";

const fmt = (n: number | null): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");
const money = (n: number | null): string =>
  n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;

const formatDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T") + "Z");
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};

const stripHtml = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export default function CreatorPage() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<CreatorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    api.creator(slug).then(setData).catch((e) => setError(String(e)));
  }, [slug]);

  if (error) return <div className="alert" style={{ color: "#fca5a5" }}>{error}</div>;
  if (!data) return <div className="loading">Загружаю…</div>;

  const { profile, aggregate, top_partners } = data;
  const filterLink = (path: string) => `${path}?creator=${encodeURIComponent(data.name)}`;

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <RouterLink to="/">← К списку партнёров</RouterLink>
      </div>

      {profile?.header && (
        <div
          className="creator-banner"
          style={{ backgroundImage: `url(${profile.header})` }}
        />
      )}

      <div className="card profile-card">
        {profile?.avatar && (
          <img src={profile.avatar} alt={profile.username} className="avatar" />
        )}
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>
            {data.name}
            {profile?.is_verified && (
              <span className="verified" title="OnlyFans verified">✓</span>
            )}
          </h2>
          {profile && (
            <div className="muted" style={{ marginTop: 4 }}>
              <a href={`https://onlyfans.com/${profile.username}`} target="_blank" rel="noopener noreferrer">
                @{profile.username}
              </a>
              {profile.join_date && <> · с {new Date(profile.join_date).toLocaleDateString("ru-RU")}</>}
            </div>
          )}
          {!profile && data.configured && (
            <div className="muted" style={{ marginTop: 4 }}>{data.account_id}</div>
          )}
          {!data.configured && (
            <div className="alert" style={{ marginTop: 8, marginBottom: 0 }}>
              Account ID не задан в <code>.env</code>. Профиль из OnlyFansAPI не подтянулся.
            </div>
          )}
          {data.profile_error && (
            <div className="alert" style={{ marginTop: 8, marginBottom: 0, color: "#fca5a5" }}>
              OF API: {data.profile_error}
            </div>
          )}
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Партнёров" value={String(aggregate.partners_count)} hint="Сколько партнёров льют на эту модель" />
        <Stat label="Ссылок" value={String(aggregate.links_count)} hint="Всего трекинг-ссылок в Glossary под этой моделью" />
        <Stat label="Clicks" value={fmt(aggregate.clicks_total)} hint="Сумма кликов по всем ссылкам этой модели" />
        <Stat label="Subs" value={fmt(aggregate.subs_total)} accent hint="Атрибутированные подписки (окно 90 минут после клика)" />
        <Stat label="Spenders" value={fmt(aggregate.spenders_total)} hint="Подписчики, которые что-то купили" />
        <Stat label="Revenue" value={money(aggregate.revenue_total)} accent hint="Общая выручка от привлечённых фанатов" />
      </div>

      {profile && (
        <div className="card">
          <h2 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>
            Профиль OnlyFans
            <Hint text="Данные подтянуты напрямую из OnlyFansAPI. Обновляются при каждом запросе." />
          </h2>
          <div className="kv">
            <div className="k">Имя на странице</div>
            <div>{profile.name || "—"}</div>
            <div className="k">Username</div>
            <div>
              <a href={`https://onlyfans.com/${profile.username}`} target="_blank" rel="noopener noreferrer">@{profile.username}</a>
            </div>
            <div className="k">Постов / Фото / Видео</div>
            <div>{fmt(profile.posts_count)} / {fmt(profile.photos_count)} / {fmt(profile.videos_count)}</div>
            <div className="k">Верифицирован</div>
            <div>{profile.is_verified ? "Да" : "Нет"}</div>
            <div className="k">Дата регистрации</div>
            <div className="muted">{formatDate(profile.join_date)}</div>
          </div>
        </div>
      )}

      <div className="card">
        <h2 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>
          Топ-10 партнёров по revenue
          <Hint text="Партнёры, которые больше всех привели выручки на эту модель." />
        </h2>
        <table className="data">
          <thead>
            <tr>
              <th>Партнёр</th>
              <th>Telegram</th>
              <th>Тип</th>
              <th>Источник</th>
              <th className="num">Ссылок</th>
              <th className="num">Clicks</th>
              <th className="num">Subs</th>
              <th className="num">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {top_partners.map((p) => (
              <tr key={p.id}>
                <td>
                  <RouterLink to={filterLink(`/partners/${p.id}`)} className="partner-link">{p.display_name}</RouterLink>
                </td>
                <td className="muted">{p.telegram || "—"}</td>
                <td>{p.type ? <span className={`tag ${p.type === "External" ? "ext" : "in"}`}>{p.type}</span> : "—"}</td>
                <td>{p.source || <span className="muted">—</span>}</td>
                <td className="num">{p.links_count}</td>
                <td className="num">{fmt(p.clicks_total)}</td>
                <td className="num">{fmt(p.subs_total)}</td>
                <td className="num">{money(p.revenue_total)}</td>
              </tr>
            ))}
            {top_partners.length === 0 && <tr><td colSpan={8} className="empty">Нет данных</td></tr>}
          </tbody>
        </table>
      </div>

      {profile?.username && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0, fontSize: 15, marginBottom: 8 }}>Описание профиля</h2>
          <div className="muted" style={{ lineHeight: 1.6 }}>
            {profile.is_authenticated ? "Профиль публичный — открой ссылку выше для полного просмотра." : "Профиль не аутентифицирован в OnlyFansAPI."}
          </div>
        </div>
      )}

      {/* Активность модели — В САМОМ НИЗУ под всеми таблицами */}
      <div style={{ marginTop: 32 }}>
        <ActivityChart creator={data.name} title={`Активность модели ${data.name}`} />
      </div>
    </>
  );
}

function Stat({ label, value, accent, hint }: { label: string; value: string; accent?: boolean; hint: string }) {
  return (
    <div className={`stat${accent ? " accent" : ""}`}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        <Hint text={hint} />
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}
