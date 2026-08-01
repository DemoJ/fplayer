import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type BrowseResult, type Media, type Source, type UpNext } from "../api";
import { MediaSection, PosterBg } from "../components";

function UpNextSection({ items, loading }: { items: UpNext[]; loading: boolean }) {
  if (!loading && items.length === 0) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return <section className="media-section">
    <div className="section-heading"><h2>接下来</h2><span>{items.length} 部</span></div>
    {loading ? <div className="empty">正在整理接下来...</div> : <div className="continue-grid">{items.map((item, index) => <article className="media-card" key={item.id}><Link className="poster-card" to={`/watch/${item.id}`}><PosterBg path={item.work_poster} className={`poster art-${index % 6}`}><span>SERIES</span><b>{item.work_poster ? "" : item.work_title.slice(0, 1)}</b></PosterBg><h3>{item.work_title}</h3><p>看完 S{pad(item.from_season)}E{pad(item.from_episode)} · 下一集 S{pad(item.season)}E{pad(item.episode)}</p></Link></article>)}</div>}
  </section>;
}

export function Home() {
  const [sources, setSources] = useState<Source[]>([]);
  const [continued, setContinued] = useState<Media[]>([]);
  const [recent, setRecent] = useState<Media[]>([]);
  const [upNext, setUpNext] = useState<UpNext[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    setLoading(true); setLoadError("");
    Promise.all([
      api<BrowseResult>("/browse").then((data) => setSources(data.sources || [])).catch((e) => { setSources([]); setLoadError((e as Error).message); }),
      api<Media[]>("/continue?limit=12").then(setContinued).catch(() => setContinued([])),
      api<Media[]>("/recent?limit=10").then(setRecent).catch(() => setRecent([])),
      api<UpNext[]>("/up-next?limit=10").then(setUpNext).catch(() => setUpNext([])),
    ]).finally(() => setLoading(false));
  }, []);
  return <main>
    <header className="topbar"><div><span className="eyebrow">PRIVATE CINEMA</span><h1>今晚，看点什么？</h1></div></header>
    <section className="media-section">
      <div className="section-heading"><h2>我的媒体</h2><span>{sources.length} 个</span></div>
      {loading ? <div className="empty">正在载入媒体源...</div> : loadError ? <div className="empty"><strong>媒体源加载失败</strong><span>{loadError}</span></div> : sources.length === 0 ? <div className="empty"><strong>还没有媒体源</strong><span>前往“设置”添加 NAS 或 WebDAV。</span><Link className="text-link" to="/admin">打开设置 →</Link></div> : <div className="source-grid">{sources.map((source, index) => <Link className="source-tile" key={source.id} to={`/browse/${source.id}`}><div className={`source-cover art-${index % 6}`}><span className="source-type">{source.type === "webdav" ? "WebDAV" : "NAS"}</span><b className="source-mark">{source.type === "webdav" ? "W" : "N"}</b><span className="source-count">{source.file_count || 0}<small>个文件</small></span></div><div className="source-meta"><h3>{source.name}</h3><small>{source.base_path}</small></div></Link>)}</div>}
    </section>
    <MediaSection title="最近播放" items={continued} wide emptyText="还没有未看完的内容" />
    <UpNextSection items={upNext} loading={loading} />
    <MediaSection title="最近添加" items={recent} wide emptyText="暂无新增媒体" />
  </main>;
}
