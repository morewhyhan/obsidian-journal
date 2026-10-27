import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  CalendarDays,
  Compass,
  Search,
  PanelLeft,
  Plus,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Clock,
  Settings,
  MessageCircle,
  MoreHorizontal,
  Undo2,
  Redo2,
  Eye,
  PenLine,
  X,
  Paperclip,
  LogOut,
} from "lucide-react";
import { api, mutate, drafts, ApiError, type Document } from "./api";
import type { EditorHandle } from "./Editor";
const Editor = lazy(() =>
  import("./Editor").then((module) => ({ default: module.Editor })),
);
const Preview = lazy(() =>
  import("./Preview").then((module) => ({ default: module.Preview })),
);
import "./style.css";
const label = (p: string) => p.split("/").at(-1)!.replace(/\.md$/, "");
type Page = "home" | "notes" | "items" | "status";
function App() {
  const [auth, setAuth] = useState<"loading" | "login" | "yes">("loading"),
    [password, setPassword] = useState(""),
    [page, setPage] = useState<Page>("home"),
    [paths, setPaths] = useState<string[]>([]),
    [home, setHome] = useState<any>(null),
    [items, setItems] = useState<any>(null),
    [status, setStatus] = useState<any>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [sidebar, setSidebar] = useState(false),
    [search, setSearch] = useState<string | null>(null),
    [results, setResults] = useState<any[]>([]),
    [assistant, setAssistant] = useState(false),
    [message, setMessage] = useState(""),
    [messages, setMessages] = useState<{ text: string; role: string }[]>([]),
    [pendingInputs, setPendingInputs] = useState<string[]>([]);
  const [doc, setDoc] = useState<Document | null>(null),
    [content, setContent] = useState(""),
    [saved, setSaved] = useState(""),
    [saving, setSaving] = useState(false),
    [composing, setComposing] = useState(false),
    [preview, setPreview] = useState(false),
    [conflict, setConflict] = useState<Document | null>(null),
    [history, setHistory] = useState<any[] | null>(null),
    [historyPreview, setHistoryPreview] = useState<{
      commit: string;
      content: string;
    } | null>(null),
    [trash, setTrash] = useState<any[] | null>(null),
    [newName, setNewName] = useState<string | null>(null),
    [folderView, setFolderView] = useState<string | null>(null),
    [includeCurrentNote, setIncludeCurrentNote] = useState(false);
  const editor = useRef<EditorHandle>(null),
    docRef = useRef(doc),
    contentRef = useRef(content),
    savedRef = useRef(saved),
    savingRef = useRef(false),
    openSequence = useRef(0),
    savingRequest = useRef<string | null>(null),
    completedInputs = useRef(new Set<string>());
  docRef.current = doc;
  contentRef.current = content;
  savedRef.current = saved;
  const refresh = useCallback(async () => {
    try {
      const [t, h, i] = await Promise.all([
        api("/tree"),
        api("/home"),
        api("/items"),
      ]);
      setPaths(t.paths);
      setHome(h);
      setItems(i);
    } catch (e) {
      handle(e);
    }
  }, []);
  function handle(e: unknown) {
    if (e instanceof ApiError && e.status === 401) setAuth("login");
    setError(e instanceof Error ? e.message : "操作暂未完成");
  }
  useEffect(() => {
    api("/auth/session")
      .then(() => setAuth("yes"))
      .catch(() => setAuth("login"));
  }, []);
  const open = useCallback(async (p: string) => {
    const sequence = ++openSequence.current;
    if (docRef.current && contentRef.current !== savedRef.current)
      await drafts.put({
        path: docRef.current.path,
        content: contentRef.current,
        baseHash: docRef.current.hash,
        updatedAt: Date.now(),
      });
    if (sequence !== openSequence.current) return;
    setError("");
    setConflict(null);
    setHistory(null);
    setHistoryPreview(null);
    setIncludeCurrentNote(false);
    try {
      const data = await api<Document>(
        "/documents?path=" + encodeURIComponent(p),
      );
      const draft = await drafts.get(p);
      if (sequence !== openSequence.current) return;
      setDoc(data);
      setSaved(data.content);
      setContent(draft?.content ?? data.content);
      if (
        draft &&
        draft.content !== data.content &&
        draft.baseHash !== data.hash
      )
        setConflict(data);
      setPage("notes");
      setSidebar(false);
      window.history.replaceState(
        null,
        "",
        "/notes?path=" + encodeURIComponent(p),
      );
    } catch (e) {
      if (sequence !== openSequence.current) return;
      if (e instanceof ApiError && e.status === 404) {
        setNewName(p);
        setPage("notes");
        setDoc(null);
      } else handle(e);
    }
  }, []);
  useEffect(() => {
    if (auth !== "yes") return;
    void refresh();
    const target = new URLSearchParams(location.search).get("path");
    if (target) void open(target);
    else if (location.pathname === "/items") setPage("items");
    else if (location.pathname === "/settings/status") {
      setPage("status");
      void api("/status").then(setStatus).catch(handle);
    } else if (location.pathname === "/today")
      void api("/home").then((h) => open(h.periods.daily));
    const stream = new EventSource("/api/v1/events/stream");
    stream.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "item_changed") void refresh();
      if (
        msg.type === "document_changed" &&
        msg.data.path === docRef.current?.path &&
        msg.data.request_id !== savingRequest.current
      ) {
        if (msg.data.deleted) {
          setError("这篇笔记已在别处删除，当前草稿仍保留。");
          void refresh();
          return;
        }
        if (msg.data.renamed_to) {
          setError("这篇笔记已重命名，当前草稿仍保留。请从目录打开新路径。");
          void refresh();
          return;
        }
        api<Document>("/documents?path=" + encodeURIComponent(msg.data.path))
          .then((next) => {
            if (next.path !== docRef.current?.path) return;
            if (next.hash === docRef.current?.hash) return;
            if (contentRef.current !== savedRef.current) setConflict(next);
            else {
              setDoc(next);
              setSaved(next.content);
              setContent(next.content);
            }
          })
          .catch(handle);
      }
      if (msg.type === "input_result") {
        if (completedInputs.current.has(msg.data.id)) return;
        completedInputs.current.add(msg.data.id);
        setPendingInputs((ids) => ids.filter((id) => id !== msg.data.id));
        setMessages((list) => [
          ...list,
          {
            role: "secretary",
            text: msg.data.reply ?? msg.data.message ?? "已处理。",
          },
        ]);
        void refresh();
      }
    };
    return () => stream.close();
  }, [auth]);
  useEffect(() => {
    if (!pendingInputs.length) return;
    const timer = setInterval(() => {
      for (const id of pendingInputs)
        api("/inputs/" + id)
          .then((r) => {
            if (["processed", "failed"].includes(r.status)) {
              if (completedInputs.current.has(id)) return;
              completedInputs.current.add(id);
              setPendingInputs((list) => list.filter((x) => x !== id));
              setMessages((list) => [
                ...list,
                {
                  role: "secretary",
                  text: r.reply ?? "暂未记入，请稍后再试。",
                },
              ]);
              void refresh();
            }
          })
          .catch(handle);
    }, 3000);
    return () => clearInterval(timer);
  }, [pendingInputs]);
  useEffect(() => {
    if (!doc || content === saved || composing || conflict || saving) return;
    const current = doc;
    const timer = setTimeout(() => {
      void save(current, content);
    }, 1000);
    return () => clearTimeout(timer);
  }, [doc, content, saved, composing, conflict, saving]);
  async function save(current: Document, text: string) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const requestId = crypto.randomUUID();
    savingRequest.current = requestId;
    try {
      const next = await api<Document>("/documents", {
        method: "PUT",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({
          path: current.path,
          base_hash: current.hash,
          content: text,
        }),
      });
      if (docRef.current?.path === current.path) {
        docRef.current = next;
        savedRef.current = text;
        setDoc(next);
        setSaved(text);
        if (contentRef.current === text) await drafts.remove(current.path);
      }
      void refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try {
          const latest = await api<Document>(
            "/documents?path=" + encodeURIComponent(current.path),
          );
          if (docRef.current?.path === current.path) setConflict(latest);
        } catch (inner) {
          handle(inner);
        }
      } else handle(e);
    } finally {
      savingRef.current = false;
      savingRequest.current = null;
      setSaving(false);
    }
  }
  function change(text: string, ime: boolean) {
    setContent(text);
    setComposing(ime);
    if (docRef.current)
      void drafts
        .put({
          path: docRef.current.path,
          content: text,
          baseHash: docRef.current.hash,
          updatedAt: Date.now(),
        })
        .catch(() => setError("浏览器无法保存草稿，请保持页面打开。"));
  }
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (contentRef.current !== savedRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  useEffect(() => {
    if (search === null) return;
    const timer = setTimeout(() => {
      api("/search?q=" + encodeURIComponent(search))
        .then((r) => setResults(r.results))
        .catch(handle);
    }, 180);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearch("");
      }
      if (event.key === "Escape") {
        setSearch(null);
        setAssistant(false);
        setSidebar(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  async function createPeriod(kind = "daily", date = home?.date) {
    try {
      const result = await mutate("/documents", { kind, date });
      await refresh();
      await open(result.path);
      setNewName(null);
    } catch (e) {
      handle(e);
    }
  }
  async function createNote() {
    if (!newName) return;
    try {
      const result = await mutate("/documents", {
        path: newName.endsWith(".md") ? newName : newName + ".md",
        content: "",
      });
      await refresh();
      await open(result.path);
      setNewName(null);
    } catch (e) {
      handle(e);
    }
  }
  async function command(body: unknown) {
    try {
      const result = await mutate("/commands", body);
      setNotice(result.message ?? "已保存");
      setError("");
      await refresh();
    } catch (e) {
      handle(e);
    }
  }
  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;
    if (
      includeCurrentNote &&
      docRef.current &&
      contentRef.current !== savedRef.current
    ) {
      await save(docRef.current, contentRef.current);
      if (contentRef.current !== savedRef.current) {
        setError("当前笔记尚未保存，请先处理保存问题再引用。");
        return;
      }
    }
    const text = message;
    setMessage("");
    setMessages((list) => [...list, { role: "user", text }]);
    try {
      const r = await mutate("/assistant/messages", {
        text,
        ...(includeCurrentNote && doc
          ? {
              note_scope: [
                { path: doc.path, heading: null, relation: "evidence" },
              ],
            }
          : {}),
      });
      setPendingInputs((list) => [...list, r.id]);
      setIncludeCurrentNote(false);
    } catch (e) {
      handle(e);
    }
  }
  function navigate(next: Page) {
    setPage(next);
    setSidebar(false);
    setError("");
    window.history.replaceState(
      null,
      "",
      next === "home"
        ? "/"
        : next === "items"
          ? "/items"
          : next === "status"
            ? "/settings/status"
            : "/notes",
    );
    if (next === "status") api("/status").then(setStatus).catch(handle);
  }
  async function logout() {
    await mutate("/auth/logout", {});
    setAuth("login");
    setDoc(null);
    setContent("");
    setSaved("");
  }
  function openFolder(folder: string) {
    setDoc(null);
    setContent("");
    setSaved("");
    setFolderView(folder);
    setPage("notes");
    setSidebar(false);
  }
  if (auth === "loading") return <div className="loading">日常</div>;
  if (auth === "login")
    return (
      <main className="login">
        <div className="brand-symbol">
          <BookOpen size={28} />
        </div>
        <h1>留一点时间，给自己。</h1>
        <p>你的日记、计划，与一位从容的助理。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              await mutate("/auth/login", { password });
              setAuth("yes");
              setPassword("");
            } catch (err) {
              handle(err);
            }
          }}
        >
          <label htmlFor="password">访问密码</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="primary" type="submit">
            进入工作台 <ArrowRight size={17} />
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
        <small>一个安静的地方，把日子慢慢过好。</small>
      </main>
    );
  const dirty = content !== saved;
  return (
    <div className="app">
      <aside className={"sidebar " + (sidebar ? "visible" : "")}>
        <button className="brand" onClick={() => navigate("home")}>
          <span className="brand-symbol">
            <BookOpen size={21} />
          </span>
          <span>
            日常<small>Personal space</small>
          </span>
        </button>
        <button className="search-button" onClick={() => setSearch("")}>
          <Search size={16} />
          搜索笔记<span>⌘ K</span>
        </button>
        <nav>
          <button
            className={page === "home" ? "active" : ""}
            onClick={() => navigate("home")}
          >
            <CalendarDays size={18} />
            今天
          </button>
          <button
            className={page === "items" ? "active" : ""}
            onClick={() => navigate("items")}
          >
            <Check size={18} />
            习惯与任务
          </button>
        </nav>
        <div className="nav-caption">
          我的笔记
          <button
            aria-label="新建笔记"
            onClick={() => setNewName("03. Manual/新笔记.md")}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="file-tree">
          {["01. Daily", "02. Decisions", "03. Manual"].map((folder, i) => (
            <details key={folder} open={i === 0}>
              <summary>
                <span className={"folder-dot color-" + i} />
                {folder.replace(/^\d+\. /, "")}
              </summary>
              <FileTree
                paths={paths.filter((p) => p.startsWith(folder + "/"))}
                prefix={folder}
                selected={page === "notes" ? doc?.path : undefined}
                onOpen={open}
              />
            </details>
          ))}
        </div>
        <div className="sidebar-footer">
          <button onClick={() => navigate("status")}>
            <Settings size={16} />
            设置与状态
          </button>
          <button aria-label="退出登录" onClick={() => void logout()}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {sidebar && (
        <button
          aria-label="收起目录"
          className="sidebar-backdrop"
          onClick={() => setSidebar(false)}
        />
      )}
      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button menu-toggle"
            aria-label="打开目录"
            onClick={() => setSidebar(!sidebar)}
          >
            <PanelLeft size={19} />
          </button>
          <span>
            {page === "home"
              ? "我的空间"
              : page === "items"
                ? "习惯与任务"
                : page === "status"
                  ? "设置与状态"
                  : doc
                    ? label(doc.path)
                    : "笔记"}
          </span>
          <div className="topbar-right">
            {page === "notes" && doc && (
              <small className={conflict ? "attention" : ""}>
                {conflict
                  ? "需要合并"
                  : saving
                    ? "保存中…"
                    : dirty
                      ? "草稿已保留"
                      : "已保存到服务器"}
              </small>
            )}
            <button
              className="assistant-button"
              onClick={() => setAssistant(!assistant)}
            >
              <MessageCircle size={16} />
              <span>交代一件事</span>
            </button>
          </div>
        </header>
        {notice && (
          <div className="assistant-receipt" role="status">
            {notice}
            <button aria-label="关闭回执" onClick={() => setNotice("")}>
              关闭
            </button>
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {page === "home" && home && (
          <main className="home">
            <div className="eyebrow">
              {new Intl.DateTimeFormat("zh-CN", {
                year: "numeric",
                month: "long",
                day: "numeric",
                weekday: "long",
              }).format(new Date(home.date + "T12:00:00"))}
            </div>
            <div className="welcome">
              <div>
                <h1>把今天，过得清楚一点。</h1>
                <p>安排眼前的事，也留住生活里值得记下的片刻。</p>
              </div>
              <button
                className="primary"
                onClick={() =>
                  void (paths.includes(home.periods.daily)
                    ? open(home.periods.daily)
                    : createPeriod())
                }
              >
                <PenLine size={17} />
                写今天的日记
              </button>
            </div>
            <section className="heatmap-section">
              <div className="section-top">
                <h2>日子留下的痕迹</h2>
                <span>写过，就有一格</span>
              </div>
              <Heatmap entries={home.heatmap} date={home.date} onOpen={open} />
              <div className="period-links">
                {(["weekly", "monthly", "quarterly", "yearly"] as const).map(
                  (k, i) => (
                    <button
                      key={k}
                      onClick={() =>
                        void (paths.includes(home.periods[k])
                          ? open(home.periods[k])
                          : createPeriod(k))
                      }
                    >
                      {["本周", "本月", "本季", "今年"][i]}
                      <ChevronRight size={13} />
                    </button>
                  ),
                )}
              </div>
            </section>
            <section className="spaces">
              <Space
                title="Daily"
                subtitle="日记与计划"
                text="安排时间，记录行动与感受。"
                icon={<CalendarDays />}
                color="green"
                onClick={() =>
                  void (paths.includes(home.periods.daily)
                    ? open(home.periods.daily)
                    : createPeriod())
                }
              />
              <Space
                title="Decisions"
                subtitle="问题研究"
                text="把问题想清楚，再决定往哪里走。"
                icon={<Compass />}
                color="blue"
                onClick={() => {
                  openFolder("02. Decisions");
                }}
              />
              <Space
                title="Manual"
                subtitle="技能手册"
                text="留下实践中形成的方法与步骤。"
                icon={<BookOpen />}
                color="purple"
                onClick={() => {
                  openFolder("03. Manual");
                }}
              />
            </section>
            <section className="recent">
              <div className="section-top">
                <h2>最近的笔记</h2>
                <button onClick={() => setSearch("")}>
                  查看全部 <ArrowRight size={14} />
                </button>
              </div>
              {home.recent.length ? (
                home.recent.slice(0, 6).map((p: any) => (
                  <button
                    className="recent-note"
                    key={p.path}
                    onClick={() => void open(p.path)}
                  >
                    <span>
                      <PenLine size={17} />
                      {label(p.path)}
                    </span>
                    <small>
                      {new Date(p.updated_at).toLocaleDateString("zh-CN")}{" "}
                      <ChevronRight size={14} />
                    </small>
                  </button>
                ))
              ) : (
                <p className="empty">从今天开始，慢慢留下自己的记录。</p>
              )}
            </section>
            <footer>不必填满每一天。留下你想留下的。</footer>
          </main>
        )}
        {page === "notes" && !doc && folderView && (
          <main className="items-page">
            <div className="eyebrow">{folderView.replace(/^\d+\. /, "")}</div>
            <h1>{folderView.startsWith("02") ? "问题研究" : "技能手册"}</h1>
            <button
              className="primary"
              onClick={() => setNewName(folderView + "/新笔记.md")}
            >
              <Plus size={16} />
              新建笔记
            </button>
            <section>
              {paths
                .filter((p) => p.startsWith(folderView + "/"))
                .map((p) => (
                  <button
                    className="recent-note"
                    key={p}
                    onClick={() => void open(p)}
                  >
                    <span>
                      <PenLine size={16} />
                      {label(p)}
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
            </section>
          </main>
        )}
        {page === "notes" && doc && (
          <main className="note-page">
            <div className="note-toolbar">
              <div>
                <button
                  aria-label="撤销"
                  onClick={() => editor.current?.undo()}
                >
                  <Undo2 size={17} />
                </button>
                <button
                  aria-label="重做"
                  onClick={() => editor.current?.redo()}
                >
                  <Redo2 size={17} />
                </button>
                <label className="upload-button" title="添加附件">
                  <Paperclip size={17} />
                  <input
                    type="file"
                    aria-label="添加附件"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const form = new FormData();
                      form.append("file", file);
                      try {
                        const r = await api("/attachments", {
                          method: "POST",
                          body: form,
                        });
                        editor.current?.insert("\n" + r.link + "\n");
                      } catch (err) {
                        handle(err);
                      }
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              <div>
                <button onClick={() => setPreview(!preview)}>
                  {preview ? <PenLine size={16} /> : <Eye size={16} />}
                  <span>{preview ? "编辑" : "预览"}</span>
                </button>
                <button
                  onClick={() =>
                    api(
                      "/documents/history?path=" + encodeURIComponent(doc.path),
                    )
                      .then((r) => {
                        setHistory(r.versions);
                        setHistoryPreview(null);
                      })
                      .catch(handle)
                  }
                  aria-label="版本历史"
                >
                  <Clock size={17} />
                </button>
                <details className="note-actions">
                  <summary aria-label="更多笔记操作">
                    <MoreHorizontal size={18} />
                  </summary>
                  <div>
                    <button
                      onClick={() => {
                        const next = prompt("新的库内路径", doc.path);
                        if (next && next !== doc.path)
                          mutate("/documents/rename", {
                            path: doc.path,
                            new_path: next,
                            base_hash: doc.hash,
                          })
                            .then((r) => {
                              void refresh();
                              void open(r.path);
                            })
                            .catch(handle);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      onClick={() => {
                        if (confirm("删除这篇笔记？7天内可从恢复区找回。"))
                          mutate(
                            "/documents",
                            { path: doc.path, base_hash: doc.hash },
                            "DELETE",
                          )
                            .then(() => {
                              setDoc(null);
                              setPage("home");
                              void refresh();
                            })
                            .catch(handle);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </details>
              </div>
            </div>
            <div className="note-title">
              <small>{doc.path.split("/").slice(0, -1).join(" / ")}</small>
              <h1>{label(doc.path)}</h1>
            </div>
            {conflict && (
              <section className="conflict" role="alert">
                <h2>这篇笔记在别处更新了</h2>
                <p>你的草稿仍在下方。对照服务器内容合并后，再保存。</p>
                <details>
                  <summary>查看服务器当前内容</summary>
                  <pre>{conflict.content}</pre>
                </details>
                <div>
                  <button
                    onClick={() => {
                      setDoc(conflict);
                      setSaved(conflict.content);
                      setConflict(null);
                    }}
                  >
                    我已合并，保存下方稿件
                  </button>
                  <button
                    onClick={() => {
                      setContent(conflict.content);
                      setSaved(conflict.content);
                      setDoc(conflict);
                      void drafts.remove(conflict.path);
                      setConflict(null);
                    }}
                  >
                    采用服务器版本
                  </button>
                </div>
              </section>
            )}
            <Suspense fallback={<p className="empty">正在打开…</p>}>
              {preview ? (
                <div className="preview-shell">
                  <Preview
                    content={content}
                    paths={paths}
                    onOpen={open}
                    ancestors={[doc.path]}
                  />
                </div>
              ) : (
                <Editor
                  ref={editor}
                  documentPath={doc.path}
                  value={content}
                  onChange={change}
                />
              )}
            </Suspense>
          </main>
        )}
        {page === "items" && items && (
          <main className="items-page">
            <div className="eyebrow">一步一步，继续就好</div>
            <h1>今天，做一点。</h1>
            <p>习惯记下开始，任务对照结果。</p>
            {items.assistant && (
              <AssistantControls data={items.assistant} command={command} />
            )}
            {[items.planning, items.tomorrow]
              .filter(Boolean)
              .map((agenda: any, i: number) => (
                <section className="agenda" key={agenda.date}>
                  <div className="section-top">
                    <h2>{i === 0 ? "今天的安排" : "明天的安排"}</h2>
                    <button
                      onClick={() =>
                        void command({
                          type: "plan_day",
                          business_date: agenda.date,
                        })
                      }
                    >
                      整理安排
                    </button>
                  </div>
                  {agenda.plans.length ? (
                    agenda.plans.map((p: any) => (
                      <div className="agenda-row" key={p.id}>
                        <time>
                          {new Date(p.window_start).toLocaleTimeString(
                            "zh-CN",
                            {
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZone: "Asia/Shanghai",
                            },
                          )}
                          —
                          {new Date(p.window_end).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: "Asia/Shanghai",
                          })}
                        </time>
                        <div>
                          <strong>{p.next_action}</strong>
                          <small>
                            {p.needs_replan
                              ? "有冲突，等待调整"
                              : p.kind === "fixed"
                                ? "固定安排"
                                : p.execution === "started" ||
                                    p.execution === "progress"
                                  ? "已开始，保留专注时间"
                                  : "按此执行"}
                          </small>
                          {p.preparation.map((ref: any) => (
                            <button
                              className="material-link"
                              key={ref.path}
                              onClick={() => void open(ref.path)}
                            >
                              {label(ref.path)}
                              {ref.heading ? " · " + ref.heading : ""}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="empty">
                      {agenda.status === "not_prepared"
                        ? "前一晚整理，第二天照着做。"
                        : "暂时没有排入任务。"}
                    </p>
                  )}
                  {agenda.issues.length > 0 && (
                    <details
                      className="agenda-issues"
                      open={agenda.status === "needs_user"}
                    >
                      <summary>需要留意的事 · {agenda.issues.length}</summary>
                      {agenda.issues.map((x: any) => (
                        <div key={x.id}>
                          <strong>{x.message}</strong>
                          <p>{x.recommendation}</p>
                        </div>
                      ))}
                    </details>
                  )}
                  {!agenda.preferences.availability.length &&
                    !agenda.preferences.day_overrides.some(
                      (d: any) => d.date === agenda.date,
                    ) && (
                      <button
                        onClick={() => {
                          setAssistant(true);
                          setMessage(agenda.date + "可以安排任务的时间是：");
                        }}
                      >
                        告诉助理可用时间
                      </button>
                    )}
                </section>
              ))}
            <section>
              <div className="section-top">
                <h2>习惯</h2>
                <button onClick={() => setAssistant(true)}>
                  <Plus size={15} />
                  交代新习惯
                </button>
              </div>
              {items.habits
                .filter((h: any) => h.status === "active")
                .map((h: any) => (
                  <div className="item-row" key={h.id}>
                    <button
                      className={
                        "round-check " +
                        (h.occurrence?.status === "did" ? "checked" : "")
                      }
                      aria-label={"记录习惯：" + h.title}
                      onClick={() =>
                        void command({
                          type: "report_habit",
                          target_id: h.id,
                          expected_version: h.version,
                          business_date: home?.date,
                          status:
                            h.occurrence?.status === "did"
                              ? "unreported"
                              : "did",
                        })
                      }
                    >
                      {h.occurrence?.status === "did" && <Check size={15} />}
                    </button>
                    <div>
                      <strong>{h.title}</strong>
                      <small>{h.min_behavior}</small>
                    </div>
                    <button
                      onClick={() =>
                        void command({ type: "pause_contact", target_id: h.id })
                      }
                    >
                      今天不提醒
                    </button>
                  </div>
                ))}
              {!items.habits.length && (
                <p className="empty">
                  还没有习惯。告诉助理一个你想持续的小动作就好。
                </p>
              )}
            </section>
            <section>
              <div className="section-top">
                <h2>任务</h2>
                <button onClick={() => setAssistant(true)}>
                  <Plus size={15} />
                  交代新任务
                </button>
              </div>
              {items.tasks
                .filter((t: any) => t.status !== "cancelled")
                .map((t: any) => (
                  <div className="item-row" key={t.id}>
                    <button
                      className={
                        "round-check " + (t.status === "done" ? "checked" : "")
                      }
                      aria-label={"完成任务：" + t.title}
                      onClick={() =>
                        void command({
                          type:
                            t.status === "done"
                              ? "reopen_task"
                              : "complete_task",
                          target_id: t.id,
                          expected_version: t.version,
                        })
                      }
                    >
                      {t.status === "done" && <Check size={15} />}
                    </button>
                    <div>
                      <strong>{t.title}</strong>
                      <small>
                        {t.acceptance.map((a: any) => a.description).join("；")}
                      </small>
                      {t.due_at && (
                        <small>
                          截止 {new Date(t.due_at).toLocaleString("zh-CN")}
                        </small>
                      )}
                      {t.planning?.next_action && (
                        <small>下一步：{t.planning.next_action}</small>
                      )}
                      {t.planning?.blocker && (
                        <small>卡在：{t.planning.blocker.detail}</small>
                      )}
                      {!["draft", "done", "cancelled"].includes(t.status) && (
                        <div className="execution-actions">
                          <button
                            onClick={() =>
                              void command({
                                type: "report_execution",
                                target_id: t.id,
                                expected_version: t.version,
                                execution: "started",
                              })
                            }
                          >
                            开始了
                          </button>
                          <button
                            onClick={() =>
                              void command({
                                type: "report_execution",
                                target_id: t.id,
                                expected_version: t.version,
                                execution: "not_done",
                                report: "本次暂未完成",
                              })
                            }
                          >
                            这次没做完
                          </button>
                          <button
                            onClick={() => {
                              setAssistant(true);
                              setMessage("「" + t.title + "」卡在：");
                            }}
                          >
                            卡住了
                          </button>
                        </div>
                      )}
                    </div>
                    <span className="status-tag">
                      {t.status === "done"
                        ? "已完成"
                        : t.progress.verification_pending
                          ? "待验证"
                          : t.status === "draft"
                            ? "草案"
                            : t.status === "blocked"
                              ? "暂时受阻"
                              : "进行中"}
                    </span>
                  </div>
                ))}
              {!items.tasks.length && (
                <p className="empty">把需要做到的结果交代给助理。</p>
              )}
            </section>
            {items.proposals.map((p: any) => (
              <section className="proposal" key={p.id}>
                <h2>待接受的安排</h2>
                <p>{p.summary}</p>
                <button
                  className="primary"
                  onClick={() =>
                    mutate("/proposals/" + p.id + "/accept", {
                      version: p.version,
                    })
                      .then(refresh)
                      .catch(handle)
                  }
                >
                  按这个安排
                </button>
              </section>
            ))}
          </main>
        )}
        {page === "status" && (
          <main className="items-page">
            <div className="eyebrow">保持简单，稳定运行</div>
            <h1>设置与状态</h1>
            <section className="assistant-actions">
              <a
                className="button"
                href="/api/v1/export"
                download="secretary-data.json"
              >
                导出我的数据
              </a>
              <button
                onClick={() =>
                  api("/items")
                    .then((r) =>
                      mutate("/commands", {
                        type: "set_personal_rule",
                        key: "contact.enabled",
                        value: false,
                        expected_rules_revision: r.assistant.rules_revision,
                      }),
                    )
                    .then(() => {
                      setNotice(
                        "已停止主动联系；你仍可查看、编辑和发消息。恢复时对助理说‘恢复主动联系’即可。",
                      );
                      return refresh();
                    })
                    .catch(handle)
                }
              >
                停止主动联系
              </button>
            </section>
            {status && (
              <section>
                {[
                  ["QQ", status.qq.connected ? "已连接" : "未连接"],
                  ["理解服务", status.agent.configured ? "已配置" : "未配置"],
                  [
                    "最近调度",
                    status.scheduler.last_tick
                      ? new Date(status.scheduler.last_tick).toLocaleString(
                          "zh-CN",
                        )
                      : "尚未执行",
                  ],
                  [
                    "GitHub 备份",
                    status.backup.enabled
                      ? (status.backup.error ??
                        (status.backup.last_push
                          ? "最近成功 " +
                            new Date(status.backup.last_push).toLocaleString(
                              "zh-CN",
                            )
                          : "等待推送"))
                      : "未启用",
                  ],
                  [
                    "运行记录",
                    `${(status.database_bytes / 1024).toFixed(0)} KiB`,
                  ],
                  ["恢复期", status.recovery_until ?? "正常"],
                ].map(([title, value]) => (
                  <div className="setting-row" key={title}>
                    <strong>{title}</strong>
                    <span>{value}</span>
                  </div>
                ))}
              </section>
            )}
            <button
              onClick={() => api("/status").then(setStatus).catch(handle)}
            >
              刷新状态
            </button>
            <section>
              <button
                onClick={() =>
                  api("/documents/trash")
                    .then((r) => setTrash(r.entries))
                    .catch(handle)
                }
              >
                最近删除
              </button>
              {trash && (
                <div>
                  {trash.length === 0 && (
                    <p className="empty">没有可恢复的笔记。</p>
                  )}
                  {trash.map((entry) => (
                    <div className="setting-row" key={entry.id}>
                      <span>
                        {label(entry.path)}
                        <small>
                          {new Date(entry.deleted_at).toLocaleDateString(
                            "zh-CN",
                          )}
                        </small>
                      </span>
                      <button
                        onClick={() =>
                          mutate("/documents/recover", {
                            recovery_id: entry.id,
                          })
                            .then(async (r) => {
                              await refresh();
                              setTrash(
                                (list) =>
                                  list?.filter((x) => x.id !== entry.id) ??
                                  null,
                              );
                              await open(r.path);
                            })
                            .catch(handle)
                        }
                      >
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </main>
        )}
      </div>
      {history !== null && doc && (
        <div className="modal-backdrop" onClick={() => setHistory(null)}>
          <section
            className="history-modal"
            role="dialog"
            aria-label="版本历史"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-top">
              <h2>版本历史</h2>
              <button aria-label="关闭历史" onClick={() => setHistory(null)}>
                <X size={18} />
              </button>
            </div>
            {history.length === 0 && (
              <p className="empty">这篇笔记还没有 Git 备份版本。</p>
            )}
            {history.map((version) => (
              <button
                className="history-version"
                key={version.commit}
                onClick={() =>
                  api(
                    "/documents/history/content?path=" +
                      encodeURIComponent(doc.path) +
                      "&commit=" +
                      version.commit,
                  )
                    .then((r) => setHistoryPreview(r))
                    .catch(handle)
                }
              >
                {new Date(version.at).toLocaleString("zh-CN")}
              </button>
            ))}
            {historyPreview && (
              <>
                <pre className="history-preview">{historyPreview.content}</pre>
                <button
                  className="primary"
                  disabled={dirty || saving || !!conflict}
                  onClick={() =>
                    mutate("/documents/restore", {
                      path: doc.path,
                      commit: historyPreview.commit,
                      base_hash: doc.hash,
                    })
                      .then(async (next) => {
                        setDoc(next);
                        setContent(next.content);
                        setSaved(next.content);
                        await drafts.remove(next.path);
                        setHistory(null);
                        void refresh();
                      })
                      .catch(handle)
                  }
                >
                  将此版本恢复为当前内容
                </button>
                {dirty && (
                  <p className="empty">当前修改保存后可以恢复旧版本。</p>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {search !== null && (
        <div className="modal-backdrop" onClick={() => setSearch(null)}>
          <section
            className="search-modal"
            role="dialog"
            aria-label="搜索笔记"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <Search size={20} />
              <input
                autoFocus
                aria-label="搜索关键词"
                placeholder="搜索你写过的内容…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button onClick={() => setSearch(null)} aria-label="关闭搜索">
                <X size={17} />
              </button>
            </div>
            <div className="search-results">
              {results.map((r) => (
                <button
                  key={r.path}
                  onClick={() => {
                    setSearch(null);
                    void open(r.path);
                  }}
                >
                  <strong>{label(r.path)}</strong>
                  <small>{r.snippet}</small>
                </button>
              ))}
              {search && !results.length && <p>没有找到相应笔记。</p>}
            </div>
          </section>
        </div>
      )}
      {newName !== null && (
        <div className="modal-backdrop">
          <section className="new-modal" role="dialog" aria-label="新建笔记">
            <button
              className="modal-close"
              aria-label="关闭新建"
              onClick={() => setNewName(null)}
            >
              <X size={18} />
            </button>
            <h2>新建笔记</h2>
            <label htmlFor="new-path">库内路径</label>
            <input
              id="new-path"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="primary" onClick={() => void createNote()}>
              创建笔记
            </button>
          </section>
        </div>
      )}
      {assistant && (
        <aside className="assistant-panel" aria-label="私人助理">
          <header>
            <span>
              <MessageCircle size={18} />
              交代一件事
            </span>
            <button aria-label="关闭助理" onClick={() => setAssistant(false)}>
              <X size={18} />
            </button>
          </header>
          <div className="conversation">
            {!messages.length && (
              <p className="empty">把事情交给我，安排和记录由我承接。</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={"bubble " + m.role}>
                {m.text}
              </div>
            ))}
            {pendingInputs.length > 0 && <small>已收到，正在处理…</small>}
          </div>
          <form onSubmit={sendMessage}>
            {page === "notes" && doc && (
              <label className="scope-toggle">
                <input
                  type="checkbox"
                  checked={includeCurrentNote}
                  onChange={(e) => setIncludeCurrentNote(e.target.checked)}
                />
                本次引用当前笔记
              </label>
            )}
            <textarea
              aria-label="交代内容"
              placeholder="例如：每天晚上8点提醒我读一句英语"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />
            <button
              className="primary"
              disabled={!message.trim()}
              type="submit"
            >
              交代给助理 <ArrowRight size={16} />
            </button>
          </form>
        </aside>
      )}
    </div>
  );
}
function AssistantControls({
  data,
  command,
}: {
  data: any;
  command: (body: unknown) => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now()),
    [evening, setEvening] = useState(data.planning.evening_time),
    [start, setStart] = useState("09:00"),
    [end, setEnd] = useState("18:00"),
    [showHourly, setShowHourly] = useState(false),
    [busy, setBusy] = useState(false);
  const revision = useRef(data.rules_revision),
    offset = useRef(Date.parse(data.now) - Date.now()),
    focus = data.focus;
  useEffect(() => {
    offset.current = Date.parse(data.now) - Date.now();
  }, [data.now]);
  useEffect(() => {
    if (focus?.status !== "active") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [focus?.status]);
  async function send(body: unknown) {
    setBusy(true);
    try {
      await command(body);
    } finally {
      setBusy(false);
    }
  }
  const focusAction = (type: string) =>
    send({ type, target_id: focus.id, expected_version: focus.version });
  const active = (data.automations ?? []).filter(
      (x: any) => x.status !== "retired",
    ),
    hourly = active.find((x: any) => x.kind === "hourly_checkin"),
    remaining =
      focus?.status === "active"
        ? Math.max(0, Date.parse(focus.phase_due_at) - now - offset.current)
        : (focus?.remaining_ms ?? 0);
  const labels: Record<string, string> = {
    "planning.evening_time": "晚间规划",
    "contact.style": "表达方式",
    "contact.quiet_hours": "静默时段",
    "contact.suggestion_cap": "每日额外建议上限",
    "contact.minimum_gap_minutes": "额外建议间隔（分钟）",
    "recording.to_diary": "回顾写入日记",
    "review.weekly_day": "周回看（星期）",
    "review.enabled": "周期回看",
    "planning.enabled": "自动规划",
    "planning.availability": "可用时间",
    "planning.protected": "保护时段",
    "planning.day_overrides": "单日安排",
    "contact.focus_protection": "专注保护",
  };
  const display = (v: any) =>
    typeof v === "boolean"
      ? v
        ? "开启"
        : "关闭"
      : Array.isArray(v)
        ? `${v.length}个时段`
        : v && typeof v === "object"
          ? `${v.start ?? ""}—${v.end ?? ""}`
          : String(v);
  return (
    <section className="assistant-controls" aria-label="助理规则与专注">
      <div className="section-top">
        <h2>按自己的节奏</h2>
        <button
          disabled={busy}
          onClick={() =>
            void send({
              type: "pause_contact",
              ends_at: new Date(
                Date.now() + offset.current + 3600000,
              ).toISOString(),
            })
          }
        >
          暂停联系1小时
        </button>
        <button
          disabled={busy}
          onClick={() => void send({ type: "resume_contact" })}
        >
          恢复联系
        </button>
      </div>
      <div className="assistant-shortcuts">
        {focus &&
        ["active", "paused", "needs_resume"].includes(focus.status) ? (
          <div role="group" aria-label="当前专注">
            <strong>
              {focus.status === "needs_resume"
                ? "中断后待继续"
                : focus.phase === "working"
                  ? "专注"
                  : "休息"}{" "}
              · 第{focus.round_index}/{focus.rounds}轮
            </strong>
            <output aria-label="计时剩余">
              {Math.ceil(remaining / 60000)}分钟
            </output>
            {focus.status === "active" ? (
              <button
                disabled={busy}
                onClick={() => void focusAction("pause_focus")}
              >
                暂停计时
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => void focusAction("resume_focus")}
              >
                继续计时
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => void focusAction("stop_focus")}
            >
              停止计时
            </button>
          </div>
        ) : (
          <button
            disabled={busy}
            onClick={() => void send({ type: "start_focus" })}
          >
            开始专注 · 25/5分钟 × 4轮
          </button>
        )}
        {hourly ? (
          <div role="group" aria-label="小时回顾">
            <span>
              小时回顾 · {hourly.status === "active" ? "已启用" : "已暂停"}
            </span>
            <button
              disabled={busy}
              onClick={() =>
                void send({
                  type: "control_automation",
                  target_id: hourly.id,
                  expected_version: hourly.version,
                  control: hourly.status === "active" ? "skip_today" : "resume",
                })
              }
            >
              {hourly.status === "active" ? "今天不回顾" : "恢复回顾"}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void send({
                  type: "control_automation",
                  target_id: hourly.id,
                  expected_version: hourly.version,
                  control: "stop",
                })
              }
            >
              关闭回顾
            </button>
          </div>
        ) : (
          <button onClick={() => setShowHourly(!showHourly)}>
            设置小时回顾
          </button>
        )}
      </div>
      {showHourly && !hourly && (
        <form
          className="assistant-rule-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send({
              type: "create_automation",
              kind: "hourly_checkin",
              title: "小时回顾",
              schedule: {
                weekdays: [1, 2, 3, 4, 5],
                starts_on: data.business_date,
                local_start: start,
                local_end: end,
                minute: 55,
              },
              to_diary: false,
            });
          }}
        >
          <span>周一到周五，每小时55分；默认不写日记</span>
          <label>
            开始
            <input
              aria-label="小时回顾开始"
              type="time"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            结束
            <input
              aria-label="小时回顾结束"
              type="time"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <button disabled={busy}>启用小时回顾</button>
        </form>
      )}
      <details>
        <summary>规则与自动化</summary>
        <form
          className="assistant-rule-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send({
              type: "set_personal_rule",
              key: "planning.evening_time",
              value: evening,
              expected_rules_revision: revision.current,
            });
          }}
        >
          <label>
            晚间规划
            <input
              aria-label="晚间规划时间"
              type="time"
              required
              value={evening}
              onFocus={() => {
                revision.current = data.rules_revision;
              }}
              onChange={(e) => setEvening(e.target.value)}
            />
          </label>
          <button disabled={busy}>保存规划时间</button>
        </form>
        <p className="muted">
          按服务时区执行；具体范围和表达方式也可以直接告诉助理。
        </p>
        {Object.entries(data.values ?? {})
          .filter(([key]) => labels[key])
          .map(([key, value]) => (
            <p key={key}>
              {labels[key]}：{display(value)}
            </p>
          ))}
        {active
          .filter((a: any) => a.kind !== "hourly_checkin")
          .map((a: any) => (
            <div key={a.id} className="assistant-shortcuts">
              <span>
                {a.title} · {a.status === "active" ? "运行中" : "已暂停"}
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  void send({
                    type: "control_automation",
                    target_id: a.id,
                    expected_version: a.version,
                    control: a.status === "active" ? "pause" : "resume",
                  })
                }
              >
                {a.status === "active" ? "暂停" : "恢复"}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void send({
                    type: "control_automation",
                    target_id: a.id,
                    expected_version: a.version,
                    control: "stop",
                  })
                }
              >
                停止
              </button>
            </div>
          ))}
      </details>
    </section>
  );
}
function Space({
  title,
  subtitle,
  text,
  icon,
  color,
  onClick,
}: {
  title: string;
  subtitle: string;
  text: string;
  icon: React.ReactNode;
  color: string;
  onClick: () => void;
}) {
  return (
    <button className={"space " + color} onClick={onClick}>
      <span className="space-icon">{icon}</span>
      <strong>
        {title}
        <span>{subtitle}</span>
      </strong>
      <p>{text}</p>
      <span className="space-enter">
        进入 <ArrowRight size={14} />
      </span>
    </button>
  );
}
function FileTree({
  paths,
  prefix,
  selected,
  onOpen,
}: {
  paths: string[];
  prefix: string;
  selected?: string;
  onOpen: (p: string) => void;
}) {
  const directories = [
    ...new Set(
      paths
        .map((p) => p.slice(prefix.length + 1))
        .filter((p) => p.includes("/"))
        .map((p) => p.split("/")[0]),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  return (
    <>
      {directories.map((dir) => (
        <TreeFolder
          key={prefix + "/" + dir}
          paths={paths.filter((p) => p.startsWith(prefix + "/" + dir + "/"))}
          prefix={prefix + "/" + dir}
          title={dir}
          selected={selected}
          onOpen={onOpen}
        />
      ))}
      {paths
        .filter((p) => !p.slice(prefix.length + 1).includes("/"))
        .map((p) => (
          <button
            key={p}
            title={p}
            className={selected === p ? "selected" : ""}
            onClick={() => onOpen(p)}
          >
            {label(p)}
          </button>
        ))}
    </>
  );
}
function TreeFolder(props: {
  paths: string[];
  prefix: string;
  title: string;
  selected?: string;
  onOpen: (p: string) => void;
}) {
  const [expanded, setExpanded] = useState(
    !!props.selected?.startsWith(props.prefix + "/"),
  );
  useEffect(() => {
    if (props.selected?.startsWith(props.prefix + "/")) setExpanded(true);
  }, [props.selected, props.prefix]);
  return (
    <details
      className="nested-folder"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{props.title}</summary>
      {expanded && <FileTree {...props} />}
    </details>
  );
}
function Heatmap({
  entries,
  date,
  onOpen,
}: {
  entries: { date: string; path: string }[];
  date: string;
  onOpen: (p: string) => void;
}) {
  const today = new Date(date + "T12:00:00Z"),
    map = new Map(entries.map((e) => [e.date, e.path]));
  const days = Array.from({ length: 182 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - 181 + i);
    return d.toISOString().slice(0, 10);
  });
  return (
    <div className="heatmap-wrap">
      <div className="heatmap" aria-label="日记热力图">
        {days.map((d) => (
          <button
            key={d}
            aria-label={d + (map.has(d) ? " 有日记" : " 无日记")}
            title={d}
            className={map.has(d) ? "has-note" : ""}
            disabled={!map.has(d)}
            onClick={() => void onOpen(map.get(d)!)}
          />
        ))}
      </div>
      <div className="heatmap-caption">
        <span>过去半年</span>
        <span>
          <i />
          未记录
          <i className="filled" />
          已记录
        </span>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
