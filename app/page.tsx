"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createDrawingPreviewBase64, DrawingPreview, HandwritingCanvas } from "./handwriting-canvas";
import {
  getRemoteRevision,
  pullRemoteWorkspace,
  pushDirtyWorkspace,
  SyncConflictError,
} from "./github-sync";
import {
  loadWorkspace,
  saveWorkspace,
  saveWorkspaceBackup,
} from "./workspace-storage";
import {
  DEFAULT_GITHUB_CONFIG,
  emptyNote,
  emptyProject,
  formatTime,
  githubDestination,
  makeId,
  noteContentSignature,
  nowIso,
  projectProgress,
  projectContentSignature,
  type CanvasTool,
  type GitHubConfig,
  type Note,
  type PersistedWorkspace,
  type Project,
  type SidebarFilter,
  type Stroke,
  type SyncMetadata,
  type WorkspaceView,
} from "./workspace-model";

type SaveState = "saved" | "saving" | "error";
type SyncState = "local" | "pending" | "syncing" | "done" | "conflict" | "error";
type CanvasSnapshot = { strokes: Stroke[]; drawing?: string };

const EMPTY_SYNC: SyncMetadata = {
  shas: {},
  projectSignatures: {},
  dirtyNoteIds: [],
  dirtyProjectIds: [],
  projectsDirty: false,
};
const TOKEN_SESSION_KEY = "doraemon.github.token.v2";
const STARTER_PLACEHOLDER_KEY = "doraemon.starter-placeholder.v2";

type StarterPlaceholderState = {
  noteId: string;
  untouched: boolean;
};

const NAV_ITEMS: { id: SidebarFilter; label: string; icon: string }[] = [
  { id: "all", label: "الكل", icon: "▦" },
  { id: "raw", label: "الملاحظات الخام", icon: "▤" },
  { id: "tasks", label: "المهام", icon: "✓" },
  { id: "projects", label: "المشاريع", icon: "▱" },
  { id: "queued", label: "بانتظار التنظيم", icon: "✦" },
  { id: "deferred", label: "المؤجل", icon: "◷" },
  { id: "done", label: "المنجز", icon: "◉" },
];

const STATUS_LABELS: Record<Note["status"], string> = {
  raw: "غير مرتبة",
  linked: "مرتبطة بمشروع",
  organized: "تم تنظيمها",
};

function workspaceSnapshot(
  notes: Note[],
  projects: Project[],
  selectedId: string | undefined,
  sync: SyncMetadata,
): PersistedWorkspace {
  return { schemaVersion: 2, notes, projects, selectedId, sync };
}

function isUntouchedStarter(note: Note) {
  return note.title === "أول ملاحظة"
    && !note.summary
    && !note.strokes.length
    && !note.drawing
    && !note.tasks.length
    && note.organization.state === "draft"
    && note.status === "raw"
    && !note.projectId
    && !note.deferred;
}

function readStarterPlaceholder(): StarterPlaceholderState | null {
  try {
    const value = JSON.parse(localStorage.getItem(STARTER_PLACEHOLDER_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object" || !("noteId" in value) || !("untouched" in value)) return null;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.noteId === "string" && typeof candidate.untouched === "boolean"
      ? { noteId: candidate.noteId, untouched: candidate.untouched }
      : null;
  } catch {
    return null;
  }
}

function writeStarterPlaceholder(value: StarterPlaceholderState | null) {
  try {
    if (value) localStorage.setItem(STARTER_PLACEHOLDER_KEY, JSON.stringify(value));
    else localStorage.removeItem(STARTER_PLACEHOLDER_KEY);
  } catch { /* the explicit flag is also kept in memory for this session */ }
}

export default function Home() {
  const [view, setView] = useState<WorkspaceView>("browse");
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const [notes, setNotes] = useState<Note[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [showAllNotes, setShowAllNotes] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [storageWritable, setStorageWritable] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [toast, setToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [githubConfig, setGithubConfig] = useState<GitHubConfig>(DEFAULT_GITHUB_CONFIG);
  const [githubToken, setGithubToken] = useState("");
  const [syncMeta, setSyncMeta] = useState<SyncMetadata>(EMPTY_SYNC);
  const [syncState, setSyncState] = useState<SyncState>("local");
  const [syncInFlight, setSyncInFlight] = useState(false);
  const [syncMessage, setSyncMessage] = useState("محفوظ على هذا الجهاز");
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const [tool, setTool] = useState<CanvasTool>("pen");
  const [ink, setInk] = useState("#2f7df6");
  const [penOnly, setPenOnly] = useState(false);
  const [taskDraft, setTaskDraft] = useState("");
  const [projectDraft, setProjectDraft] = useState({ name: "", icon: "◉", nextAction: "" });
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);

  const notesRef = useRef(notes);
  const projectsRef = useRef(projects);
  const selectedIdRef = useRef(selectedId);
  const syncMetaRef = useRef(syncMeta);
  const configRef = useRef(githubConfig);
  const tokenRef = useRef(githubToken);
  const syncLockRef = useRef(false);
  const destinationEpochRef = useRef(0);
  const projectChangeVersionRef = useRef(0);
  const starterPlaceholderRef = useRef<StarterPlaceholderState | null>(null);
  const undoByNoteRef = useRef<Record<string, CanvasSnapshot[]>>({});
  const redoByNoteRef = useRef<Record<string, CanvasSnapshot[]>>({});

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { syncMetaRef.current = syncMeta; }, [syncMeta]);
  useEffect(() => { configRef.current = githubConfig; }, [githubConfig]);
  useEffect(() => { tokenRef.current = githubToken; }, [githubToken]);

  const selectedNote = notes.find((note) => note.id === selectedId) ?? notes[0];

  const replaceSyncMeta = useCallback((updater: (current: SyncMetadata) => SyncMetadata) => {
    setSyncMeta((current) => {
      const next = updater(current);
      syncMetaRef.current = next;
      return next;
    });
  }, []);

  const markPending = useCallback((message = "تغييرات جديدة تنتظر المزامنة") => {
    setSyncState(tokenRef.current ? "pending" : "local");
    setSyncMessage(tokenRef.current ? message : "محفوظ على الجهاز · اربط GitHub للمزامنة");
    setDirtyVersion((value) => value + 1);
  }, []);

  const markNoteDirty = useCallback((noteId: string) => {
    replaceSyncMeta((current) => ({
      ...current,
      dirtyNoteIds: current.dirtyNoteIds.includes(noteId)
        ? current.dirtyNoteIds
        : [...current.dirtyNoteIds, noteId],
    }));
    markPending();
  }, [markPending, replaceSyncMeta]);

  const markProjectsDirty = useCallback((projectId: string) => {
    projectChangeVersionRef.current += 1;
    replaceSyncMeta((current) => ({
      ...current,
      dirtyProjectIds: current.dirtyProjectIds.includes(projectId)
        ? current.dirtyProjectIds
        : [...current.dirtyProjectIds, projectId],
      projectsDirty: true,
    }));
    markPending();
  }, [markPending, replaceSyncMeta]);

  const setStarterPlaceholder = useCallback((value: StarterPlaceholderState | null) => {
    starterPlaceholderRef.current = value;
    writeStarterPlaceholder(value);
  }, []);

  const updateNote = useCallback((noteId: string, updater: (note: Note) => Note) => {
    const previous = notesRef.current.find((note) => note.id === noteId);
    if (!previous) return;
    const candidate = updater(previous);
    if (noteContentSignature(previous) === noteContentSignature(candidate)) return;
    const updated = { ...candidate, updatedAt: nowIso() };
    const next = notesRef.current.map((note) => note.id === noteId ? updated : note);
    notesRef.current = next;
    setNotes(next);
    const starter = starterPlaceholderRef.current;
    if (starter?.noteId === noteId && starter.untouched) {
      setStarterPlaceholder({ ...starter, untouched: false });
    }
    markNoteDirty(noteId);
  }, [markNoteDirty, setStarterPlaceholder]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await loadWorkspace();
        if (!active) return;
        const firstNote = emptyNote("أول ملاحظة");
        const loadedNotes = loaded?.workspace.notes.length ? loaded.workspace.notes : [firstNote];
        const loadedProjects = loaded?.workspace.projects ?? [];
        const loadedConfig = loaded?.config ?? DEFAULT_GITHUB_CONFIG;
        const destination = githubDestination(loadedConfig);
        const storedSync = loaded
          ? {
              ...loaded.workspace.sync,
              dirtyNoteIds: loaded.workspace.notes.length
                ? loaded.workspace.sync.dirtyNoteIds
                : [...new Set([...loaded.workspace.sync.dirtyNoteIds, firstNote.id])],
            }
          : { ...EMPTY_SYNC, dirtyNoteIds: [firstNote.id] };
        const destinationChanged = Boolean(storedSync.destination && storedSync.destination !== destination)
          || Boolean(!storedSync.destination && Object.keys(storedSync.shas).length);
        const loadedSync: SyncMetadata = destinationChanged ? {
          ...EMPTY_SYNC,
          dirtyNoteIds: loadedNotes.map((note) => note.id),
          dirtyProjectIds: loadedProjects.map((project) => project.id),
          projectsDirty: loadedProjects.length > 0,
          destination,
        } : { ...storedSync, destination };
        const storedStarter = readStarterPlaceholder();
        const validStoredStarter = storedStarter && loadedNotes.some((note) => note.id === storedStarter.noteId)
          ? storedStarter
          : null;
        const inferredLegacyStarter = !loadedSync.lastSyncAt
          && loadedNotes.length === 1
          && isUntouchedStarter(loadedNotes[0])
          ? { noteId: loadedNotes[0].id, untouched: true }
          : null;
        const starterState: StarterPlaceholderState | null = loaded?.workspace.notes.length
          ? validStoredStarter ?? inferredLegacyStarter
          : { noteId: firstNote.id, untouched: true };
        const initialSelected = loaded?.workspace.selectedId && loadedNotes.some((note) => note.id === loaded.workspace.selectedId)
          ? loaded.workspace.selectedId
          : loadedNotes[0].id;

        notesRef.current = loadedNotes;
        projectsRef.current = loadedProjects;
        selectedIdRef.current = initialSelected;
        syncMetaRef.current = loadedSync;
        configRef.current = loadedConfig;
        starterPlaceholderRef.current = starterState;
        writeStarterPlaceholder(starterState);
        setNotes(loadedNotes);
        setProjects(loadedProjects);
        setSelectedId(initialSelected);
        setSyncMeta(loadedSync);
        setGithubConfig(loadedConfig);
        let token = "";
        try {
          sessionStorage.removeItem("doraemon.github.token");
          token = sessionStorage.getItem(TOKEN_SESSION_KEY) ?? "";
        } catch { token = ""; }
        tokenRef.current = token;
        setGithubToken(token);
        let storedPenOnly: string | null = null;
        try { storedPenOnly = localStorage.getItem("doraemon.penOnly"); } catch { storedPenOnly = null; }
        setPenOnly(storedPenOnly === null ? navigator.maxTouchPoints > 0 : storedPenOnly === "true");
        if (loadedSync.dirtyNoteIds.length || loadedSync.projectsDirty) {
          setSyncState(token ? "pending" : "local");
          setSyncMessage(token ? "توجد تغييرات محلية تنتظر GitHub" : "محفوظ على الجهاز · اربط GitHub للمزامنة");
        } else if (loadedSync.lastSyncAt) {
          setSyncState("done");
          setSyncMessage(`آخر مزامنة ${formatTime(loadedSync.lastSyncAt)}`);
        }
        setStorageWritable(true);
        setHydrated(true);
      } catch (error) {
        if (!active) return;
        setSaveState("error");
        setLoadError(error instanceof Error ? error.message : "تعذّر فتح مساحة الحفظ المحلية");
        setHydrated(true);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!hydrated || !storageWritable) return;
    setSaveState("saving");
    void saveWorkspace(
      workspaceSnapshot(notes, projects, selectedId, syncMeta),
      githubConfig,
    ).then(() => setSaveState("saved")).catch(() => {
      setSaveState("error");
      setToast("تعذّر الحفظ على الجهاز؛ اترك الصفحة مفتوحة وحاول المزامنة");
    });
  }, [githubConfig, hydrated, notes, projects, selectedId, storageWritable, syncMeta]);

  useEffect(() => {
    if (!hydrated || !storageWritable) return;
    const flush = () => {
      void saveWorkspace(
        workspaceSnapshot(notesRef.current, projectsRef.current, selectedIdRef.current, syncMetaRef.current),
        configRef.current,
      ).catch(() => undefined);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [hydrated, storageWritable]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (githubToken) sessionStorage.setItem(TOKEN_SESSION_KEY, githubToken);
      else sessionStorage.removeItem(TOKEN_SESSION_KEY);
    } catch {
      setSyncMessage("سيبقى رمز GitHub لهذه الصفحة فقط لأن المتصفح منع تخزين الجلسة");
    }
  }, [githubToken, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem("doraemon.penOnly", String(penOnly)); } catch { /* preference is optional */ }
  }, [hydrated, penOnly]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const pushToGithub = useCallback(async (manual = false) => {
    if (syncLockRef.current) return;
    const config = configRef.current;
    const token = tokenRef.current;
    const snapshot = syncMetaRef.current;
    if (!token || !config.owner || !config.repo || !config.branch || !config.basePath) {
      if (manual) {
        setSettingsOpen(true);
        setSyncState("local");
        setSyncMessage("أكمل الاتصال بالمستودع الخاص أولاً");
      }
      return;
    }
    if (!snapshot.lastSyncAt && Object.keys(snapshot.shas).length === 0) {
      setSyncState("conflict");
      setSyncMessage("هذه أول وصلة بهذا الجهاز؛ اضغط «جلب ودمج بأمان» قبل أول رفع");
      if (manual) setSettingsOpen(true);
      return;
    }
    if (!snapshot.dirtyNoteIds.length && !snapshot.projectsDirty) {
      setSyncState("done");
      setSyncMessage(snapshot.lastSyncAt ? `كل شيء متزامن · ${formatTime(snapshot.lastSyncAt)}` : "لا توجد تغييرات تنتظر الرفع");
      return;
    }

    const operationDestination = githubDestination(config);
    const operationEpoch = destinationEpochRef.current;
    const destinationChangedDuringOperation = () => (
      destinationEpochRef.current !== operationEpoch
      || githubDestination(configRef.current) !== operationDestination
    );
    const ignoreStaleOperation = () => {
      if (!destinationChangedDuringOperation()) return false;
      setSyncState((current) => current === "syncing" ? "pending" : current);
      setSyncMessage((current) => current.startsWith("جارٍ")
        ? "تغيّرت وجهة GitHub؛ تجاهلنا نتيجة العملية السابقة وحافظنا على التغييرات المحلية"
        : current);
      return true;
    };

    syncLockRef.current = true;
    setSyncInFlight(true);
    setSyncState("syncing");
    setSyncMessage("جارٍ رفع التغييرات المحفوظة…");
    const sentNotes = notesRef.current;
    const sentProjects = projectsRef.current;
    const sentTimes = new Map(sentNotes.map((note) => [note.id, note.updatedAt]));
    const sentProjectVersion = projectChangeVersionRef.current;

    try {
      const previews: Record<string, string> = {};
      for (const noteId of snapshot.dirtyNoteIds) {
        const note = sentNotes.find((item) => item.id === noteId);
        if (note) previews[note.id] = await createDrawingPreviewBase64(note.strokes, note.drawing);
      }
      if (ignoreStaleOperation()) return;
      const result = await pushDirtyWorkspace({
        config,
        token,
        notes: sentNotes,
        projects: sentProjects,
        dirtyNoteIds: snapshot.dirtyNoteIds,
        projectsDirty: snapshot.projectsDirty,
        shas: snapshot.shas,
        previews,
        onProgress: (progress) => {
          if (destinationChangedDuringOperation()) return;
          const current = syncMetaRef.current;
          const next: SyncMetadata = {
            ...current,
            shas: { ...current.shas, ...progress.shas },
            remoteRevision: progress.remoteRevision,
          };
          syncMetaRef.current = next;
          setSyncMeta(next);
        },
      });
      if (ignoreStaleOperation()) return;
      const currentSync = syncMetaRef.current;
      const syncedIds = new Set(result.syncedNoteIds);
      const dirtyNoteIds = currentSync.dirtyNoteIds.filter((id) => {
        if (!syncedIds.has(id)) return true;
        const currentNote = notesRef.current.find((note) => note.id === id);
        return currentNote?.updatedAt !== sentTimes.get(id);
      });
      const projectsChangedDuringSync = projectChangeVersionRef.current !== sentProjectVersion;
      const projectSignatures = result.projectsSynced
        ? Object.fromEntries(sentProjects.map((project) => [project.id, projectContentSignature(project)]))
        : currentSync.projectSignatures;
      const nextSync: SyncMetadata = {
        ...currentSync,
        shas: { ...currentSync.shas, ...result.shas },
        projectSignatures,
        dirtyNoteIds,
        dirtyProjectIds: result.projectsSynced && !projectsChangedDuringSync ? [] : currentSync.dirtyProjectIds,
        projectsDirty: result.projectsSynced && !projectsChangedDuringSync ? false : currentSync.projectsDirty,
        lastSyncAt: result.lastSyncAt,
        remoteRevision: result.remoteRevision,
        destination: operationDestination,
      };
      syncMetaRef.current = nextSync;
      setSyncMeta(nextSync);
      const stillDirty = syncMetaRef.current.dirtyNoteIds.length || syncMetaRef.current.projectsDirty;
      setSyncState(stillDirty ? "pending" : "done");
      setSyncMessage(stillDirty ? "وصلت تغييرات جديدة أثناء الرفع؛ ستُزامن بعد قليل" : "تمت المزامنة الآمنة مع GitHub");
      if (manual) setToast("تم حفظ مساحة العمل في المستودع الخاص");
    } catch (error) {
      if (ignoreStaleOperation()) return;
      if (error instanceof SyncConflictError) {
        setSyncState("conflict");
        setSyncMessage("توجد نسخة أحدث في GitHub؛ استخدم «جلب ودمج» ولن نفقد نسختك");
      } else {
        setSyncState("error");
        setSyncMessage(error instanceof Error ? error.message : "تعذّرت المزامنة");
      }
    } finally {
      syncLockRef.current = false;
      setSyncInFlight(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !githubToken || syncState === "conflict") return;
    if (!syncMeta.dirtyNoteIds.length && !syncMeta.projectsDirty) return;
    const timer = window.setTimeout(() => { void pushToGithub(false); }, 3400);
    return () => window.clearTimeout(timer);
  }, [dirtyVersion, githubToken, hydrated, pushToGithub, syncMeta.dirtyNoteIds.length, syncMeta.projectsDirty, syncState]);

  const pullFromGithub = useCallback(async () => {
    if (syncLockRef.current) return;
    const config = configRef.current;
    const token = tokenRef.current;
    if (!token || !config.owner || !config.repo || !config.branch || !config.basePath) {
      setSyncState("error");
      setSyncMessage("أكمل بيانات المستودع والرمز أولاً");
      return;
    }

    const operationDestination = githubDestination(config);
    const operationEpoch = destinationEpochRef.current;
    const destinationChangedDuringOperation = () => (
      destinationEpochRef.current !== operationEpoch
      || githubDestination(configRef.current) !== operationDestination
    );
    const ignoreStaleOperation = () => {
      if (!destinationChangedDuringOperation()) return false;
      setSyncState((current) => current === "syncing" ? "pending" : current);
      setSyncMessage((current) => current.startsWith("جارٍ")
        ? "تغيّرت وجهة GitHub؛ تجاهلنا نتيجة العملية السابقة وحافظنا على التغييرات المحلية"
        : current);
      return true;
    };

    syncLockRef.current = true;
    setSyncInFlight(true);
    setSyncState("syncing");
    setSyncMessage("جارٍ جلب النسخة الأحدث ودمجها…");
    try {
      const localSnapshot = workspaceSnapshot(notesRef.current, projectsRef.current, selectedIdRef.current, syncMetaRef.current);
      await saveWorkspaceBackup(localSnapshot);
      const remote = await pullRemoteWorkspace(config, token);
      if (ignoreStaleOperation()) return;
      const localById = new Map(notesRef.current.map((note) => [note.id, note]));
      const localDirty = new Set(syncMetaRef.current.dirtyNoteIds);
      const localProjectsById = new Map(projectsRef.current.map((project) => [project.id, project]));
      const localDirtyProjects = new Set(syncMetaRef.current.dirtyProjectIds);
      const preservedLegacyNoteSignatures = new Set(remote.preservedLegacyNoteSignatures);
      const preservedLegacyProjectSignatures = new Set(remote.preservedLegacyProjectSignatures);
      const nextDirty = new Set(syncMetaRef.current.dirtyNoteIds);
      const nextDirtyProjects = new Set(syncMetaRef.current.dirtyProjectIds);
      // Rebuild the SHA baseline from what actually exists remotely. Keeping a
      // stale SHA for a deleted file would prevent a preserved local copy from
      // being created again safely.
      const nextShas = { ...(remote.auxiliaryShas ?? {}) };
      const nextProjectSignatures = { ...syncMetaRef.current.projectSignatures };
      const remoteBasePath = config.basePath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      let mergedNotes: Note[] = [];
      const localMergedNoteIds = new Set<string>();
      const localResultByOriginalId = new Map<string, string>();
      const remoteIds = new Set<string>();
      let conflictCopies = 0;

      for (const record of remote.notes) {
        remoteIds.add(record.note.id);
        nextShas[record.path] = record.sha;
        const previewPath = [remoteBasePath, "previews", `${record.note.id}.webp`].filter(Boolean).join("/");
        if (!nextShas[previewPath]) nextDirty.add(record.note.id);
        const local = localById.get(record.note.id);
        if (local && localDirty.has(local.id) && noteContentSignature(local) !== noteContentSignature(record.note)) {
          if (remote.legacy && preservedLegacyNoteSignatures.has(`${local.id}\u0000${noteContentSignature(local)}`)) {
            mergedNotes.push(record.note);
            nextDirty.delete(local.id);
            continue;
          }
          const baselineSha = syncMetaRef.current.shas[record.path];
          if (baselineSha && baselineSha === record.sha) {
            // Only the local side changed, so preserve its stable ID and keep it dirty.
            mergedNotes.push(local);
            localMergedNoteIds.add(local.id);
            localResultByOriginalId.set(local.id, local.id);
          } else {
            mergedNotes.push(record.note);
            const copy: Note = {
              ...local,
              id: makeId("note-conflict"),
              title: `${local.title} — نسخة محلية محفوظة`,
              updatedAt: nowIso(),
              organization: { ...local.organization, state: "draft" },
            };
            mergedNotes.push(copy);
            localMergedNoteIds.add(copy.id);
            localResultByOriginalId.set(local.id, copy.id);
            nextDirty.delete(local.id);
            nextDirty.add(copy.id);
            conflictCopies += 1;
          }
        } else {
          mergedNotes.push(record.note);
          nextDirty.delete(record.note.id);
        }
      }

      for (const local of notesRef.current) {
        if (remoteIds.has(local.id)) continue;
        const starter = starterPlaceholderRef.current;
        if (remote.notes.length
          && starter?.noteId === local.id
          && starter.untouched
          && isUntouchedStarter(local)) {
          nextDirty.delete(local.id);
          continue;
        }
        mergedNotes.push(local);
        localMergedNoteIds.add(local.id);
        localResultByOriginalId.set(local.id, local.id);
        nextDirty.add(local.id);
      }

      if (remote.legacy) {
        for (const note of mergedNotes) nextDirty.add(note.id);
      }

      let mergedProjects = projectsRef.current;
      let projectConflictCopies = 0;
      const projectConflictIds = new Map<string, string>();
      if (remote.projects) {
        const projectsBaselineSha = syncMetaRef.current.shas[remote.projects.path];
        const remoteProjectsFileIsBaseline = Boolean(projectsBaselineSha && projectsBaselineSha === remote.projects.sha);
        nextShas[remote.projects.path] = remote.projects.sha;
        const remoteProjectIds = new Set<string>();
        mergedProjects = [];
        for (const remoteProject of remote.projects.projects) {
          remoteProjectIds.add(remoteProject.id);
          const localProject = localProjectsById.get(remoteProject.id);
          const remoteSignature = projectContentSignature(remoteProject);
          const baselineSignature = syncMetaRef.current.projectSignatures[remoteProject.id];
          nextProjectSignatures[remoteProject.id] = remoteSignature;
          if (localProject && localDirtyProjects.has(localProject.id) && projectContentSignature(localProject) !== remoteSignature) {
            if (remote.legacy && preservedLegacyProjectSignatures.has(`${localProject.id}\u0000${projectContentSignature(localProject)}`)) {
              mergedProjects.push(remoteProject);
              nextDirtyProjects.delete(localProject.id);
            } else if (remoteProjectsFileIsBaseline || Boolean(baselineSignature && baselineSignature === remoteSignature)) {
              mergedProjects.push(localProject);
            } else {
              mergedProjects.push(remoteProject);
              const copy = {
                ...localProject,
                id: makeId("project-conflict"),
                name: `${localProject.name} — نسخة محلية محفوظة`,
                updatedAt: nowIso(),
              };
              mergedProjects.push(copy);
              projectConflictIds.set(localProject.id, copy.id);
              nextDirtyProjects.delete(localProject.id);
              nextDirtyProjects.add(copy.id);
              projectConflictCopies += 1;
            }
          } else {
            mergedProjects.push(remoteProject);
            nextDirtyProjects.delete(remoteProject.id);
          }
        }
        for (const localProject of projectsRef.current) {
          if (!remoteProjectIds.has(localProject.id)) {
            mergedProjects.push(localProject);
            nextDirtyProjects.add(localProject.id);
            delete nextProjectSignatures[localProject.id];
          }
        }
      } else if (projectsRef.current.length) {
        for (const localProject of projectsRef.current) {
          nextDirtyProjects.add(localProject.id);
          delete nextProjectSignatures[localProject.id];
        }
      }
      if (projectConflictIds.size) {
        mergedNotes = mergedNotes.map((note) => {
          if (!localMergedNoteIds.has(note.id) || !note.projectId) return note;
          const conflictProjectId = projectConflictIds.get(note.projectId);
          if (!conflictProjectId) return note;
          nextDirty.add(note.id);
          return {
            ...note,
            projectId: conflictProjectId,
            status: note.status === "raw" ? "linked" : note.status,
            updatedAt: nowIso(),
          };
        });
        for (const localNote of notesRef.current) {
          if (!localNote.projectId || localResultByOriginalId.has(localNote.id)) continue;
          const conflictProjectId = projectConflictIds.get(localNote.projectId);
          if (!conflictProjectId) continue;
          const copy: Note = {
            ...localNote,
            id: makeId("note-project-conflict"),
            title: `${localNote.title} — ارتباط محلي محفوظ`,
            projectId: conflictProjectId,
            status: localNote.status === "raw" ? "linked" : localNote.status,
            updatedAt: nowIso(),
          };
          mergedNotes.push(copy);
          localMergedNoteIds.add(copy.id);
          localResultByOriginalId.set(localNote.id, copy.id);
          nextDirty.add(copy.id);
        }
      }
      if (remote.legacy) {
        for (const project of mergedProjects) nextDirtyProjects.add(project.id);
      }
      const projectsDirty = nextDirtyProjects.size > 0;

      const nextSelectedId = mergedNotes.some((note) => note.id === selectedIdRef.current)
        ? selectedIdRef.current
        : mergedNotes[0]?.id ?? "";
      const nextSync: SyncMetadata = {
        ...syncMetaRef.current,
        shas: nextShas,
        projectSignatures: nextProjectSignatures,
        dirtyNoteIds: [...nextDirty],
        dirtyProjectIds: [...nextDirtyProjects],
        projectsDirty,
        lastSyncAt: nowIso(),
        remoteRevision: remote.revision,
        destination: githubDestination(config),
      };
      const mergedIds = new Set(mergedNotes.map((note) => note.id));
      for (const note of mergedNotes) {
        const previous = localById.get(note.id);
        if (!previous || noteContentSignature(previous) !== noteContentSignature(note)) {
          delete undoByNoteRef.current[note.id];
          delete redoByNoteRef.current[note.id];
        }
      }
      for (const noteId of Object.keys(undoByNoteRef.current)) {
        if (!mergedIds.has(noteId)) delete undoByNoteRef.current[noteId];
      }
      for (const noteId of Object.keys(redoByNoteRef.current)) {
        if (!mergedIds.has(noteId)) delete redoByNoteRef.current[noteId];
      }
      notesRef.current = mergedNotes;
      projectsRef.current = mergedProjects;
      selectedIdRef.current = nextSelectedId;
      syncMetaRef.current = nextSync;
      setNotes(mergedNotes);
      setProjects(mergedProjects);
      setSelectedId(nextSelectedId);
      setSyncMeta(nextSync);
      setDirtyVersion((value) => value + 1);
      setSyncState(nextDirty.size || projectsDirty ? "pending" : "done");
      const totalConflictCopies = conflictCopies + projectConflictCopies;
      setSyncMessage(totalConflictCopies
        ? `تم الدمج وحفظ ${totalConflictCopies} نسخة محلية منفصلة كي لا يضيع شيء`
        : "تم جلب ودمج أحدث نسخة من GitHub");
      setToast(totalConflictCopies ? "وجدنا تعارضًا وحفظنا النسختين" : "أصبحت المساحة محدثة");
      const starter = starterPlaceholderRef.current;
      if (starter && (!mergedNotes.some((note) => note.id === starter.noteId) || remoteIds.has(starter.noteId))) {
        setStarterPlaceholder(null);
      }
    } catch (error) {
      if (ignoreStaleOperation()) return;
      setSyncState("error");
      setSyncMessage(error instanceof Error ? error.message : "تعذّر جلب البيانات");
    } finally {
      syncLockRef.current = false;
      setSyncInFlight(false);
    }
  }, [setStarterPlaceholder]);

  useEffect(() => {
    if (!hydrated || !githubToken || loadError) return;
    let cancelled = false;
    let checking = false;
    const checkForRemoteChanges = async () => {
      if (checking || syncLockRef.current || document.visibilityState === "hidden") return;
      checking = true;
      const config = configRef.current;
      const token = tokenRef.current;
      const destination = githubDestination(config);
      const destinationEpoch = destinationEpochRef.current;
      try {
        const revision = await getRemoteRevision(config, token);
        const destinationIsCurrent = destinationEpochRef.current === destinationEpoch
          && githubDestination(configRef.current) === destination;
        if (!cancelled && destinationIsCurrent && revision !== syncMetaRef.current.remoteRevision) {
          await pullFromGithub();
        }
      } catch (error) {
        const destinationIsCurrent = destinationEpochRef.current === destinationEpoch
          && githubDestination(configRef.current) === destination;
        if (!cancelled && destinationIsCurrent) {
          setSyncState("error");
          setSyncMessage(error instanceof Error ? error.message : "تعذّر فحص تغييرات GitHub");
        }
      } finally {
        checking = false;
      }
    };
    const initialTimer = window.setTimeout(() => { void checkForRemoteChanges(); }, 1400);
    const interval = window.setInterval(() => { void checkForRemoteChanges(); }, 60000);
    const onVisibility = () => { if (document.visibilityState === "visible") void checkForRemoteChanges(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [githubConfig, githubToken, hydrated, loadError, pullFromGithub]);

  const counts = useMemo(() => {
    const openTasks = notes.reduce((total, note) => total + note.tasks.filter((task) => !task.done).length, 0);
    const doneTasks = notes.reduce((total, note) => total + note.tasks.filter((task) => task.done).length, 0);
    return {
      all: notes.length + projects.length + openTasks,
      raw: notes.filter((note) => note.status === "raw").length,
      tasks: openTasks,
      projects: projects.length,
      queued: notes.filter((note) => note.organization.state === "queued").length,
      deferred: notes.filter((note) => note.deferred || note.tasks.some((task) => task.deferred)).length,
      done: doneTasks,
    };
  }, [notes, projects]);

  const visibleNotes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ar");
    return notes.filter((note) => {
      const project = projects.find((item) => item.id === note.projectId);
      const searchable = `${note.title} ${note.summary} ${project?.name ?? ""} ${note.tasks.map((task) => task.title).join(" ")}`.toLocaleLowerCase("ar");
      const matchesSearch = !query || searchable.includes(query);
      const matchesFilter = filter === "all"
        || filter === "raw" && note.status === "raw"
        || filter === "tasks" && note.tasks.some((task) => !task.done)
        || filter === "projects" && (focusedProjectId ? note.projectId === focusedProjectId : Boolean(note.projectId))
        || filter === "queued" && note.organization.state === "queued"
        || filter === "deferred" && Boolean(note.deferred || note.tasks.some((task) => task.deferred))
        || filter === "done" && note.tasks.some((task) => task.done);
      return matchesSearch && matchesFilter;
    }).sort((first, second) => new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime());
  }, [filter, focusedProjectId, notes, projects, search]);

  const visibleProjects = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ar");
    if (!query) return projects;
    return projects.filter((project) => `${project.name} ${project.nextAction}`.toLocaleLowerCase("ar").includes(query));
  }, [projects, search]);

  const displayedNotes = showAllNotes ? visibleNotes : visibleNotes.slice(0, layout === "grid" ? 3 : 5);

  const createNote = () => {
    const note = emptyNote();
    notesRef.current = [note, ...notesRef.current];
    setNotes(notesRef.current);
    setSelectedId(note.id);
    selectedIdRef.current = note.id;
    markNoteDirty(note.id);
    setView("capture");
    setToast("تم إنشاء ملاحظة وحفظها على الجهاز");
  };

  const recordStrokeSnapshot = (note: Note) => {
    const history = undoByNoteRef.current[note.id] ?? [];
    history.push({ strokes: note.strokes, drawing: note.drawing });
    if (history.length > 30) history.shift();
    undoByNoteRef.current[note.id] = history;
    redoByNoteRef.current[note.id] = [];
  };

  const markStrokeStarted = (noteId: string) => {
    const starter = starterPlaceholderRef.current;
    if (starter?.noteId === noteId && starter.untouched) {
      setStarterPlaceholder({ ...starter, untouched: false });
    }
  };

  const addStroke = (noteId: string, stroke: Stroke) => {
    const note = notesRef.current.find((item) => item.id === noteId);
    if (!note) return;
    recordStrokeSnapshot(note);
    updateNote(noteId, (current) => ({ ...current, strokes: [...current.strokes, stroke] }));
  };

  const restoreStrokeSnapshot = (direction: "undo" | "redo") => {
    if (!selectedNote) return;
    const source = direction === "undo" ? undoByNoteRef.current : redoByNoteRef.current;
    const destination = direction === "undo" ? redoByNoteRef.current : undoByNoteRef.current;
    const stack = source[selectedNote.id] ?? [];
    const snapshot = stack.pop();
    if (!snapshot) return;
    const destinationStack = destination[selectedNote.id] ?? [];
    destinationStack.push({ strokes: selectedNote.strokes, drawing: selectedNote.drawing });
    source[selectedNote.id] = stack;
    destination[selectedNote.id] = destinationStack;
    updateNote(selectedNote.id, (note) => ({ ...note, strokes: snapshot.strokes, drawing: snapshot.drawing }));
  };

  const clearCanvas = () => {
    if (!selectedNote || (!selectedNote.strokes.length && !selectedNote.drawing)) return;
    if (!window.confirm("مسح الكتابة من هذه الملاحظة؟ يمكن التراجع عن الخطوط الجديدة.")) return;
    recordStrokeSnapshot(selectedNote);
    updateNote(selectedNote.id, (note) => ({ ...note, strokes: [], drawing: undefined }));
  };

  const queueForOrganization = () => {
    if (!selectedNote) return;
    updateNote(selectedNote.id, (note) => ({
      ...note,
      organization: {
        state: "queued",
        requestedAt: nowIso(),
        instruction: "استخرج المهام والمشاريع والمواعيد من هذه الملاحظة مع الحفاظ على الأصل الخام.",
      },
    }));
    setToast("وُضعت الملاحظة في انتظار تنظيم Codex");
    if (!tokenRef.current) {
      setSyncMessage("الطلب محفوظ محليًا؛ اربط المستودع الخاص كي يصل إلى Codex");
      setSettingsOpen(true);
    }
  };

  const toggleTask = (noteId: string, taskId: string) => {
    updateNote(noteId, (note) => ({
      ...note,
      tasks: note.tasks.map((task) => task.id === taskId ? { ...task, done: !task.done } : task),
    }));
  };

  const addTask = (event: FormEvent) => {
    event.preventDefault();
    const title = taskDraft.trim();
    if (!selectedNote || !title) return;
    updateNote(selectedNote.id, (note) => ({
      ...note,
      tasks: [...note.tasks, { id: makeId("task"), title, done: false }],
    }));
    setTaskDraft("");
  };

  const createProject = (event: FormEvent) => {
    event.preventDefault();
    const name = projectDraft.name.trim();
    if (!name) return;
    const project = {
      ...emptyProject(name, projectDraft.icon.trim() || "◉"),
      nextAction: projectDraft.nextAction.trim() || "تحديد الخطوة التالية",
    };
    projectsRef.current = [...projectsRef.current, project];
    setProjects(projectsRef.current);
    markProjectsDirty(project.id);
    setProjectDraft({ name: "", icon: "◉", nextAction: "" });
    setProjectModalOpen(false);
    setToast("تم إنشاء المشروع الحقيقي");
  };

  const selectProject = (projectId: string) => {
    const note = notes.find((item) => item.projectId === projectId);
    if (note) setSelectedId(note.id);
    setFocusedProjectId(projectId);
    setShowAllNotes(true);
    setFilter("projects");
  };

  const changeGithubConfig = (nextConfig: GitHubConfig) => {
    if (syncLockRef.current) {
      setToast("انتظر اكتمال المزامنة قبل تغيير الوجهة");
      return;
    }
    const destination = githubDestination(nextConfig);
    const currentDestination = githubDestination(configRef.current);
    const previousDestination = syncMetaRef.current.destination;
    if (currentDestination !== destination) destinationEpochRef.current += 1;
    configRef.current = nextConfig;
    setGithubConfig(nextConfig);
    if (previousDestination && previousDestination !== destination) {
      const nextSync: SyncMetadata = {
        ...EMPTY_SYNC,
        dirtyNoteIds: notesRef.current.map((note) => note.id),
        dirtyProjectIds: projectsRef.current.map((project) => project.id),
        projectsDirty: projectsRef.current.length > 0,
        destination,
      };
      syncMetaRef.current = nextSync;
      setSyncMeta(nextSync);
      setSyncState("conflict");
      setSyncMessage("تغيّرت وجهة البيانات؛ سيتم الجلب والدمج قبل أول رفع إليها");
      setDirtyVersion((value) => value + 1);
    } else if (!previousDestination) {
      replaceSyncMeta((current) => ({ ...current, destination }));
    }
  };

  const organizationLabel = selectedNote?.organization.state === "queued"
    ? "بانتظار Codex"
    : selectedNote?.organization.state === "organized"
      ? "منظمة"
      : "خام";

  const syncButtonLabel = syncState === "syncing"
    ? "GitHub …"
    : syncState === "done"
      ? "GitHub ✓"
      : syncState === "conflict" || syncState === "error"
        ? "GitHub !"
        : syncState === "pending"
          ? "GitHub ↑"
          : "GitHub";

  if (!hydrated) {
    return <main className="workspace-gate" dir="rtl"><div><span className="brand-mark" aria-hidden="true">◉</span><h1>مساحة Doraemon</h1><p>أفتح ملاحظاتك المحفوظة بأمان…</p></div></main>;
  }

  if (loadError) {
    return <main className="workspace-gate error" dir="rtl"><div><span className="gate-error-icon">!</span><h1>لم ألمس بياناتك المحفوظة</h1><p>{loadError}</p><small>أوقفنا الحفظ كي لا تستبدل مشكلة مؤقتة مساحتك القديمة.</small><button type="button" onClick={() => window.location.reload()}>إعادة المحاولة</button></div></main>;
  }

  return (
    <main className={`workspace-shell ${view === "capture" ? "capture-mode" : "browse-mode"}`} dir="rtl">
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
          <button className={`save-pill ${saveState === "error" ? "has-error" : ""}`} type="button" onClick={() => setSettingsOpen(true)}>
            <span className={saveState === "saved" ? "status-dot" : saveState === "saving" ? "status-dot saving" : "status-dot error"} />
            {saveState === "saved" ? "محفوظ على الجهاز" : saveState === "saving" ? "جارٍ الحفظ…" : "الحفظ يحتاج انتباهًا"}
          </button>
          <button className={`github-button ${syncState}`} type="button" onClick={() => setSettingsOpen(true)} aria-label="إعداد مزامنة GitHub">
            {syncButtonLabel}
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-spacer" />
        <div className="nav-list">
          {NAV_ITEMS.map((item) => (
            <button key={item.id} className={filter === item.id ? "nav-item active" : "nav-item"} type="button" onClick={() => { setFilter(item.id); setFocusedProjectId(null); setShowAllNotes(true); setView("browse"); }}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
              <span className="nav-count">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <div className="filter-block">
          <div className="filter-title"><span>▽</span> الحالة</div>
          <div><i className="swatch raw" />غير مرتبة <span>{counts.raw}</span></div>
          <div><i className="swatch queued" />بانتظار Codex <span>{counts.queued}</span></div>
          <div><i className="swatch organized" />تم تنظيمها <span>{notes.filter((note) => note.organization.state === "organized").length}</span></div>
        </div>
        <button className="new-note" type="button" onClick={createNote}><span>＋</span> ملاحظة جديدة</button>
      </aside>

      {view === "browse" ? (
        <section className="browse-view">
          <div className="browse-toolbar">
            <div className="search-box"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث في الملاحظات والمشاريع والمهام" aria-label="بحث" /></div>
            <div className="layout-switch" aria-label="تخطيط العرض">
              <button className={layout === "list" ? "active" : ""} onClick={() => setLayout("list")} type="button">☷ <span>قائمة</span></button>
              <button className={layout === "grid" ? "active" : ""} onClick={() => setLayout("grid")} type="button">▦ <span>شبكة</span></button>
            </div>
          </div>

          <div className="content-scroll">
            <div className="section-heading">
              <div><h2>{focusedProjectId ? projects.find((project) => project.id === focusedProjectId)?.name ?? "المشروع" : filter === "queued" ? "بانتظار التنظيم" : filter === "done" ? "الملاحظات المنجزة" : "ملاحظاتك"}</h2><small>{visibleNotes.length} ملاحظة</small></div>
              {visibleNotes.length > (layout === "grid" ? 3 : 5) && <button type="button" onClick={() => setShowAllNotes((value) => !value)}>{showAllNotes ? "عرض مختصر" : "عرض الكل"}</button>}
            </div>
            {displayedNotes.length ? (
              <div className={`note-grid ${layout === "list" ? "list" : ""}`}>
                {displayedNotes.map((note) => (
                  <article key={note.id} className={`note-card accent-${note.accent} ${selectedId === note.id ? "selected" : ""}`} onClick={() => setSelectedId(note.id)}>
                    <div className="card-top"><time>{formatTime(note.createdAt)}</time><span className={`organization-dot ${note.organization.state}`}>{note.organization.state === "queued" ? "✦ ينتظر" : note.organization.state === "organized" ? "✓ منظم" : "خام"}</span></div>
                    <div className="note-ink">
                      {note.strokes.length || note.drawing ? <DrawingPreview strokes={note.strokes} legacyDrawing={note.drawing} /> : <><h3>{note.title}</h3><p>{note.summary || "ملاحظة جاهزة للكتابة بالقلم"}</p></>}
                    </div>
                    <div className="card-bottom"><span className={`tag tag-${note.status}`}>{STATUS_LABELS[note.status]}</span><button type="button" onClick={(event) => { event.stopPropagation(); setSelectedId(note.id); setView("capture"); }}>فتح بالقلم</button></div>
                  </article>
                ))}
              </div>
            ) : <div className="empty-state"><span>⌕</span><h3>لا توجد نتائج</h3><p>غيّر الفلتر أو أنشئ ملاحظة جديدة.</p><button type="button" onClick={createNote}>ملاحظة جديدة</button></div>}

            <div className="section-heading projects-heading"><div><h2>المشاريع</h2><small>{visibleProjects.length} مشروع</small></div><button type="button" onClick={() => setProjectModalOpen(true)}>＋ مشروع جديد</button></div>
            {visibleProjects.length ? <div className="project-grid">
              {visibleProjects.map((project) => {
                const projectNotes = notes.filter((note) => note.projectId === project.id);
                const taskCount = projectNotes.reduce((total, note) => total + note.tasks.length, 0);
                const progress = projectProgress(project.id, notes);
                return (
                  <button key={project.id} className={`project-card accent-${project.accent} ${focusedProjectId === project.id ? "selected" : ""}`} type="button" onClick={() => selectProject(project.id)}>
                    <div className="project-hero"><span>{project.icon}</span><h3>{project.name}</h3><p>{taskCount} مهام · {projectNotes.length} ملاحظات</p></div>
                    <div className="project-details"><small>الإجراء التالي</small><p>{project.nextAction}</p><div className="progress-row"><b>{progress}%</b><div><i style={{ width: `${progress}%` }} /></div></div></div>
                  </button>
                );
              })}
            </div> : <div className="empty-projects"><p>أنشئ مشروعًا ثم اربط الملاحظات به.</p><button type="button" onClick={() => setProjectModalOpen(true)}>إنشاء أول مشروع</button></div>}
          </div>

          <aside className="detail-panel">
            {selectedNote && (!focusedProjectId || selectedNote.projectId === focusedProjectId) ? <>
              <div className="detail-time"><time>{formatTime(selectedNote.createdAt)}</time><span className={`organization-badge ${selectedNote.organization.state}`}>{organizationLabel}</span></div>
              <div className="detail-note">
                {selectedNote.strokes.length || selectedNote.drawing ? <DrawingPreview strokes={selectedNote.strokes} legacyDrawing={selectedNote.drawing} /> : <><h2>{selectedNote.title}</h2><p>{selectedNote.summary || "لا يوجد نص مكتوب بعد."}</p></>}
              </div>
              <div className="detail-actions-row">
                <span className={`tag tag-${selectedNote.status}`}>{STATUS_LABELS[selectedNote.status]}</span>
                <button type="button" onClick={() => updateNote(selectedNote.id, (note) => ({ ...note, deferred: !note.deferred }))}>{selectedNote.deferred ? "مؤجلة ◷" : "تأجيل"}</button>
              </div>
              <div className="converted-title"><span>✦</span> النتائج المنظمة</div>
              <div className="detail-box tasks-box">
                <div><h3>مهام</h3><span>{selectedNote.tasks.length}</span></div>
                {selectedNote.tasks.length ? selectedNote.tasks.map((task) => (
                  <label key={task.id} className={task.done ? "done" : ""}><input type="checkbox" checked={task.done} onChange={() => toggleTask(selectedNote.id, task.id)} /><span>{task.title}</span><time>{task.due}</time></label>
                )) : <p className="muted">ستظهر هنا المهام التي أنظمها، ويمكنك إضافة مهمة الآن.</p>}
                <form className="quick-task-form" onSubmit={addTask}><input value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} placeholder="مهمة جديدة…" aria-label="مهمة جديدة" /><button type="submit">＋</button></form>
              </div>
              <div className="detail-box linked-box"><h3>مشروع مرتبط</h3><select value={selectedNote.projectId ?? ""} onChange={(event) => updateNote(selectedNote.id, (note) => ({ ...note, projectId: event.target.value || undefined, status: event.target.value ? "linked" : note.organization.state === "organized" ? "organized" : "raw" }))}><option value="">غير مرتبط بعد</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.icon} {project.name}</option>)}</select></div>
              <button className="open-capture" type="button" onClick={() => setView("capture")}>فتح الملاحظة بالقلم</button>
            </> : <div className="project-detail-empty"><span>▱</span><h3>لا توجد ملاحظات في هذا المشروع</h3><p>افتح ملاحظة واربطها بالمشروع من هذه اللوحة.</p></div>}
          </aside>
        </section>
      ) : (
        <section className="capture-view">
          <aside className="notes-rail">
            <h2>ملاحظاتك <span>▤</span></h2>
            <div className="rail-scroll">
              {notes.map((note) => (
                <button key={note.id} className={selectedId === note.id ? "rail-note active" : "rail-note"} type="button" onClick={() => setSelectedId(note.id)}>
                  <div><time>{formatTime(note.createdAt)}</time><span>{note.organization.state === "queued" ? "✦" : ""}</span></div>
                  {note.strokes.length || note.drawing ? <DrawingPreview strokes={note.strokes} legacyDrawing={note.drawing} /> : <><strong>{note.title}</strong><p>{note.summary || "ابدأ الكتابة"}</p></>}
                  <small>{note.organization.state === "queued" ? "بانتظار Codex" : STATUS_LABELS[note.status]}</small>
                </button>
              ))}
            </div>
            <button className="new-note" type="button" onClick={createNote}><span>＋</span> ملاحظة جديدة</button>
          </aside>

          <div className="capture-main">
            <div className="capture-hint"><span>✦</span> اكتب بحرية؛ تُحفظ الضربة على الجهاز ثم تُزامن بعد توقفك</div>
            <label className="mobile-note-picker"><span>الملاحظة</span><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{notes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}</select></label>
            <div className="paper-wrap">
              <input className="note-title-input" value={selectedNote?.title ?? ""} onChange={(event) => selectedNote && updateNote(selectedNote.id, (note) => ({ ...note, title: event.target.value }))} aria-label="عنوان الملاحظة" />
              {selectedNote && <HandwritingCanvas noteId={selectedNote.id} strokes={selectedNote.strokes} legacyDrawing={selectedNote.drawing} tool={tool} ink={ink} penOnly={penOnly} onStrokeStart={markStrokeStarted} onAddStroke={addStroke} />}
              {selectedNote && !selectedNote.strokes.length && !selectedNote.drawing && <div className="canvas-placeholder"><span>✎</span><p>ابدأ الكتابة أو الرسم بالقلم هنا</p><small>كل ضربة تُحفظ فورًا في مساحة آمنة على هذا الجهاز</small></div>}
              <div className="drawing-tools" aria-label="أدوات الرسم">
                <button className={tool === "pen" ? "active" : ""} onClick={() => setTool("pen")} type="button" title="قلم" aria-label="قلم">✎</button>
                <button className={tool === "marker" ? "active" : ""} onClick={() => setTool("marker")} type="button" title="قلم تمييز" aria-label="قلم تمييز">▰</button>
                <button className={tool === "eraser" ? "active" : ""} onClick={() => setTool("eraser")} type="button" title="ممحاة" aria-label="ممحاة">▱</button>
                <label className="color-picker" title="لون القلم"><input type="color" value={ink} onChange={(event) => setInk(event.target.value)} /><span style={{ backgroundColor: ink }} /></label>
                <i />
                <button type="button" onClick={() => restoreStrokeSnapshot("undo")} title="تراجع" aria-label="تراجع">↶</button>
                <button type="button" onClick={() => restoreStrokeSnapshot("redo")} title="إعادة" aria-label="إعادة">↷</button>
                <button type="button" onClick={clearCanvas} title="مسح" aria-label="مسح الكتابة">•••</button>
              </div>
              <label className="pen-only-toggle"><input type="checkbox" checked={penOnly} onChange={(event) => setPenOnly(event.target.checked)} /><span>قلم فقط</span></label>
              <button className={`organize-button ${selectedNote?.organization.state === "queued" ? "queued" : ""}`} type="button" onClick={queueForOrganization} disabled={selectedNote?.organization.state === "queued"}><span>✦</span> {selectedNote?.organization.state === "queued" ? "بانتظار التنظيم" : "أرسلها للتنظيم"}</button>
            </div>
          </div>
        </section>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="github-title">
            <div className="modal-header"><div><span className="github-logo">GH</span><div><h2 id="github-title">المستودع الخاص للبيانات</h2><p>الواجهة عامة، أما ملاحظاتك فتذهب إلى هذا المستودع فقط.</p></div></div><button type="button" onClick={() => setSettingsOpen(false)} aria-label="إغلاق">×</button></div>
            <div className="security-note"><b>مهم:</b> استخدم رمزًا جديدًا محدودًا بالمستودع <code>doraemon-workspace-data</code> وبصلاحية <code>Contents: read/write</code>. لا تستخدم الرمز الذي ظهر سابقًا في المحادثة.</div>
            <div className="field-grid">
              <label><span>اسم المستخدم</span><input value={githubConfig.owner} onChange={(event) => changeGithubConfig({ ...githubConfig, owner: event.target.value.trim() })} placeholder="annta140-bit" dir="ltr" disabled={syncInFlight} /></label>
              <label><span>مستودع البيانات الخاص</span><input value={githubConfig.repo} onChange={(event) => changeGithubConfig({ ...githubConfig, repo: event.target.value.trim() })} placeholder="doraemon-workspace-data" dir="ltr" disabled={syncInFlight} /></label>
              <label><span>الفرع</span><input value={githubConfig.branch} onChange={(event) => changeGithubConfig({ ...githubConfig, branch: event.target.value.trim() })} placeholder="main" dir="ltr" disabled={syncInFlight} /></label>
              <label><span>مجلد البيانات</span><input value={githubConfig.basePath} onChange={(event) => changeGithubConfig({ ...githubConfig, basePath: event.target.value.trim() })} placeholder="data" dir="ltr" disabled={syncInFlight} /></label>
              <label className="token-field"><span>رمز الوصول المحدود</span><input value={githubToken} onChange={(event) => setGithubToken(event.target.value.trim())} placeholder="github_pat_…" type="password" dir="ltr" autoComplete="off" disabled={syncInFlight} /></label>
            </div>
            <div className={`sync-message ${syncState}`}>{syncState === "syncing" && <i />} {syncMessage}</div>
            <div className="sync-explanation"><span>✓ حفظ محلي فوري</span><span>✓ رفع تلقائي بعد 3 ثوانٍ</span><span>✓ تعارضات بلا فقدان</span></div>
            <div className="modal-actions"><button className="secondary" type="button" onClick={() => void pullFromGithub()} disabled={syncInFlight}>جلب ودمج بأمان</button><button className="primary" type="button" onClick={() => void pushToGithub(true)} disabled={syncInFlight}>مزامنة الآن</button></div>
            <p className="modal-footnote">تُحفظ كل ملاحظة في ملف مستقل، لذلك لا يستطيع جهاز قديم استبدال مساحة العمل كاملة.</p>
          </section>
        </div>
      )}

      {projectModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectModalOpen(false); }}>
          <section className="settings-modal project-modal" role="dialog" aria-modal="true" aria-labelledby="project-title">
            <div className="modal-header"><div><span className="project-modal-icon">▱</span><div><h2 id="project-title">مشروع جديد</h2><p>أنشئ مشروعًا حقيقيًا واربط الملاحظات به.</p></div></div><button type="button" onClick={() => setProjectModalOpen(false)} aria-label="إغلاق">×</button></div>
            <form className="project-form" onSubmit={createProject}>
              <label><span>اسم المشروع</span><input autoFocus value={projectDraft.name} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="مثال: إطلاق المنتج" /></label>
              <div><label className="icon-field"><span>الرمز</span><input value={projectDraft.icon} onChange={(event) => setProjectDraft({ ...projectDraft, icon: event.target.value })} /></label><label><span>الإجراء التالي</span><input value={projectDraft.nextAction} onChange={(event) => setProjectDraft({ ...projectDraft, nextAction: event.target.value })} placeholder="ما الخطوة القادمة؟" /></label></div>
              <button className="primary" type="submit">إنشاء المشروع</button>
            </form>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}
