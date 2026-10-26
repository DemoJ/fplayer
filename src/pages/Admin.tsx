import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type ScanJob, type Source, type User } from "../api";
import { useCloseOnOutside } from "../components";
import { SettingsDrawer } from "./SettingsDrawer";
import "./Admin.css";

type SettingsTab = "sources" | "matching" | "account";
type AutoSyncSettings = { enabled: boolean; intervalMinutes: number };
type DoubanSettings = { cookies: string; avoidRiskControl: boolean };
type MetadataStatus = {
  running: boolean; pending: number; matchedWorks: number;
  hasCookie?: boolean; avoidRiskControl?: boolean; gapMs?: number;
  job?: { status: string; phase: string; total: number; processed: number; matched: number; skipped: number; failed: number; current_title?: string; error?: string } | null;
};
type IconName = "plus" | "refresh" | "more" | "check" | "alert" | "arrow" | "database" | "folder" | "shield";

function SettingsIcon({ name }: { name: IconName }) {
  const shapes: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3h.01" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></>,
    folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
  };
  return <svg className="settings-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}

const emptySourceForm = { name: "", type: "webdav", basePath: "", username: "", password: "" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";

export function SourceAdmin({ user, jobs, refreshJobs }: { user: User; jobs: ScanJob[]; refreshJobs: (jobs: ScanJob[]) => void }) {
  const isAdmin = user.role === "admin";
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab: SettingsTab = requestedTab === "account" ? "account" : requestedTab === "matching" && isAdmin ? "matching" : "sources";
  const tabs: { id: SettingsTab; label: string }[] = [{ id: "sources", label: "媒体源" }, ...(isAdmin ? [{ id: "matching" as const, label: "元数据匹配" }] : []), { id: "account", label: "账户与安全" }];
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState("");
  const [editingId, setEditingId] = useState<number>();
  const [showForm, setShowForm] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [form, setForm] = useState(emptySourceForm);
  const [formSnapshot, setFormSnapshot] = useState(emptySourceForm);
  const [menuId, setMenuId] = useState<number>();
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const [busyId, setBusyId] = useState<number>();
  const [stoppingId, setStoppingId] = useState<number>();
  const [meta, setMeta] = useState<MetadataStatus>();
  const [metaError, setMetaError] = useState("");
  const [metaBusy, setMetaBusy] = useState(false);
  const [doubanForm, setDoubanForm] = useState<DoubanSettings>({ cookies: "", avoidRiskControl: true });
  const [doubanSnapshot, setDoubanSnapshot] = useState<DoubanSettings>({ cookies: "", avoidRiskControl: true });
  const [doubanLoading, setDoubanLoading] = useState(false);
  const [doubanLoaded, setDoubanLoaded] = useState(false);
  const [doubanSaving, setDoubanSaving] = useState(false);
  const [doubanError, setDoubanError] = useState("");
  const [loginInfo, setLoginInfo] = useState<{ isLogined: boolean; name: string }>();
  const [checkingLogin, setCheckingLogin] = useState(false);
  const [showDouban, setShowDouban] = useState(false);
  const [riskSaving, setRiskSaving] = useState(false);
  const [autoSync, setAutoSync] = useState<AutoSyncSettings>();
  const [syncState, setSyncState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [syncError, setSyncError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });

  useCloseOnOutside(menuId, setMenuId, ".settings-source-menu, .settings-more");

  async function loadSources() {
    setSourcesLoading(true);
    try { setSources(await api<Source[]>("/sources")); setSourcesError(""); }
    catch (error) { setSourcesError(errorMessage(error)); }
    finally { setSourcesLoading(false); }
  }
  async function loadMeta() {
    try { setMeta(await api<MetadataStatus>("/metadata/status")); setMetaError(""); }
    catch (error) { setMetaError(errorMessage(error)); }
  }
  async function loadAutoSync() {
    setSyncState("loading");
    try { setAutoSync(await api<AutoSyncSettings>("/settings/auto-sync")); setSyncState("idle"); setSyncError(""); }
    catch (error) { setSyncState("error"); setSyncError(errorMessage(error)); }
  }
  useEffect(() => { void loadSources(); void loadAutoSync(); if (isAdmin) void loadMeta(); }, [isAdmin]);
  useEffect(() => {
    if (!meta?.running) return;
    const timer = window.setInterval(() => void loadMeta(), 1500);
    return () => window.clearInterval(timer);
  }, [meta?.running]);
  // Refresh timestamps and matching counts when a background scan finishes.
  const scanStates = jobs.map((job) => `${job.id}:${job.status}`).join(",");
  useEffect(() => {
    if (jobs.some((job) => ["completed", "failed", "cancelled"].includes(job.status))) {
      void loadSources(); if (isAdmin) void loadMeta();
    }
  }, [scanStates, isAdmin]);

  function selectTab(tab: SettingsTab) {
    const next = new URLSearchParams(searchParams);
    if (tab === "sources") next.delete("tab"); else next.set("tab", tab);
    setSearchParams(next, { replace: true }); setMenuId(undefined); setMessage(undefined);
  }
  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault(); selectTab(tabs[next].id);
    document.getElementById(`settings-tab-${tabs[next].id}`)?.focus();
  }
  function openCreate() { setEditingId(undefined); setForm(emptySourceForm); setFormSnapshot(emptySourceForm); setSourceError(""); setShowForm(true); }
  function openEdit(source: Source) {
    document.getElementById(`settings-source-more-${source.id}`)?.focus();
    setMenuId(undefined); setEditingId(source.id);
    const next = { name: source.name, type: source.type, basePath: source.base_path, username: source.username || "", password: "" };
    setForm(next); setFormSnapshot(next);
    setSourceError(""); setShowForm(true);
  }
  function closeForm() { setShowForm(false); setEditingId(undefined); setForm(emptySourceForm); setSourceError(""); }
  async function submitSource(event: FormEvent) {
    event.preventDefault();
    if (sourceSaving) return;
    setSourceSaving(true); setSourceError("");
    try {
      const payload = { ...form, name: form.name.trim(), basePath: form.basePath.trim(), ...(form.type === "local" ? { username: "", password: "" } : {}) };
      if (!payload.name || !payload.basePath) { setSourceError("请填写显示名称和媒体源地址"); return; }
      await api(editingId ? `/sources/${editingId}` : "/sources", { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) });
      setMessage({ text: editingId ? "媒体源已更新" : "媒体源已添加，可以开始扫描了" });
      closeForm(); await loadSources();
    } catch (error) { setSourceError(errorMessage(error)); }
    finally { setSourceSaving(false); }
  }
  async function action(id: number, name: "test" | "scan") {
    setBusyId(id); setMenuId(undefined);
    if (name === "test") setMessage({ text: "正在测试连接…" });
    try {
      await api(`/sources/${id}/${name}`, { method: "POST" });
      setMessage({ text: name === "test" ? "连接成功" : "扫描任务已提交" });
      if (name === "scan") refreshJobs(await api<ScanJob[]>("/scans"));
      await loadSources();
    } catch (error) { setMessage({ text: errorMessage(error), error: true }); }
    finally { setBusyId(undefined); }
  }
  async function stop(job: ScanJob) {
    setStoppingId(job.id);
    try { await api(`/scans/${job.id}/stop`, { method: "POST" }); setMessage({ text: "正在停止扫描…" }); refreshJobs(await api<ScanJob[]>("/scans")); }
    catch (error) { setMessage({ text: errorMessage(error), error: true }); }
    finally { setStoppingId(undefined); }
  }
  async function remove(source: Source) {
    setMenuId(undefined);
    if (!window.confirm(`确定删除「${source.name}」吗？\n对应媒体记录与观看进度也会删除。`)) return;
    setBusyId(source.id);
    try { await api(`/sources/${source.id}`, { method: "DELETE" }); setMessage({ text: "媒体源已删除" }); await loadSources(); if (isAdmin) await loadMeta(); }
    catch (error) { setMessage({ text: errorMessage(error), error: true }); }
    finally { setBusyId(undefined); }
  }
  async function saveAutoSync(next: AutoSyncSettings) {
    if (!autoSync || syncState === "saving") return;
    const previous = autoSync;
    setAutoSync(next); setSyncState("saving"); setSyncError("");
    try { setAutoSync(await api<AutoSyncSettings>("/settings/auto-sync", { method: "PUT", body: JSON.stringify(next) })); setSyncState("saved"); }
    catch (error) { setAutoSync(previous); setSyncState("error"); setSyncError(errorMessage(error)); }
  }
  async function metadataAction(name: "refresh" | "stop") {
    setMetaBusy(true);
    try { await api(`/metadata/${name}`, { method: "POST" }); setMessage({ text: name === "refresh" ? "元数据匹配已在后台运行" : "正在停止匹配…" }); await loadMeta(); }
    catch (error) { setMessage({ text: errorMessage(error), error: true }); }
    finally { setMetaBusy(false); }
  }
  async function openDouban() {
    setDoubanError(""); setLoginInfo(undefined); setDoubanLoading(true); setDoubanLoaded(false); setShowDouban(true);
    try { const settings = await api<DoubanSettings>("/metadata/settings"); setDoubanForm(settings); setDoubanSnapshot(settings); setDoubanLoaded(true); }
    catch (error) { setDoubanError(errorMessage(error)); }
    finally { setDoubanLoading(false); }
  }
  function closeDouban() { setShowDouban(false); setDoubanForm({ cookies: "", avoidRiskControl: true }); }
  async function saveDouban(event: FormEvent) {
    event.preventDefault();
    if (!doubanLoaded || doubanSaving) return;
    setDoubanSaving(true); setDoubanError("");
    try {
      await api("/metadata/settings", { method: "PUT", body: JSON.stringify(doubanForm) });
      setMessage({ text: doubanForm.cookies.trim() ? "豆瓣 Cookie 已保存" : "豆瓣 Cookie 已清除" });
      closeDouban(); setLoginInfo(undefined); await loadMeta();
    } catch (error) { setDoubanError(errorMessage(error)); }
    finally { setDoubanSaving(false); }
  }
  async function checkLogin() {
    setCheckingLogin(true);
    try { setLoginInfo(await api<{ isLogined: boolean; name: string }>("/metadata/check-login", { method: "POST" })); }
    catch (error) { setMessage({ text: errorMessage(error), error: true }); }
    finally { setCheckingLogin(false); }
  }
  async function saveRiskControl(enabled: boolean) {
    if (!meta || riskSaving) return;
    const previous = meta;
    setRiskSaving(true); setMeta({ ...meta, avoidRiskControl: enabled });
    try { await api("/metadata/settings", { method: "PUT", body: JSON.stringify({ avoidRiskControl: enabled }) }); await loadMeta(); }
    catch (error) { setMeta(previous); setMessage({ text: errorMessage(error), error: true }); }
    finally { setRiskSaving(false); }
  }
  function openPassword() { setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" }); setPasswordError(""); setShowPassword(true); }
  function closePassword() { setShowPassword(false); setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" }); setPasswordError(""); }
  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (passwordSaving) return;
    setPasswordError("");
    if (passwordForm.newPassword !== passwordForm.confirmPassword) { setPasswordError("两次输入的新密码不一致"); return; }
    setPasswordSaving(true);
    try {
      await api("/me/password", { method: "POST", body: JSON.stringify({ currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword }) });
      setMessage({ text: "密码已修改，其他设备的登录已失效" }); closePassword();
    } catch (error) { setPasswordError(errorMessage(error)); }
    finally { setPasswordSaving(false); }
  }

  const metaJob = meta?.job;
  const metaRunning = Boolean(meta?.running);
  const metaPercent = metaJob?.total ? Math.max(0, Math.min(100, Math.round(metaJob.processed / metaJob.total * 100))) : 0;

  return <main className="settings-page">
    <div className="settings-container">
      <header className="settings-page-heading"><h1>设置</h1><p>管理媒体库与账户偏好</p></header>
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`settings-tab-${tab.id}`} aria-selected={activeTab === tab.id} aria-controls={`settings-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => selectTab(tab.id)} onKeyDown={(event) => tabKeyDown(event, index)}>
          {tab.label}{tab.id === "matching" && Boolean(meta?.pending) && <span className="settings-count settings-count-accent">{meta!.pending}</span>}
        </button>)}
      </div>
      {message && <div className={`settings-notice${message.error ? " is-error" : ""}`} role={message.error ? "alert" : "status"}><span>{message.text}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage(undefined)}>×</button></div>}

      <section id="settings-panel-sources" role="tabpanel" aria-labelledby="settings-tab-sources" hidden={activeTab !== "sources"}>
        <div className="settings-section-heading"><h2>已连接的媒体源{!sourcesLoading && !sourcesError && <span className="settings-count">{sources.length}</span>}</h2>{isAdmin && <button type="button" className="settings-button is-primary" onClick={openCreate}><SettingsIcon name="plus" />添加媒体源</button>}</div>
        {sourcesError ? <div className="settings-empty is-error" role="alert"><strong>媒体源加载失败</strong><p>{sourcesError}</p><button type="button" className="settings-button" onClick={() => void loadSources()}>重新加载</button></div>
          : sourcesLoading && sources.length === 0 ? <div className="settings-empty" role="status">正在读取媒体源…</div>
          : sources.length === 0 ? <div className="settings-empty"><span className="settings-empty-icon"><SettingsIcon name="folder" /></span><h3>连接你的第一个媒体源</h3><p>添加 WebDAV 或 NAS 本地目录，开始整理你的媒体库。</p>{isAdmin && <button type="button" className="settings-button" onClick={openCreate}><SettingsIcon name="plus" />添加媒体源</button>}</div>
          : <div className="settings-source-list">{sources.map((source) => {
            const job = jobs.find((item) => item.source_id === source.id && ["queued", "running"].includes(item.status));
            const scanPercent = job?.phase === "indexing" && job.discovered ? Math.min(100, Math.round(job.processed / job.discovered * 100)) : undefined;
            const busy = busyId === source.id;
            return <article className={`settings-source-card${job ? " is-scanning" : ""}`} key={source.id}>
              <div className="settings-source-main"><span className="settings-source-icon" aria-hidden="true">{source.type === "webdav" ? "W" : "N"}</span><div className="settings-source-info"><div className="settings-source-title"><h3>{source.name}</h3><span className="settings-tag">{source.type === "webdav" ? "WebDAV" : "本地目录"}</span></div><p>{source.base_path}</p></div><span className={`settings-source-status${source.last_error ? " is-error" : ""}`}><SettingsIcon name={source.last_error ? "alert" : "check"} />{job ? "扫描中" : source.last_error ? "需要检查" : "已配置"}</span></div>
              {source.last_error && <p className="settings-source-error">{source.last_error}</p>}
              {job && <div className="settings-scan-progress" aria-live="polite"><div className="settings-progress-label"><span>{job.status === "queued" ? "等待扫描" : job.phase === "indexing" ? `正在索引 ${job.processed} / ${job.discovered}` : job.phase === "discovering" ? `正在发现文件 · 已发现 ${job.discovered} 项` : "正在扫描媒体源"}</span>{scanPercent !== undefined && <span>{scanPercent}%</span>}</div><div className={`settings-progress-track${scanPercent === undefined ? " is-indeterminate" : ""}`} role="progressbar" aria-label={`${source.name}扫描进度`} aria-valuenow={scanPercent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${scanPercent ?? 35}%` }} /></div></div>}
              <div className="settings-source-footer"><span className="settings-caption">{source.last_scan_at ? `上次扫描 · ${source.last_scan_at}` : "尚未扫描"}</span>{isAdmin && <div className="settings-source-actions">{job ? <button type="button" className="settings-button is-danger" disabled={stoppingId === job.id} onClick={() => void stop(job)}>{stoppingId === job.id ? "正在停止…" : "停止扫描"}</button> : <><button type="button" className="settings-button" disabled={busy} onClick={() => void action(source.id, "scan")}><SettingsIcon name="refresh" />{busy ? "处理中…" : "扫描"}</button><div className="settings-menu-anchor"><button type="button" className="settings-button settings-more is-quiet" id={`settings-source-more-${source.id}`} aria-label={`${source.name}的更多操作`} aria-expanded={menuId === source.id} aria-controls={`settings-source-menu-${source.id}`} disabled={busy} onClick={() => setMenuId(menuId === source.id ? undefined : source.id)}><SettingsIcon name="more" /></button>{menuId === source.id && <div className="settings-source-menu" id={`settings-source-menu-${source.id}`} role="group" aria-label={`${source.name}操作`}><button type="button" onClick={() => void action(source.id, "test")}>测试连接</button><button type="button" onClick={() => openEdit(source)}>编辑媒体源</button><button type="button" className="is-danger" onClick={() => void remove(source)}>删除媒体源</button></div>}</div></>}</div>}</div>
            </article>;
          })}</div>}
        <div className="settings-sync-section"><div className="settings-row"><div><h3>自动同步</h3><p>定时发现新文件并加入媒体库</p></div><div className="settings-sync-controls"><label className="settings-switch"><input type="checkbox" aria-label="自动同步" checked={autoSync?.enabled ?? false} disabled={!isAdmin || !autoSync || syncState === "loading" || syncState === "saving"} onChange={(event) => autoSync && void saveAutoSync({ ...autoSync, enabled: event.target.checked })} /><span className="settings-switch-track" aria-hidden="true" /><span>{autoSync ? autoSync.enabled ? "已开启" : "已关闭" : "未读取"}</span></label><select className="settings-select" aria-label="自动同步间隔" value={autoSync?.intervalMinutes ?? 15} disabled={!isAdmin || !autoSync?.enabled || syncState === "loading" || syncState === "saving"} onChange={(event) => autoSync && void saveAutoSync({ ...autoSync, intervalMinutes: Number(event.target.value) })}>{autoSync && ![5, 15, 30, 60].includes(autoSync.intervalMinutes) && <option value={autoSync.intervalMinutes}>每 {autoSync.intervalMinutes} 分钟</option>}<option value={5}>每 5 分钟</option><option value={15}>每 15 分钟</option><option value={30}>每 30 分钟</option><option value={60}>每 1 小时</option></select></div></div><div className={`settings-save-status${syncState === "error" ? " is-error" : ""}`} role={syncState === "error" ? "alert" : "status"}>{syncState === "loading" ? "正在读取同步设置…" : syncState === "saving" ? "正在保存…" : syncState === "saved" ? "已保存" : syncState === "error" ? <>{syncError}<button type="button" className="settings-text-button" onClick={() => void loadAutoSync()}>重新读取</button></> : isAdmin ? "更改后自动保存" : "同步设置由管理员管理"}</div></div>
        {isAdmin && Boolean(meta?.pending) && <div className="settings-pending-link"><SettingsIcon name="database" /><span>有 {meta!.pending} 项内容待匹配，<button type="button" className="settings-text-button" onClick={() => selectTab("matching")}>前往处理 <SettingsIcon name="arrow" /></button></span></div>}
      </section>

      {isAdmin && <section id="settings-panel-matching" role="tabpanel" aria-labelledby="settings-tab-matching" hidden={activeTab !== "matching"}>
        <div className="settings-section-heading"><h2>元数据匹配</h2></div>
        {metaError && <div className="settings-inline-error" role="alert">{metaError}<button type="button" className="settings-text-button" onClick={() => void loadMeta()}>重新加载</button></div>}
        <div className="settings-matching-stats"><span><strong>{meta?.matchedWorks ?? "—"}</strong>已匹配</span><span className="is-pending"><strong>{meta?.pending ?? "—"}</strong>待匹配</span></div>
        <div className="settings-matching-card"><div className="settings-provider-heading"><div className="settings-provider-title"><span className="settings-provider-icon"><SettingsIcon name="database" /></span><div><h3>豆瓣元数据</h3><p className={meta && !meta.hasCookie ? "settings-cookie-warning" : ""}>{meta ? <><SettingsIcon name={meta.hasCookie ? "check" : "alert"} />{meta.hasCookie ? "Cookie 已配置" : "尚未配置 Cookie"}</> : "正在读取配置…"}</p></div></div><div className="settings-provider-actions">{meta?.hasCookie && <button type="button" className="settings-button is-quiet" disabled={checkingLogin} onClick={() => void checkLogin()}>{checkingLogin ? "检测中…" : "检测登录"}</button>}<button type="button" className="settings-button" onClick={() => void openDouban()}>{meta?.hasCookie ? "管理 Cookie" : "配置 Cookie"}</button></div></div>
          {loginInfo && <p className={`settings-login-info${loginInfo.isLogined ? "" : " is-error"}`} role="status">{loginInfo.isLogined ? `豆瓣已登录：${loginInfo.name || "已登录"}` : "豆瓣未登录或 Cookie 无效"}</p>}
          <div className="settings-match-task"><div className="settings-match-info"><p>{metaRunning ? metaJob?.current_title ? `正在匹配：${metaJob.current_title}` : "匹配任务正在后台运行" : metaJob?.status === "completed" ? `上次完成 · 新增 ${metaJob.matched} / 跳过 ${metaJob.skipped} / 失败 ${metaJob.failed}` : metaJob?.status === "cancelled" ? `上次匹配已停止 · 已处理 ${metaJob.processed} 项` : metaJob?.status === "failed" ? "上次匹配未完成" : "为媒体库补全海报、简介与作品信息"}</p><span><SettingsIcon name="check" />自动跳过已匹配内容</span></div>{metaRunning ? <button type="button" className="settings-button is-danger" disabled={metaBusy} onClick={() => void metadataAction("stop")}>{metaBusy ? "正在停止…" : "停止匹配"}</button> : <button type="button" className="settings-button is-primary" disabled={!meta || metaBusy || meta.pending === 0} onClick={() => void metadataAction("refresh")}>{metaBusy ? "正在提交…" : !meta ? "正在读取…" : meta.pending ? `匹配 ${meta.pending} 项` : "全部已匹配"}</button>}</div>
          {metaRunning && <div className="settings-metadata-progress" aria-live="polite"><div className="settings-progress-label"><span>已处理 {metaJob?.processed ?? 0} / {metaJob?.total ?? 0}</span><span>{metaPercent}%</span></div><div className="settings-progress-track" role="progressbar" aria-label="元数据匹配进度" aria-valuenow={metaPercent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${metaPercent}%` }} /></div></div>}
          {metaJob?.error && <p className="settings-inline-error" role="alert">{metaJob.error}</p>}
          <details className="settings-advanced"><summary>高级选项</summary><div className="settings-row"><div><h3>请求间隔</h3><p>根据 Cookie 与防封禁模式自动调整</p></div><span className="settings-setting-value">{meta?.gapMs !== undefined ? `${meta.gapMs / 1000} 秒` : "—"}</span></div><div className="settings-row"><div><h3>防封禁模式</h3><p>降低请求频率，减少触发访问限制</p></div><label className="settings-switch"><input type="checkbox" aria-label="防封禁模式" checked={meta?.avoidRiskControl !== false} disabled={!meta || riskSaving} onChange={(event) => void saveRiskControl(event.target.checked)} /><span className="settings-switch-track" aria-hidden="true" /><span>{riskSaving ? "保存中…" : meta?.avoidRiskControl === false ? "已关闭" : "已开启"}</span></label></div></details>
        </div>
      </section>}

      <section id="settings-panel-account" role="tabpanel" aria-labelledby="settings-tab-account" hidden={activeTab !== "account"}>
        <div className="settings-section-heading"><h2>账户与安全</h2></div><div className="settings-account-heading"><span className="settings-account-avatar">{user.username[0]?.toUpperCase()}</span><div><h3>{user.username}</h3><p>{isAdmin ? "管理员账户" : "成员账户"}</p></div></div><div className="settings-row settings-password-row"><div><h3><SettingsIcon name="shield" />登录密码</h3><p>修改后，其他设备需要重新登录</p></div><button type="button" className="settings-button" onClick={openPassword}>修改密码</button></div>
      </section>
    </div>

    {showForm && <SettingsDrawer title={editingId ? "编辑媒体源" : "添加媒体源"} description={editingId ? "更新媒体源的连接信息，保存后可重新测试并扫描。" : "连接 WebDAV 或 NAS 本地目录，将你的收藏加入媒体库。"} onClose={closeForm} onSubmit={submitSource} busy={sourceSaving} dirty={JSON.stringify(form) !== JSON.stringify(formSnapshot)} error={sourceError} footer={<><button type="button" className="settings-button" disabled={sourceSaving} onClick={closeForm}>取消</button><button type="submit" className="settings-button is-primary" disabled={sourceSaving}>{sourceSaving ? "正在保存…" : editingId ? "保存修改" : "添加媒体源"}</button></>}>
      <fieldset disabled={sourceSaving} className="settings-form-fields"><label>显示名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：家庭影院" required autoFocus /></label><label>存储类型<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="webdav">WebDAV</option><option value="local">NAS 本地目录</option></select></label><label>{form.type === "webdav" ? "WebDAV 地址" : "容器内目录"}<input value={form.basePath} onChange={(event) => setForm({ ...form, basePath: event.target.value })} placeholder={form.type === "webdav" ? "https://dav.example.com/media/" : "/media"} required autoComplete="off" spellCheck={false} /></label>{form.type === "local" && <p className="settings-field-help">填写服务所在容器内可访问的目录，例如 /media。</p>}{form.type === "webdav" && <div className="settings-form-section"><h3>连接凭证</h3><label>用户名<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} autoComplete="off" spellCheck={false} /></label><label>密码 / Token<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={editingId ? "留空则保留原凭证" : "输入密码或访问 Token"} autoComplete="new-password" /></label><p className="settings-field-help">{editingId ? "不填写密码时，会继续使用已保存的凭证。" : "连接凭证会加密保存在服务端。"}</p></div>}</fieldset>
    </SettingsDrawer>}

    {showDouban && <SettingsDrawer title="豆瓣 Cookie" description="在浏览器登录豆瓣电影后，复制 Cookie 并粘贴到这里。保存后可在匹配页检测登录。" onClose={closeDouban} onSubmit={saveDouban} busy={doubanLoading || doubanSaving} dirty={doubanLoaded && JSON.stringify(doubanForm) !== JSON.stringify(doubanSnapshot)} error={doubanError} footer={<><button type="button" className="settings-button" disabled={doubanLoading || doubanSaving} onClick={closeDouban}>取消</button><button type="submit" className="settings-button is-primary" disabled={!doubanLoaded || doubanSaving}>{doubanSaving ? "正在保存…" : "保存 Cookie"}</button></>}>
      {doubanLoading ? <p className="settings-field-help" role="status">正在读取 Cookie 设置…</p> : !doubanLoaded ? <button type="button" className="settings-button" onClick={() => void openDouban()}>重新读取</button> : <fieldset className="settings-form-fields" disabled={doubanSaving}><label>豆瓣 Cookie<textarea aria-label="豆瓣 Cookie" rows={8} value={doubanForm.cookies} onChange={(event) => setDoubanForm({ ...doubanForm, cookies: event.target.value })} placeholder={'bid=xxx; dbcl2="xxx"; ck=xxx; …'} autoComplete="off" spellCheck={false} autoFocus /></label><p className="settings-field-help">留空并保存可清除已配置的 Cookie。防封禁模式可在“高级选项”中调整。</p></fieldset>}
    </SettingsDrawer>}

    {showPassword && <SettingsDrawer title="修改密码" description="新密码至少 8 位。保存后当前设备保持登录，其他设备需要重新登录。" onClose={closePassword} onSubmit={submitPassword} busy={passwordSaving} dirty={Object.values(passwordForm).some(Boolean)} error={passwordError} footer={<><button type="button" className="settings-button" disabled={passwordSaving} onClick={closePassword}>取消</button><button type="submit" className="settings-button is-primary" disabled={passwordSaving}>{passwordSaving ? "正在保存…" : "保存新密码"}</button></>}>
      <fieldset className="settings-form-fields" disabled={passwordSaving}><label>当前密码<input type="password" value={passwordForm.currentPassword} onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })} autoComplete="current-password" required autoFocus /></label><label>新密码<input type="password" value={passwordForm.newPassword} onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} autoComplete="new-password" minLength={8} required /></label><label>确认新密码<input type="password" value={passwordForm.confirmPassword} onChange={(event) => setPasswordForm({ ...passwordForm, confirmPassword: event.target.value })} autoComplete="new-password" minLength={8} required /></label></fieldset>
    </SettingsDrawer>}
  </main>;
}
