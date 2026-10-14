import { useEffect, useRef, useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { api, clearToken, getToken, setOnUnauthorized, setToken, tokenKey, type ScanJob, type User } from "./api";
import { loadStartup } from "./startup";
import { Home } from "./pages/Home";
import { Library } from "./pages/Library";
import { BrowseView } from "./pages/Browse";
import { Detail } from "./pages/Detail";
import { WorkDetail } from "./pages/WorkDetail";
import { PlayerRoute } from "./pages/Player";
import { SourceAdmin } from "./pages/Admin";

function Auth({ initialized, setupExpired, onLogin, onSetupDone }: { initialized: boolean; setupExpired: boolean; onLogin: (user: User) => void; onSetupDone: () => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try {
      if (!initialized) { await api("/setup", { method: "POST", body: JSON.stringify({ username, password }) }); onSetupDone(); }
      const result = await api<{ token: string; user: User }>("/login", { method: "POST", body: JSON.stringify({ username, password }) });
      setToken(result.token); onLogin(result.user);
    } catch (e) { setError((e as Error).message); }
  }
  return <main className="auth-page"><section className="auth-copy"><span className="eyebrow">YOUR SCREEN. YOUR STORAGE.</span><h1>让收藏，<br />重新开场。</h1><p>连接 NAS 与 WebDAV，在任何浏览器中进入你的私人放映室。</p></section>{setupExpired && !initialized ? <section className="auth-card"><div className="brand-mark">F</div><div><span className="eyebrow">FPLAYER</span><h2>初始化窗口已过期</h2></div><p className="error">管理员账户需在服务启动后 30 分钟内创建，当前已过期。</p><p>如需重新初始化，请删除数据目录中的数据库后重启服务。</p></section> : <form className="auth-card" onSubmit={submit}><div className="brand-mark">F</div><div><span className="eyebrow">FPLAYER</span><h2>{initialized ? "欢迎回来" : "创建管理员"}</h2></div><label>用户名<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required /></label><label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={initialized ? undefined : 8} required /></label>{error && <p className="error">{error}</p>}<button className="primary" type="submit">{initialized ? "进入媒体库" : "创建并进入"}</button><small>{initialized ? "使用你的本地账户登录" : "首个账户将成为系统管理员"}</small></form>}</main>;
}

function Layout({ user, logout }: { user: User; logout: () => void }) {
  const location = useLocation(); const [jobs, setJobs] = useState<ScanJob[]>([]);
  const cinema = location.pathname.startsWith("/watch/");
  // Jobs already finished on the first successful fetch predate this session
  // (e.g. auto-sync ran while the tab was closed). They never toast and are
  // acknowledged in bulk so they do not linger as unread.
  const staleIds = useRef(new Set<number>());
  const firstFetch = useRef(true);
  useEffect(() => {
    let active = true; let timer = 0;
    const refresh = () => api<ScanJob[]>("/scans").then((rows) => {
      if (!active) return;
      if (firstFetch.current) {
        firstFetch.current = false;
        for (const row of rows) if (["completed", "failed", "cancelled"].includes(row.status)) staleIds.current.add(row.id);
        if (staleIds.current.size > 0 && user.role === "admin") void api("/scans/acknowledge-finished", { method: "POST" }).catch(() => {});
      }
      setJobs(rows);
    }).catch(() => {});
    refresh();
    // Poll only while there are active jobs; stop the interval once idle.
    // Check current state from a ref to avoid retriggering this effect on every
    // setJobs, which would cause an infinite request loop.
    timer = window.setInterval(() => {
      setJobs((current) => {
        const hasActive = current.some((job) => ["queued", "running"].includes(job.status));
        if (hasActive) refresh();
        return current;
      });
    }, 2000);
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, []);
  async function dismiss(job: ScanJob) { await api(`/scans/${job.id}/acknowledge`, { method: "POST" }); setJobs((current) => current.filter((item) => item.id !== job.id)); }
  const finished = jobs.filter((job) => ["completed", "failed", "cancelled"].includes(job.status) && !staleIds.current.has(job.id));
  return <div className={`shell ${cinema ? "cinema" : ""}`}><aside><Link className="logo" to="/"><span>F</span> FPLAYER</Link><nav><Link className={location.pathname === "/" ? "active" : ""} to="/" aria-label="首页">⌂ <span>首页</span></Link><Link className={location.pathname.startsWith("/movies") ? "active" : ""} to="/movies" aria-label="电影">◫ <span>电影</span></Link><Link className={location.pathname.startsWith("/shows") ? "active" : ""} to="/shows" aria-label="剧集">▤ <span>剧集</span></Link><Link className={location.pathname.startsWith("/admin") ? "active" : ""} to="/admin" aria-label="设置">⚙ <span>设置</span></Link></nav><div className="account"><div className="avatar">{user.username[0].toUpperCase()}</div><div><strong>{user.username}</strong><button onClick={logout}>退出登录</button></div></div></aside><div className="content"><Routes><Route path="/" element={<Home />} /><Route path="/movies" element={<Library kind="movie" />} /><Route path="/shows" element={<Library kind="show" />} /><Route path="/browse" element={<BrowseView />} /><Route path="/browse/:sourceId" element={<BrowseView />} /><Route path="/work/:id" element={<WorkDetail />} /><Route path="/media/:id" element={<Detail />} /><Route path="/watch/:id" element={<PlayerRoute />} /><Route path="/admin" element={<SourceAdmin user={user} jobs={jobs} refreshJobs={(rows) => setJobs(rows)} />} /></Routes></div>{finished.length > 0 && <div className="notifications">{finished.map((job) => <article className={`toast ${job.status}`} key={job.id}><div><strong>{job.source_name}：{job.status === "completed" ? "扫描完成" : job.status === "cancelled" ? "扫描已停止" : "扫描失败"}</strong><p>{job.status === "completed" ? `共发现并更新 ${job.result_count || 0} 个媒体文件` : job.error}</p></div><button aria-label="关闭" onClick={() => dismiss(job)}>×</button></article>)}</div>}</div>;
}

export default function App() {
  const [initialized, setInitialized] = useState<boolean>();
  const [setupExpired, setSetupExpired] = useState(false);
  const [user, setUser] = useState<User>();
  const [startupError, setStartupError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const startupRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setOnUnauthorized(() => { setUser(undefined); setStartupError(""); });
    const syncSession = (event: StorageEvent) => {
      if (event.key !== tokenKey && event.key !== null) return;
      startupRequest.current?.abort();
      setUser(undefined); setInitialized(undefined); setStartupError("");
      setAttempt((current) => current + 1);
    };
    window.addEventListener("storage", syncSession);
    return () => { setOnUnauthorized(null); window.removeEventListener("storage", syncSession); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    startupRequest.current = controller;
    const token = getToken();
    setStartupError("");
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    loadStartup(controller.signal).then((state) => {
      if (startupRequest.current !== controller) return;
      if (getToken() !== token && !(token && !getToken() && !state.user)) { setAttempt((current) => current + 1); return; }
      setInitialized(state.initialized); setSetupExpired(state.setupExpired); setUser(state.user);
    }).catch((error) => {
      if (startupRequest.current !== controller) return;
      if (getToken() !== token) { setAttempt((current) => current + 1); return; }
      setStartupError(controller.signal.aborted ? "连接超时，请检查网络或服务状态后重试" : (error as Error).message);
    }).finally(() => window.clearTimeout(timeout));
    return () => { startupRequest.current = null; controller.abort(); window.clearTimeout(timeout); };
  }, [attempt]);
  useEffect(() => {
    if (!startupError) return;
    const retry = () => setAttempt((current) => current + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [startupError]);
  if (startupError) return <main className="auth-page"><section className="auth-copy"><span className="eyebrow">YOUR SCREEN. YOUR STORAGE.</span><h1>稍等，<br />正在重连。</h1><p>暂时无法连接你的私人放映室，请检查网络或服务器状态。</p></section><section className="auth-card"><div className="brand-mark">F</div><h2>连接未完成</h2><p className="error" role="alert">{startupError}</p><p>{getToken() ? "登录凭证已保留，连接恢复后无需重新输入密码。" : "暂时无法确认服务状态，请重试后继续。"}</p><button className="primary" onClick={() => setAttempt((current) => current + 1)}>重新连接</button></section></main>;
  if (initialized === undefined) return <div className="splash">F</div>;
  if (!user) return <Auth initialized={initialized} setupExpired={setupExpired} onLogin={(next) => { startupRequest.current?.abort(); startupRequest.current = null; setUser(next); }} onSetupDone={() => setInitialized(true)} />;
  return <Layout user={user} logout={() => { startupRequest.current?.abort(); startupRequest.current = null; void api("/logout", { method: "POST" }).catch(() => {}); clearToken(); setUser(undefined); }} />;
}
