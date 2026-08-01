import { useEffect, useState } from "react";
import { api, type ScanJob, type Source } from "../api";

const emptySourceForm = { name: "", type: "webdav", basePath: "", username: "", password: "" };

type TrashItem = { id: number; title: string; path: string; size?: number; season?: number; episode?: number; kind: string; source_name: string };

export function SourceAdmin({ jobs, refreshJobs }: { jobs: ScanJob[]; refreshJobs: (jobs: ScanJob[]) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [editingId, setEditingId] = useState<number>();
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(emptySourceForm);
  const [meta, setMeta] = useState<{ running: boolean; pending: number; matchedWorks: number; hasCookie?: boolean; avoidRiskControl?: boolean; gapMs?: number; job?: { status: string; phase: string; total: number; processed: number; matched: number; skipped: number; failed: number; current_title?: string; error?: string } | null }>();
  const [doubanForm, setDoubanForm] = useState({ cookies: "", avoidRiskControl: true });
  const [loginInfo, setLoginInfo] = useState<{ isLogined?: boolean; name?: string }>({});
  const [showDouban, setShowDouban] = useState(false);
  const [busyId, setBusyId] = useState<number>();
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const load = () => api<Source[]>("/sources").then(setSources);
  const loadTrash = () => api<TrashItem[]>("/trash").then(setTrash).catch(() => {});
  const loadMeta = () => api<typeof meta>("/metadata/status").then(setMeta).catch(() => {});
  const loadDoubanSettings = () => api<{ cookies: string; avoidRiskControl: boolean }>("/metadata/settings").then((s) => setDoubanForm({ cookies: s.cookies || "", avoidRiskControl: s.avoidRiskControl !== false })).catch(() => {});
  useEffect(() => { load(); loadMeta(); loadDoubanSettings(); loadTrash(); }, []);
  async function restoreTrashItem(id: number) {
    try { await api(`/media/${id}/restore`, { method: "POST" }); setMessage("已从回收站恢复"); await loadTrash(); }
    catch (error) { setMessage((error as Error).message); }
  }
  async function emptyTrash() {
    if (!window.confirm(`确定永久删除回收站中的 ${trash.length} 个文件吗？此操作不可恢复。`)) return;
    try { const result = await api<{ removed: number }>("/trash/empty", { method: "POST" }); setMessage(`已永久删除 ${result.removed} 个文件`); await loadTrash(); }
    catch (error) { setMessage((error as Error).message); }
  }
  async function deleteTrashItem(id: number) {
    if (!window.confirm("确定彻底删除这个文件吗？此操作不可恢复。")) return;
    try { await api(`/trash/${id}`, { method: "DELETE" }); setMessage("已彻底删除"); await loadTrash(); }
    catch (error) { setMessage((error as Error).message); }
  }
  useEffect(() => {
    if (!meta?.running) return;
    const timer = window.setInterval(loadMeta, 1500);
    return () => window.clearInterval(timer);
  }, [meta?.running]);

  function openCreate() {
    setEditingId(undefined);
    setForm(emptySourceForm);
    setShowForm(true);
    setMessage("");
  }
  function openEdit(source: Source) {
    setEditingId(source.id);
    setForm({ name: source.name, type: source.type, basePath: source.base_path, username: source.username || "", password: "" });
    setShowForm(true);
    setMessage("");
  }
  function closeForm() {
    setShowForm(false);
    setEditingId(undefined);
    setForm(emptySourceForm);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api(editingId ? `/sources/${editingId}` : "/sources", { method: editingId ? "PUT" : "POST", body: JSON.stringify(form) });
      setMessage(editingId ? "媒体源已更新" : "媒体源已添加");
      closeForm();
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function action(id: number, name: "test" | "scan") {
    setBusyId(id);
    setMessage(name === "scan" ? "扫描任务已提交" : "正在测试连接...");
    try {
      await api(`/sources/${id}/${name}`, { method: "POST" });
      if (name === "test") setMessage("连接成功");
      else refreshJobs(await api<ScanJob[]>("/scans"));
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusyId(undefined);
    }
  }
  async function stop(job: ScanJob) {
    try {
      await api(`/scans/${job.id}/stop`, { method: "POST" });
      setMessage("正在停止扫描...");
      refreshJobs(await api<ScanJob[]>("/scans"));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function remove(source: Source) {
    if (!window.confirm(`确定删除「${source.name}」吗？\n对应媒体记录与观看进度也会删除。`)) return;
    try {
      await api(`/sources/${source.id}`, { method: "DELETE" });
      if (editingId === source.id) closeForm();
      setMessage("媒体源已删除");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function refreshMetadata() {
    try {
      await api("/metadata/refresh", { method: "POST" });
      setMessage("元数据匹配已在后台运行");
      await loadMeta();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function stopMetadata() {
    try {
      await api("/metadata/stop", { method: "POST" });
      setMessage("正在停止匹配...");
      await loadMeta();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function saveDouban() {
    try {
      await api("/metadata/settings", { method: "PUT", body: JSON.stringify(doubanForm) });
      setMessage("豆瓣 Cookie 已保存");
      await loadMeta();
      await loadDoubanSettings();
    } catch (error) {
      setMessage((error as Error).message);
      throw error;
    }
  }
  async function checkLogin() {
    try {
      const info = await api<{ isLogined: boolean; name: string }>("/metadata/check-login", { method: "POST" });
      setLoginInfo(info);
      setMessage(info.isLogined ? `豆瓣已登录：${info.name}` : "豆瓣未登录或 Cookie 无效");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  const metaJob = meta?.job;
  const metaRunning = Boolean(meta?.running);
  const metaPercent = metaJob && metaJob.total ? Math.round((metaJob.processed / metaJob.total) * 100) : 0;

  return <main className="admin-page">
    <header className="topbar">
      <div>
        <span className="eyebrow">CONTROL ROOM</span>
        <h1>设置</h1>
      </div>
      <button className="primary" onClick={openCreate}>＋ 添加媒体源</button>
    </header>

    {message && <div className="admin-toast">{message}<button type="button" aria-label="关闭" onClick={() => setMessage("")}>×</button></div>}

    <section className="admin-stats">
      <article className="stat-card">
        <span>媒体源</span>
        <strong>{sources.length}</strong>
      </article>
      <article className="stat-card">
        <span>已匹配</span>
        <strong>{meta?.matchedWorks ?? 0}</strong>
      </article>
      <article className="stat-card">
        <span>待匹配</span>
        <strong>{meta?.pending ?? 0}</strong>
      </article>
      <article className="stat-card meta-card">
        <div className="meta-head">
          <div>
            <span>豆瓣元数据</span>
            <p>{metaRunning ? (metaJob?.current_title ? `正在匹配：${metaJob.current_title}` : "匹配进行中") : "后台异步 · 已匹配自动跳过"}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button className="ghost" type="button" onClick={() => { setShowDouban(true); loadDoubanSettings(); }}>Cookie</button>
            {metaRunning
              ? <button className="ghost danger" onClick={stopMetadata}>停止</button>
              : <button className="ghost accent" onClick={refreshMetadata}>开始匹配</button>}
          </div>
        </div>
        {metaRunning && <div className="progress-bar"><i style={{ width: `${metaPercent}%` }} /><em>{metaPercent}%</em></div>}
        {!metaRunning && metaJob?.status === "completed" && <small>上次完成：新增 {metaJob.matched} · 跳过 {metaJob.skipped} · 失败 {metaJob.failed}</small>}
        {!metaRunning && metaJob?.status === "failed" && <small className="error-text">{metaJob.error || "匹配失败"}</small>}
        <small>{meta?.hasCookie ? "已配置 Cookie" : "未配置 Cookie"} · 间隔 {meta?.gapMs ?? 5000}ms · {meta?.avoidRiskControl === false ? "防封禁关" : "防封禁开"}</small>
      </article>
    </section>

    {showDouban && <div className="drawer-mask" onClick={() => setShowDouban(false)}>
      <form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void saveDouban().then(() => setShowDouban(false)); }}>
        <div className="drawer-head">
          <div>
            <span className="eyebrow">DOUBAN</span>
            <h2>设置豆瓣 Cookie</h2>
          </div>
          <button type="button" className="icon-close" aria-label="关闭" onClick={() => setShowDouban(false)}>×</button>
        </div>
        <p className="drawer-desc">浏览器登录 movie.douban.com 后，复制 Cookie 粘贴到这里并保存。保存后可点「检测登录」验证。</p>
        <label>豆瓣 Cookie<textarea rows={6} value={doubanForm.cookies} onChange={(e) => setDoubanForm({ ...doubanForm, cookies: e.target.value })} placeholder='bid=xxx; dbcl2="xxx"; ck=xxx; ...' required /></label>
        <label className="checkbox-row">
          <input type="checkbox" checked={doubanForm.avoidRiskControl} onChange={(e) => setDoubanForm({ ...doubanForm, avoidRiskControl: e.target.checked })} />
          <span>开启防封禁（未登录约 5s/次，登录约 3s/次）</span>
        </label>
        <div className="drawer-actions">
          <button type="button" className="ghost" onClick={checkLogin}>检测登录</button>
          <button type="button" className="secondary" onClick={() => setShowDouban(false)}>取消</button>
          <button className="primary" type="submit">保存 Cookie</button>
        </div>
        {loginInfo.isLogined !== undefined && <small style={{ color: "#7d7a73" }}>{loginInfo.isLogined ? `当前登录：${loginInfo.name || "已登录"}` : "当前未登录或 Cookie 无效"}</small>}
      </form>
    </div>}

    <section className="source-board">
      <div className="section-heading"><h2>已连接存储</h2><span>{sources.length} 个</span></div>
      {sources.length === 0 ? <div className="empty-card"><strong>尚未添加媒体源</strong><p>连接 NAS 目录或 WebDAV 后即可扫描入库。</p><button className="primary" onClick={openCreate}>添加第一个媒体源</button></div> : <div className="source-cards">{sources.map((source) => {
        const job = jobs.find((item) => item.source_id === source.id && ["queued", "running"].includes(item.status));
        const scanPercent = job?.phase === "indexing" && job.discovered ? Math.round(job.processed / job.discovered * 100) : undefined;
        const busy = busyId === source.id;
        return <article className={`source-card ${job ? "is-scanning" : ""}`} key={source.id}>
          <div className="source-card-main">
            <div className="source-icon">{source.type === "webdav" ? "W" : "N"}</div>
            <div className="source-info">
              <div className="source-title-row">
                <h3>{source.name}</h3>
                <span className="source-tag">{source.type === "webdav" ? "WebDAV" : "本地"}</span>
              </div>
              <p>{source.base_path}</p>
              <small>{source.last_scan_at ? `上次扫描 ${source.last_scan_at}` : "尚未扫描"}{source.last_error ? ` · ${source.last_error}` : ""}</small>
              {job && <div className="progress-bar scan"><i style={{ width: `${scanPercent ?? 35}%` }} /><em>{job.phase === "indexing" ? `索引 ${job.processed}/${job.discovered}` : job.phase === "discovering" ? `发现 ${job.discovered}` : "扫描中"}</em></div>}
            </div>
          </div>
          <div className="source-toolbar">
            {job
              ? <button className="ghost danger" onClick={() => stop(job)}>停止扫描</button>
              : <>
                <button className="ghost" disabled={busy} onClick={() => action(source.id, "test")}>测试</button>
                <button className="ghost accent" disabled={busy} onClick={() => action(source.id, "scan")}>扫描</button>
                <button className="ghost" onClick={() => openEdit(source)}>编辑</button>
                <button className="ghost danger" onClick={() => remove(source)}>删除</button>
              </>}
          </div>
        </article>;
      })}</div>}
    </section>

    <section className="source-board">
      <div className="section-heading"><h2>回收站</h2><span>{trash.length} 项</span></div>
      {trash.length === 0 ? <div className="empty-card"><strong>回收站为空</strong><p>删除的媒体文件会先移到这里，可恢复或永久删除。</p></div> : <>
        <div className="trash-actions"><button className="ghost danger" type="button" onClick={() => void emptyTrash()}>清空回收站</button></div>
        <div className="work-files-list">{trash.map((item) => <div className="work-file-row" key={item.id}><div><strong>{item.kind === "show" && item.season ? `S${String(item.season).padStart(2, "0")}E${String(item.episode || 0).padStart(2, "0")}` : item.title}</strong><small>{item.path} · {item.source_name}</small></div><div className="trash-actions-inline"><button className="ghost" type="button" onClick={() => void restoreTrashItem(item.id)}>恢复</button><button className="ghost danger" type="button" onClick={() => void deleteTrashItem(item.id)}>彻底删除</button></div></div>)}</div>
      </>}
    </section>

    {showForm && <div className="drawer-mask" onClick={closeForm}>
      <form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="drawer-head">
          <div>
            <span className="eyebrow">{editingId ? "EDIT SOURCE" : "NEW SOURCE"}</span>
            <h2>{editingId ? "编辑媒体源" : "添加媒体源"}</h2>
          </div>
          <button type="button" className="icon-close" aria-label="关闭" onClick={closeForm}>×</button>
        </div>
        <p className="drawer-desc">{editingId ? "留空密码将保留原凭证。修改后建议重新测试并扫描。" : "凭证会加密保存在 NAS 数据目录中。"}</p>
        <label>显示名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：家庭影院" required /></label>
        <label>存储类型<select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="webdav">WebDAV</option><option value="local">NAS 本地目录</option></select></label>
        <label>{form.type === "webdav" ? "WebDAV 地址" : "容器内目录"}<input value={form.basePath} onChange={(e) => setForm({ ...form, basePath: e.target.value })} placeholder={form.type === "webdav" ? "https://dav.example.com/media/" : "/media"} required /></label>
        {form.type === "webdav" && <>
          <label>用户名<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label>密码 / Token<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={editingId ? "留空则不修改" : ""} /></label>
        </>}
        <div className="drawer-actions">
          <button type="button" className="secondary" onClick={closeForm}>取消</button>
          <button className="primary" type="submit">{editingId ? "保存修改" : "添加"}</button>
        </div>
      </form>
    </div>}
  </main>;
}
