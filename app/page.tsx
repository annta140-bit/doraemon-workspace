"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type WorkspaceView = "browse" | "capture";
type NoteStatus = "raw" | "linked" | "organized";
type SidebarFilter = "all" | "raw" | "tasks" | "projects" | "deferred" | "done";
type CanvasTool = "pen" | "marker" | "eraser";

type Note = {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  status: NoteStatus;
  projectId?: string;
  tasks: { id: string; title: string; due?: string; done: boolean }[];
  drawing?: string;
  accent: "blue" | "mint" | "lilac" | "sand";
};

type Project = {
  id: string;
  name: string;
  icon: string;
  progress: number;
  nextAction: string;
  accent: Note["accent"];
};

type GitHubConfig = {
  owner: string;
  repo: string;
  branch: string;
  path: string;
};

const PROJECTS: Project[] = [
  { id: "cat", name: "منتج القطة", icon: "🐈‍⬛", progress: 60, nextAction: "اختبار النموذج الأولي", accent: "mint" },
  { id: "dragon", name: "قبعة التنين", icon: "🐉", progress: 40, nextAction: "مراجعة التصاميم", accent: "lilac" },
  { id: "chicken", name: "الدجاجة", icon: "🐓", progress: 75, nextAction: "شراء المواد", accent: "sand" },
  { id: "time", name: "برنامج الوقت", icon: "🕘", progress: 30, nextAction: "تجربة التذكيرات", accent: "blue" },
];

const SEED_NOTES: Note[] = [
  {
    id: "quick-ideas",
    title: "أفكار سريعة",
    summary: "مهام اليوم\n– إرسال التقرير\n– مراجعة عرض المشروع",
    createdAt: "اليوم 9:41 ص",
    updatedAt: "اليوم 9:41 ص",
    status: "raw",
    tasks: [],
    accent: "blue",
  },
  {
    id: "team-meeting",
    title: "اجتماع الفريق غداً 11 ص",
    summary: "شراء أدوات لمكتب ✦",
    createdAt: "أمس 8:43 ص",
    updatedAt: "أمس 8:43 ص",
    status: "linked",
    projectId: "cat",
    tasks: [
      { id: "meet", title: "اجتماع مع الفريق", due: "غداً 11:00 ص", done: false },
      { id: "desk", title: "شراء أدوات مكتبية", done: false },
    ],
    accent: "mint",
  },
  {
    id: "product-map",
    title: "منتج القطة",
    summary: "آمن · صديق للبيئة\nسهل الاستخدام · متين",
    createdAt: "أمس 7:21 م",
    updatedAt: "أمس 7:21 م",
    status: "linked",
    projectId: "cat",
    tasks: [],
    accent: "sand",
  },
  {
    id: "tiny-thought",
    title: "تفصيلة صغيرة",
    summary: "التفاصيل الصغيرة تصنع الفرق الكبير.",
    createdAt: "اليوم 9:12 ص",
    updatedAt: "اليوم 9:12 ص",
    status: "raw",
    tasks: [],
    accent: "lilac",
  },
];

const STATUS_LABELS: Record<NoteStatus, string> = {
  raw: "غير مرتبة",
  linked: "مرتبطة بمشروع",
  organized: "تم تحويلها",
};

const NAV_ITEMS: { id: SidebarFilter; label: string; icon: string }[] = [
  { id: "all", label: "الكل", icon: "▦" },
  { id: "raw", label: "الملاحظات الخام", icon: "▤" },
  { id: "tasks", label: "المهام", icon: "✓" },
  { id: "projects", label: "المشاريع", icon: "▱" },
  { id: "deferred", label: "المؤجل", icon: "◷" },
  { id: "done", label: "المنجز", icon: "◉" },
];

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function formatNow() {
  return `اليوم ${new Intl.DateTimeFormat("ar-MA", { hour: "numeric", minute: "2-digit" }).format(new Date())}`;
}

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function emptyNote(): Note {
  const now = formatNow();
  return {
    id: makeId("note"),
    title: "ملاحظة جديدة",
    summary: "",
    createdAt: now,
    updatedAt: now,
    status: "raw",
    tasks: [],
    accent: "blue",
  };
}

export default function Home() {
  const [view, setView] = useState<WorkspaceView>("browse");
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const [notes, setNotes] = useState<Note[]>(SEED_NOTES);
  const [projects, setProjects] = useState<Project[]>(PROJECTS);
  const [selectedId, setSelectedId] = useState(SEED_NOTES[1].id);
  const [search, setSearch] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [hydrated, setHydrated] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const [toast, setToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [githubConfig, setGithubConfig] = useState<GitHubConfig>({ owner: "", repo: "doraemon-workspace", branch: "main", path: "data/workspace.json" });
  const [githubToken, setGithubToken] = useState("");
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [syncMessage, setSyncMessage] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });
  const historyRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const [tool, setTool] = useState<CanvasTool>("pen");
  const [ink, setInk] = useState("#2f7df6");

  const selectedNote = notes.find((note) => note.id === selectedId) ?? notes[0];

  useEffect(() => {
    const storedNotes = safeParse<Note[]>(localStorage.getItem("doraemon.notes"), SEED_NOTES);
    const storedProjects = safeParse<Project[]>(localStorage.getItem("doraemon.projects"), PROJECTS);
    const storedConfig = safeParse<GitHubConfig | null>(localStorage.getItem("doraemon.github"), null);
    setNotes(storedNotes.length ? storedNotes : SEED_NOTES);
    setProjects(storedProjects.length ? storedProjects : PROJECTS);
    if (storedConfig) setGithubConfig(storedConfig);
    setGithubToken(sessionStorage.getItem("doraemon.github.token") ?? "");
    setSelectedId((current) => (storedNotes.some((note) => note.id === current) ? current : storedNotes[0]?.id ?? SEED_NOTES[0].id));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      localStorage.setItem("doraemon.notes", JSON.stringify(notes));
      localStorage.setItem("doraemon.projects", JSON.stringify(projects));
      setSaveState("saved");
    }, 320);
    return () => window.clearTimeout(timer);
  }, [notes, projects, hydrated]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const counts = useMemo(() => {
    const taskCount = notes.reduce((total, note) => total + note.tasks.filter((task) => !task.done).length, 0);
    const doneCount = notes.reduce((total, note) => total + note.tasks.filter((task) => task.done).length, 0);
    return {
      all: notes.length + projects.length + taskCount,
      raw: notes.filter((note) => note.status === "raw").length,
      tasks: taskCount,
      projects: projects.length,
      deferred: 0,
      done: doneCount,
    };
  }, [notes, projects]);

  const visibleNotes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ar");
    return notes.filter((note) => {
      const matchesSearch = !query || `${note.title} ${note.summary}`.toLocaleLowerCase("ar").includes(query);
      const matchesFilter = filter === "all" || filter === "raw" && note.status === "raw" || filter === "tasks" && note.tasks.length > 0 || filter === "projects" && Boolean(note.projectId) || filter === "done" && note.tasks.some((task) => task.done);
      return matchesSearch && matchesFilter;
    });
  }, [notes, search, filter]);

  const updateSelectedNote = useCallback((updates: Partial<Note>) => {
    setNotes((current) => current.map((note) => note.id === selectedId ? { ...note, ...updates, updatedAt: formatNow() } : note));
  }, [selectedId]);

  const createNote = () => {
    const note = emptyNote();
    setNotes((current) => [note, ...current]);
    setSelectedId(note.id);
    setView("capture");
    setToast("تم إنشاء ملاحظة جديدة");
  };

  const renderCanvasImage = useCallback((drawing?: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    if (drawing) {
      const image = new Image();
      image.onload = () => context.drawImage(image, 0, 0, rect.width, rect.height);
      image.src = drawing;
    }
  }, []);

  useEffect(() => {
    if (view !== "capture") return;
    const frame = requestAnimationFrame(() => renderCanvasImage(selectedNote?.drawing));
    const onResize = () => renderCanvasImage(selectedNote?.drawing);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [view, selectedId, renderCanvasImage, selectedNote?.drawing]);

  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const startDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    lastPointRef.current = canvasPoint(event);
    historyRef.current.push(selectedNote?.drawing ?? "");
    if (historyRef.current.length > 20) historyRef.current.shift();
    redoRef.current = [];
  };

  const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const next = canvasPoint(event);
    context.save();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.beginPath();
    context.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    context.lineTo(next.x, next.y);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = ink;
    context.lineWidth = tool === "marker" ? 14 : tool === "eraser" ? 24 : event.pointerType === "pen" && event.pressure ? 1.5 + event.pressure * 3.5 : 3.4;
    context.globalAlpha = tool === "marker" ? 0.2 : 1;
    context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    context.stroke();
    context.restore();
    lastPointRef.current = next;
  };

  const stopDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    updateSelectedNote({ drawing: event.currentTarget.toDataURL("image/webp", 0.78) });
  };

  const restoreSnapshot = (snapshot: string) => {
    updateSelectedNote({ drawing: snapshot || undefined });
    requestAnimationFrame(() => renderCanvasImage(snapshot || undefined));
  };

  const undo = () => {
    const snapshot = historyRef.current.pop();
    if (snapshot === undefined) return;
    redoRef.current.push(selectedNote?.drawing ?? "");
    restoreSnapshot(snapshot);
  };

  const redo = () => {
    const snapshot = redoRef.current.pop();
    if (snapshot === undefined) return;
    historyRef.current.push(selectedNote?.drawing ?? "");
    restoreSnapshot(snapshot);
  };

  const clearCanvas = () => {
    if (!selectedNote?.drawing || !window.confirm("مسح الرسم من هذه الملاحظة؟")) return;
    historyRef.current.push(selectedNote.drawing);
    restoreSnapshot("");
  };

  const organizeNote = () => {
    if (!selectedNote) return;
    const fallbackTasks = selectedNote.tasks.length ? selectedNote.tasks : [
      { id: makeId("task"), title: selectedNote.title === "ملاحظة جديدة" ? "مراجعة الملاحظة وتحديد الخطوة التالية" : selectedNote.title, done: false },
    ];
    updateSelectedNote({ status: "organized", tasks: fallbackTasks, projectId: selectedNote.projectId ?? "cat" });
    setToast("تم حفظ الملاحظة وتحويلها إلى مهمة");
  };

  const toggleTask = (noteId: string, taskId: string) => {
    setNotes((current) => current.map((note) => note.id === noteId ? {
      ...note,
      tasks: note.tasks.map((task) => task.id === taskId ? { ...task, done: !task.done } : task),
      updatedAt: formatNow(),
    } : note));
  };

  const saveGithubConfig = () => {
    localStorage.setItem("doraemon.github", JSON.stringify(githubConfig));
    if (githubToken) sessionStorage.setItem("doraemon.github.token", githubToken);
    else sessionStorage.removeItem("doraemon.github.token");
  };

  const githubRequest = async (method: "GET" | "PUT") => {
    const { owner, repo, branch, path } = githubConfig;
    if (!owner || !repo || !branch || !path || !githubToken) throw new Error("أكمل بيانات المستودع ورمز الوصول أولاً");
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
    if (method === "GET") {
      const response = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
      if (!response.ok) throw new Error(response.status === 404 ? "ملف المزامنة غير موجود بعد" : `تعذّر القراءة من GitHub (${response.status})`);
      return response.json();
    }
    let sha: string | undefined;
    const existing = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
    if (existing.ok) sha = (await existing.json()).sha;
    else if (existing.status !== 404) throw new Error(`تعذّر فحص الملف الحالي (${existing.status})`);
    const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), notes, projects }, null, 2);
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ message: `مزامنة مساحة العمل — ${new Date().toLocaleString("ar-MA")}`, content: encodeBase64(payload), branch, ...(sha ? { sha } : {}) }),
    });
    if (!response.ok) throw new Error(`تعذّرت الكتابة إلى GitHub (${response.status})`);
    return response.json();
  };

  const pushToGithub = async () => {
    setSyncState("syncing");
    setSyncMessage("جارٍ رفع آخر نسخة…");
    try {
      await githubRequest("PUT");
      saveGithubConfig();
      setSyncState("done");
      setSyncMessage("تمت المزامنة مع GitHub بنجاح");
      setToast("المساحة متزامنة مع GitHub");
    } catch (error) {
      setSyncState("error");
      setSyncMessage(error instanceof Error ? error.message : "تعذّرت المزامنة");
    }
  };

  const pullFromGithub = async () => {
    setSyncState("syncing");
    setSyncMessage("جارٍ جلب آخر نسخة…");
    try {
      const response = await githubRequest("GET");
      const remote = JSON.parse(decodeBase64(response.content)) as { notes?: Note[]; projects?: Project[] };
      if (remote.notes?.length) setNotes(remote.notes);
      if (remote.projects?.length) setProjects(remote.projects);
      saveGithubConfig();
      setSyncState("done");
      setSyncMessage("تم جلب آخر نسخة من GitHub");
      setToast("تم تحديث المساحة من GitHub");
    } catch (error) {
      setSyncState("error");
      setSyncMessage(error instanceof Error ? error.message : "تعذّر جلب البيانات");
    }
  };

  return (
    <main className="workspace-shell" dir="rtl">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setView("browse")} aria-label="العودة إلى مساحة العمل">
          <span className="brand-mark" aria-hidden="true">◉</span>
          <span>مساحة <b>Doraemon</b></span>
          <span className="chevron">‹</span>
        </button>
        <nav className="view-tabs" aria-label="طريقة العرض">
          <button className={view === "browse" ? "active" : ""} onClick={() => setView("browse")} type="button">تصفّح</button>
          <button className={view === "capture" ? "active" : ""} onClick={() => setView("capture")} type="button"><span>✎</span> التقاط</button>
        </nav>
        <div className="top-actions">
          <button className="save-pill" type="button" onClick={() => setSettingsOpen(true)}>
            <span className={saveState === "saved" ? "status-dot" : "status-dot saving"} />
            {saveState === "saved" ? "محفوظ تلقائياً" : "جارٍ الحفظ…"}
          </button>
          <button className={`github-button ${syncState === "done" ? "synced" : ""}`} type="button" onClick={() => setSettingsOpen(true)} aria-label="إعداد مزامنة GitHub">
            {syncState === "done" ? "GitHub ✓" : "GitHub"}
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-spacer" />
        <div className="nav-list">
          {NAV_ITEMS.map((item) => (
            <button key={item.id} className={filter === item.id ? "nav-item active" : "nav-item"} type="button" onClick={() => { setFilter(item.id); setView("browse"); }}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
              <span className="nav-count">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <div className="filter-block">
          <div className="filter-title"><span>▽</span> فلتر</div>
          <div><i className="swatch raw" />غير مرتبة <span>{counts.raw}</span></div>
          <div><i className="swatch linked" />مرتبطة بمشروع <span>{notes.filter((note) => note.projectId).length}</span></div>
          <div><i className="swatch organized" />تم تحويلها <span>{notes.filter((note) => note.status === "organized").length}</span></div>
        </div>
        <button className="new-note" type="button" onClick={createNote}><span>＋</span> ملاحظة جديدة</button>
      </aside>

      {view === "browse" ? (
        <section className="browse-view">
          <div className="browse-toolbar">
            <div className="search-box"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث في ملاحظاتك ومشاريعك" aria-label="بحث" /></div>
            <div className="layout-switch" aria-label="تخطيط العرض">
              <button className={layout === "list" ? "active" : ""} onClick={() => setLayout("list")} type="button">☷ <span>قائمة</span></button>
              <button className={layout === "grid" ? "active" : ""} onClick={() => setLayout("grid")} type="button">▦ <span>شبكة</span></button>
            </div>
          </div>

          <div className="content-scroll">
            <div className="section-heading"><h2>ملاحظات خام</h2><button type="button" onClick={() => setFilter("all")}>عرض الكل</button></div>
            {visibleNotes.length ? (
              <div className={`note-grid ${layout === "list" ? "list" : ""}`}>
                {visibleNotes.slice(0, layout === "grid" ? 3 : 5).map((note) => (
                  <article key={note.id} className={`note-card accent-${note.accent} ${selectedId === note.id ? "selected" : ""}`} onClick={() => setSelectedId(note.id)}>
                    <div className="card-top"><time>{note.createdAt}</time><button type="button" aria-label="خيارات الملاحظة">⋮</button></div>
                    <div className="note-ink">
                      {note.drawing ? <img src={note.drawing} alt="معاينة الرسم" /> : <><h3>{note.title}</h3><p>{note.summary}</p></>}
                    </div>
                    <div className="card-bottom"><button className={`tag tag-${note.status}`} type="button">{STATUS_LABELS[note.status]}</button><button type="button" aria-label="خيارات أخرى">⋮</button></div>
                  </article>
                ))}
              </div>
            ) : <div className="empty-state"><span>⌕</span><h3>لا توجد نتائج</h3><p>جرّب كلمة أخرى أو أنشئ ملاحظة جديدة.</p></div>}

            <div className="section-heading projects-heading"><h2>المشاريع</h2><button type="button">عرض الكل</button></div>
            <div className="project-grid">
              {projects.map((project) => (
                <article key={project.id} className={`project-card accent-${project.accent}`}>
                  <div className="project-hero"><span>{project.icon}</span><h3>{project.name}</h3><p>{notes.filter((note) => note.projectId === project.id).reduce((total, note) => total + note.tasks.length, 0) || 4} مهام</p></div>
                  <div className="project-details"><small>الإجراء التالي</small><p>{project.nextAction}</p><div className="progress-row"><b>{project.progress}%</b><div><i style={{ width: `${project.progress}%` }} /></div></div></div>
                </article>
              ))}
            </div>
          </div>

          <aside className="detail-panel">
            {selectedNote ? <>
              <div className="detail-time"><time>{selectedNote.createdAt}</time><button type="button">⋮</button></div>
              <div className="detail-note">
                {selectedNote.drawing ? <img src={selectedNote.drawing} alt="رسم الملاحظة" /> : <><h2>{selectedNote.title}</h2><p>{selectedNote.summary}</p></>}
              </div>
              <button className={`tag tag-${selectedNote.status}`} type="button">{STATUS_LABELS[selectedNote.status]} ‹</button>
              <div className="converted-title"><span>✦</span> تم تحويلها إلى</div>
              <div className="detail-box tasks-box">
                <div><h3>مهام</h3><span>{selectedNote.tasks.length}</span></div>
                {selectedNote.tasks.length ? selectedNote.tasks.map((task) => (
                  <label key={task.id} className={task.done ? "done" : ""}><input type="checkbox" checked={task.done} onChange={() => toggleTask(selectedNote.id, task.id)} /><span>{task.title}</span><time>{task.due}</time></label>
                )) : <p className="muted">لم تُستخرج مهام بعد.</p>}
              </div>
              <div className="detail-box linked-box"><h3>مشروع مرتبط</h3><div><span>{projects.find((project) => project.id === selectedNote.projectId)?.icon ?? "◌"}</span>{projects.find((project) => project.id === selectedNote.projectId)?.name ?? "غير مرتبط بعد"}<b>‹</b></div></div>
              <div className="detail-box"><h3>مؤجل</h3><p className="muted">لا توجد عناصر مؤجلة من هذه الملاحظة.</p></div>
              <button className="open-capture" type="button" onClick={() => setView("capture")}>فتح الملاحظة بالقلم</button>
            </> : null}
          </aside>
        </section>
      ) : (
        <section className="capture-view">
          <aside className="notes-rail">
            <h2>الملاحظات الخام <span>▤</span></h2>
            <div className="rail-scroll">
              {notes.map((note) => (
                <button key={note.id} className={selectedId === note.id ? "rail-note active" : "rail-note"} type="button" onClick={() => setSelectedId(note.id)}>
                  <div><time>{note.createdAt}</time><span>⋮</span></div>
                  {note.drawing ? <img src={note.drawing} alt="معاينة الملاحظة" /> : <><strong>{note.title}</strong><p>{note.summary}</p></>}
                  <small>{STATUS_LABELS[note.status]}</small>
                </button>
              ))}
            </div>
            <button className="new-note" type="button" onClick={createNote}><span>＋</span> ملاحظة جديدة</button>
          </aside>

          <div className="capture-main">
            <div className="capture-hint"><span>✦</span> اكتب بحرية، وسأرتبها لاحقاً</div>
            <div className="paper-wrap">
              <input className="note-title-input" value={selectedNote?.title ?? ""} onChange={(event) => updateSelectedNote({ title: event.target.value })} aria-label="عنوان الملاحظة" />
              <canvas ref={canvasRef} className="ink-canvas" onPointerDown={startDrawing} onPointerMove={draw} onPointerUp={stopDrawing} onPointerCancel={stopDrawing} aria-label="مساحة الكتابة بالقلم" />
              {!selectedNote?.drawing && <div className="canvas-placeholder"><span>✎</span><p>ابدأ الكتابة أو الرسم بالقلم هنا</p><small>كل ضربة تُحفظ تلقائياً على هذا الجهاز</small></div>}
              <div className="drawing-tools" aria-label="أدوات الرسم">
                <button className={tool === "pen" ? "active" : ""} onClick={() => setTool("pen")} type="button" title="قلم">✎</button>
                <button className={tool === "marker" ? "active" : ""} onClick={() => setTool("marker")} type="button" title="قلم تمييز">▰</button>
                <button className={tool === "eraser" ? "active" : ""} onClick={() => setTool("eraser")} type="button" title="ممحاة">▱</button>
                <label className="color-picker" title="لون القلم"><input type="color" value={ink} onChange={(event) => setInk(event.target.value)} /><span style={{ backgroundColor: ink }} /></label>
                <i />
                <button type="button" onClick={undo} title="تراجع">↶</button>
                <button type="button" onClick={redo} title="إعادة">↷</button>
                <button type="button" onClick={clearCanvas} title="مسح">•••</button>
              </div>
              <button className="organize-button" type="button" onClick={organizeNote}><span>✦</span> رتّبها لاحقاً</button>
            </div>
          </div>
        </section>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="github-title">
            <div className="modal-header"><div><span className="github-logo">GH</span><div><h2 id="github-title">مزامنة GitHub</h2><p>احفظ مساحة العمل في ملف واحد داخل مستودعك.</p></div></div><button type="button" onClick={() => setSettingsOpen(false)} aria-label="إغلاق">×</button></div>
            <div className="security-note"><b>النسخة الحالية:</b> استخدم Fine-grained token بصلاحية <code>Contents: read/write</code> على مستودع واحد فقط. الرمز يبقى في جلسة المتصفح ولا يُحفظ مع البيانات.</div>
            <div className="field-grid">
              <label><span>اسم المستخدم أو المؤسسة</span><input value={githubConfig.owner} onChange={(event) => setGithubConfig({ ...githubConfig, owner: event.target.value.trim() })} placeholder="username" dir="ltr" /></label>
              <label><span>اسم المستودع</span><input value={githubConfig.repo} onChange={(event) => setGithubConfig({ ...githubConfig, repo: event.target.value.trim() })} placeholder="doraemon-workspace" dir="ltr" /></label>
              <label><span>الفرع</span><input value={githubConfig.branch} onChange={(event) => setGithubConfig({ ...githubConfig, branch: event.target.value.trim() })} placeholder="main" dir="ltr" /></label>
              <label><span>مسار ملف البيانات</span><input value={githubConfig.path} onChange={(event) => setGithubConfig({ ...githubConfig, path: event.target.value.trim() })} placeholder="data/workspace.json" dir="ltr" /></label>
              <label className="token-field"><span>رمز الوصول المحدود</span><input value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder="github_pat_…" type="password" dir="ltr" autoComplete="off" /></label>
            </div>
            {syncMessage && <div className={`sync-message ${syncState}`}>{syncState === "syncing" && <i />} {syncMessage}</div>}
            <div className="modal-actions"><button className="secondary" type="button" onClick={pullFromGithub} disabled={syncState === "syncing"}>جلب من GitHub</button><button className="primary" type="button" onClick={pushToGithub} disabled={syncState === "syncing"}>حفظ ومزامنة الآن</button></div>
            <p className="modal-footnote">الحفظ بالقلم محلي وفوري دائماً؛ مزامنة GitHub تتم عند طلبك كي لا تُنشئ التزاماً لكل ضربة قلم.</p>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}
