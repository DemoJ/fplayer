import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Media, type Work } from "../api";
import { LibraryBack, PosterBg } from "../components";

export function WorkDetail() {
  const { id } = useParams();
  const [data, setData] = useState<{ work: Work; media: Media[] }>();
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedMediaId, setSelectedMediaId] = useState<number>();
  const load = () => api<{ work: Work; media: Media[] }>(`/works/${id}`).then((d) => { setData(d); setLoadError(""); }).catch((e) => setLoadError((e as Error).message));
  useEffect(() => { setData(undefined); setLoadError(""); void load(); }, [id]);
  async function refreshMetadata() {
    if (!id || refreshing) return;
    setRefreshing(true); setMessage("");
    try { await api(`/works/${id}/metadata/refresh`, { method: "POST" }); await load(); setMessage("已更新"); }
    catch (error) { setMessage((error as Error).message); }
    finally { setRefreshing(false); }
  }
  // Manually mark an episode watched (or unwatch it again). Completed rows drop
  // out of 最近播放 and the 接下来 list advances to the next episode, because
  // both derive from the progress table's completed flag.
  async function toggleDone(item: Media) {
    const duration = item.duration ?? item.progress_duration ?? 0;
    const completed = Boolean(item.completed);
    try {
      await api(`/media/${item.id}/progress`, { method: "PUT", body: JSON.stringify({ position: completed ? 0 : duration, duration, completed: !completed }) });
      await load();
    } catch (error) {
      window.alert((error as Error).message);
    }
  }
  if (loadError) return <div className="empty"><strong>载入失败</strong><p>{loadError}</p><button className="text-link" type="button" onClick={() => void load()}>重试</button></div>;
  if (!data) return <div className="empty">载入作品...</div>;
  const seasons = [...new Set(data.media.map((item) => item.season).filter(Boolean))] as number[];
  const selectedMedia = data.media.find((item) => item.id === selectedMediaId) || data.media.find((item) => item.position && !item.completed) || data.media[0];
  const hasMetadata = Boolean(data.work.poster_path && data.work.overview);
  const formatMedia = (item: Media) => [item.container?.toUpperCase() || "VIDEO", item.video_codec?.toUpperCase(), item.duration ? `${Math.round(item.duration / 60)} 分钟` : undefined, item.size ? `${Math.round(item.size / 1024 / 1024)} MB` : undefined].filter(Boolean).join(" · ");
  return <main className="work-detail"><div className="work-detail-top"><LibraryBack kind={data.work.kind} /></div><PosterBg path={data.work.poster_path} className="detail-art"><b>{data.work.poster_path ? "" : data.work.title.slice(0, 1)}</b></PosterBg><section><span className="eyebrow">{data.work.kind === "show" ? "剧集" : "电影"} · {data.work.year || "未匹配年份"}</span><h1>{data.work.title}</h1>{data.work.kind === "movie" && <><p className="meta">{selectedMedia ? formatMedia(selectedMedia) : "暂无可播放文件"}</p><Link className={`primary play work-play ${selectedMedia ? "" : "disabled"}`} to={selectedMedia ? `/watch/${selectedMedia.id}` : "#"} onClick={(e) => { if (!selectedMedia) e.preventDefault(); }}>▶ {selectedMedia?.position && !selectedMedia.completed ? "继续播放" : "开始播放"}</Link></>}<div className={`work-overview ${hasMetadata ? "" : "missing"}`}><p className="description">{data.work.overview || "影片资料尚未匹配完整，匹配后可补齐中文简介和海报。"}</p><div className="metadata-context"><span>{hasMetadata ? "资料由豆瓣匹配" : "缺少影片资料"}</span><button type="button" onClick={refreshMetadata} disabled={refreshing}>{refreshing ? "正在匹配..." : hasMetadata ? "重新匹配" : "匹配影片资料"}</button>{message && <small className={message === "已更新" ? "success" : "error"}>{message}</small>}</div></div>{data.work.kind === "show" ? <div className="episodes">{seasons.map((season) => { const episodes = Object.values(data.media.filter((item) => item.season === season).reduce<Record<string, Media>>((map, item) => { const key = String(item.episode); if (!map[key] || (item.size || 0) > (map[key].size || 0)) map[key] = item; return map; }, {})).sort((a, b) => (a.episode || 0) - (b.episode || 0)); return <div key={season}><h3>第 {season} 季 · {episodes.length} 集</h3>{episodes.map((item) => <div className="episode-row" key={item.id}><Link className={`episode ${item.completed ? "done" : ""}`} to={`/watch/${item.id}`}><span>S{String(item.season).padStart(2, "0")}E{String(item.episode || 0).padStart(2, "0")}</span><b>第 {item.episode} 集{item.position && !item.completed ? " · 继续" : ""}</b><small>{item.size ? `${Math.round(item.size / 1024 / 1024)} MB` : ""}</small></Link><button type="button" className={`episode-done ${item.completed ? "done" : ""}`} title={item.completed ? "已看完，点击取消" : "标记为已看完"} aria-label={item.completed ? "取消已看完" : "标记为已看完"} onClick={(e) => { e.preventDefault(); e.stopPropagation(); void toggleDone(item); }}>{item.completed ? "✓" : "○"}</button></div>)}</div>; })}</div> : data.media.length > 1 && <div className="versions"><h3>选择版本</h3>{data.media.map((item, index) => <button type="button" className={item.id === selectedMedia?.id ? "active" : ""} onClick={() => setSelectedMediaId(item.id)} key={item.id}><span><b>版本 {index + 1}</b><small>{item.path.split("/").pop()}</small></span><em>{formatMedia(item)}</em></button>)}</div>}</section></main>;
}
