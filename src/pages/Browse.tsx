import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type BrowseResult } from "../api";

export function BrowseView() {
  const params = useParams();
  const navigate = useNavigate();
  const initialSourceId = Number(params.sourceId || 0);
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [path, setPath] = useState("");
  const [data, setData] = useState<BrowseResult>();
  const [loading, setLoading] = useState(true);

  useEffect(() => { setSourceId(Number(params.sourceId || 0)); setPath(""); setData(undefined); }, [params.sourceId]);
  useEffect(() => {
    if (!sourceId) {
      navigate("/", { replace: true });
      return;
    }
    setLoading(true);
    api<BrowseResult>(`/browse?sourceId=${sourceId}&path=${encodeURIComponent(path)}`).then(setData).finally(() => setLoading(false));
  }, [sourceId, path, navigate]);

  function openFolder(folderPath: string) { setPath(folderPath); }
  function goCrumb(crumbPath: string) { setPath(crumbPath); }

  return <main>
    <header className="topbar">
      <div><span className="eyebrow">FILE BROWSER</span><h1>{data?.source?.name || "浏览媒体"}</h1></div>
      <Link className="back-inline" to="/">← 返回首页</Link>
    </header>
    {loading || !data ? <div className="empty">正在读取目录...</div> : <>
      <div className="crumbs">
        <button type="button" onClick={() => navigate("/")}>我的媒体</button>
        {data.crumbs.map((crumb) => <button type="button" key={`${crumb.path}-${crumb.name}`} onClick={() => goCrumb(crumb.path)}>{crumb.name}</button>)}
      </div>
      <div className="folder-list">
        {data.folders.map((folder) => <button type="button" className="folder-row" key={folder.path} onClick={() => openFolder(folder.path)}>
          <span className="folder-badge">DIR</span><b>{folder.name}</b><small>{folder.file_count} 个文件</small>
        </button>)}
        {data.files.map((file) => <Link className="folder-row file" key={file.id} to={`/watch/${file.id}`}>
          <span className="folder-badge">VID</span>
          <b>{file.name || file.title}</b>
          <small>{file.kind === "show" && file.season ? `S${String(file.season).padStart(2, "0")}E${String(file.episode).padStart(2, "0")}` : file.container?.toUpperCase() || "VIDEO"}{file.size ? ` · ${Math.round(file.size / 1024 / 1024)} MB` : ""}{file.position ? " · 继续" : ""}</small>
        </Link>)}
        {data.folders.length === 0 && data.files.length === 0 && <div className="empty">这个目录下没有媒体文件</div>}
      </div>
    </>}
  </main>;
}
