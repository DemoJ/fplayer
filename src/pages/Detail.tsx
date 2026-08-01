import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Media } from "../api";
import { LibraryBack } from "../components";

export function Detail() {
  const { id } = useParams();
  const [item, setItem] = useState<Media>();
  const [error, setError] = useState("");
  useEffect(() => { setItem(undefined); setError(""); api<Media>(`/media/${id}`).then(setItem).catch((e) => setError((e as Error).message)); }, [id]);
  if (error) return <main className="detail"><div className="empty"><strong>载入失败</strong><p>{error}</p><Link className="text-link" to="/" onClick={(e) => { e.preventDefault(); location.reload(); }}>重试</Link></div></main>;
  if (!item) return <div className="empty">载入中...</div>;
  return <main className="detail"><div className="detail-top"><LibraryBack kind={item.kind} /></div><div className="detail-art"><span>{item.kind === "show" ? "ORIGINAL SERIES" : "FEATURE PRESENTATION"}</span><b>{item.title.slice(0, 1)}</b></div><section><span className="eyebrow">{item.kind === "show" ? "剧集" : "电影"} · {item.source_name}</span><h1>{item.title}</h1><p className="meta">{item.container?.toUpperCase() || "VIDEO"}　{item.video_codec || "待探测"}　{item.duration ? `${Math.round(item.duration / 60)} 分钟` : ""}</p><p className="description">来自你的私人媒体库。FPlayer 会通过安全的服务端链路读取文件，并自动保存观看进度。</p><Link className="primary play" to={`/watch/${item.id}`}>{item.position ? "▶ 继续播放" : "▶ 开始播放"}</Link></section></main>;
}
