export type WorkspaceView = "browse" | "capture";
export type NoteStatus = "raw" | "linked" | "organized";
export type OrganizationState = "draft" | "queued" | "organized";
export type SidebarFilter = "all" | "raw" | "tasks" | "projects" | "queued" | "deferred" | "done";
export type CanvasTool = "pen" | "marker" | "eraser";
export type Accent = "blue" | "mint" | "lilac" | "sand";

export const LOGICAL_PAGE_WIDTH = 1200;
export const LOGICAL_PAGE_HEIGHT = 800;

export type StrokePoint = {
  x: number;
  y: number;
  pressure?: number;
};

export type Stroke = {
  id: string;
  tool: CanvasTool;
  color: string;
  width: number;
  opacity: number;
  points: StrokePoint[];
};

export type Task = {
  id: string;
  title: string;
  due?: string;
  done: boolean;
  deferred?: boolean;
};

export type OrganizationRequest = {
  state: OrganizationState;
  requestedAt?: string;
  organizedAt?: string;
  instruction?: string;
};

export type Note = {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  status: NoteStatus;
  organization: OrganizationRequest;
  projectId?: string;
  tasks: Task[];
  strokes: Stroke[];
  drawing?: string;
  deferred?: boolean;
  accent: Accent;
};

export type Project = {
  id: string;
  name: string;
  icon: string;
  nextAction: string;
  accent: Accent;
  createdAt: string;
  updatedAt: string;
};

export type GitHubConfig = {
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
};

export type SyncMetadata = {
  shas: Record<string, string>;
  projectSignatures: Record<string, string>;
  dirtyNoteIds: string[];
  dirtyProjectIds: string[];
  projectsDirty: boolean;
  lastSyncAt?: string;
  remoteRevision?: string;
  destination?: string;
};

export type PersistedWorkspace = {
  schemaVersion: 2;
  notes: Note[];
  projects: Project[];
  selectedId?: string;
  sync: SyncMetadata;
};

export const DEFAULT_GITHUB_CONFIG: GitHubConfig = {
  owner: "annta140-bit",
  repo: "doraemon-workspace-data",
  branch: "main",
  basePath: "data",
};

const ACCENTS: Accent[] = ["blue", "mint", "lilac", "sand"];

export function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function emptyNote(title = "ملاحظة جديدة"): Note {
  const now = nowIso();
  return {
    id: makeId("note"),
    title,
    summary: "",
    createdAt: now,
    updatedAt: now,
    status: "raw",
    organization: { state: "draft" },
    tasks: [],
    strokes: [],
    accent: "blue",
  };
}

export function emptyProject(name: string, icon = "◉"): Project {
  const now = nowIso();
  return {
    id: makeId("project"),
    name,
    icon,
    nextAction: "تحديد الخطوة التالية",
    accent: ACCENTS[Math.floor(Math.random() * ACCENTS.length)],
    createdAt: now,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const title = asString(value.title).trim();
  if (!title) return null;
  const id = asString(value.id).trim();
  return {
    id: id || makeId("task"),
    title,
    due: typeof value.due === "string" ? value.due : undefined,
    done: Boolean(value.done),
    deferred: Boolean(value.deferred),
  };
}

function normalizeStrokePoint(value: unknown): StrokePoint | null {
  if (
    !isRecord(value)
    || typeof value.x !== "number"
    || !Number.isFinite(value.x)
    || typeof value.y !== "number"
    || !Number.isFinite(value.y)
  ) return null;
  if (value.pressure !== undefined && (typeof value.pressure !== "number" || !Number.isFinite(value.pressure))) return null;
  return {
    x: Math.max(0, Math.min(LOGICAL_PAGE_WIDTH, value.x)),
    y: Math.max(0, Math.min(LOGICAL_PAGE_HEIGHT, value.y)),
    pressure: typeof value.pressure === "number"
      ? Math.max(0, Math.min(1, value.pressure))
      : undefined,
  };
}

function normalizeStroke(value: unknown): Stroke | null {
  if (!isRecord(value) || !Array.isArray(value.points)) return null;
  const tool: CanvasTool = value.tool === "marker" || value.tool === "eraser" ? value.tool : "pen";
  const normalizedPoints = value.points.map(normalizeStrokePoint);
  if (!normalizedPoints.length || normalizedPoints.some((point) => point === null)) return null;
  const points = normalizedPoints as StrokePoint[];
  return {
    id: asString(value.id).trim() || makeId("stroke"),
    tool,
    color: asString(value.color, "#2f7df6"),
    width: typeof value.width === "number" ? Math.max(0.5, Math.min(80, value.width)) : 4,
    opacity: typeof value.opacity === "number" ? Math.max(0.05, Math.min(1, value.opacity)) : tool === "marker" ? 0.2 : 1,
    points,
  };
}

export function normalizeNote(value: unknown): Note | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;
  if (value.tasks !== undefined && !Array.isArray(value.tasks)) return null;
  if (value.strokes !== undefined && !Array.isArray(value.strokes)) return null;
  const normalizedTasks = (Array.isArray(value.tasks) ? value.tasks : []).map(normalizeTask);
  const normalizedStrokes = (Array.isArray(value.strokes) ? value.strokes : []).map(normalizeStroke);
  if (normalizedTasks.some((task) => task === null) || normalizedStrokes.some((stroke) => stroke === null)) return null;
  const rawStatus = asString(value.status);
  const status: NoteStatus = rawStatus === "linked" || rawStatus === "organized" ? rawStatus : "raw";
  const organizationValue = isRecord(value.organization) ? value.organization : null;
  const organizationStateValue = organizationValue ? asString(organizationValue.state) : "";
  const organizationState: OrganizationState = organizationStateValue === "queued" || organizationStateValue === "organized"
    ? organizationStateValue
    : status === "organized" ? "organized" : "draft";
  const accentValue = asString(value.accent);
  const accent: Accent = ACCENTS.includes(accentValue as Accent) ? accentValue as Accent : "blue";
  const now = nowIso();

  return {
    id,
    title: asString(value.title, "ملاحظة بلا عنوان"),
    summary: asString(value.summary),
    createdAt: asString(value.createdAt, now),
    updatedAt: asString(value.updatedAt, now),
    status,
    organization: {
      state: organizationState,
      requestedAt: organizationValue && typeof organizationValue.requestedAt === "string" ? organizationValue.requestedAt : undefined,
      organizedAt: organizationValue && typeof organizationValue.organizedAt === "string" ? organizationValue.organizedAt : undefined,
      instruction: organizationValue && typeof organizationValue.instruction === "string" ? organizationValue.instruction : undefined,
    },
    projectId: typeof value.projectId === "string" ? value.projectId : undefined,
    tasks: normalizedTasks as Task[],
    strokes: normalizedStrokes as Stroke[],
    drawing: typeof value.drawing === "string" && value.drawing.startsWith("data:image/") ? value.drawing : undefined,
    deferred: Boolean(value.deferred),
    accent,
  };
}

export function normalizeProject(value: unknown): Project | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  const name = asString(value.name).trim();
  if (!id || !name) return null;
  const accentValue = asString(value.accent);
  const now = nowIso();
  return {
    id,
    name,
    icon: asString(value.icon, "◉"),
    nextAction: asString(value.nextAction, "تحديد الخطوة التالية"),
    accent: ACCENTS.includes(accentValue as Accent) ? accentValue as Accent : "blue",
    createdAt: asString(value.createdAt, now),
    updatedAt: asString(value.updatedAt, now),
  };
}

export function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day = sameDay ? "اليوم" : date.toDateString() === yesterday.toDateString() ? "أمس" : new Intl.DateTimeFormat("ar-MA", { day: "numeric", month: "short" }).format(date);
  const time = new Intl.DateTimeFormat("ar-MA", { hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} ${time}`;
}

export function projectProgress(projectId: string, notes: Note[]) {
  const tasks = notes.filter((note) => note.projectId === projectId).flatMap((note) => note.tasks);
  if (!tasks.length) return 0;
  return Math.round(tasks.filter((task) => task.done).length / tasks.length * 100);
}

export function noteContentSignature(note: Note) {
  return JSON.stringify({
    title: note.title,
    summary: note.summary,
    status: note.status,
    organization: note.organization,
    projectId: note.projectId,
    tasks: note.tasks,
    strokes: note.strokes,
    drawing: note.drawing,
    deferred: note.deferred,
    accent: note.accent,
  });
}

export function projectContentSignature(project: Project) {
  return JSON.stringify({
    name: project.name,
    icon: project.icon,
    nextAction: project.nextAction,
    accent: project.accent,
  });
}

export function githubDestination(config: GitHubConfig) {
  const basePath = config.basePath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return `${config.owner.trim().toLocaleLowerCase()}/${config.repo.trim().toLocaleLowerCase()}@${config.branch.trim()}:${basePath}`;
}
