import {
  DEFAULT_GITHUB_CONFIG,
  githubDestination,
  normalizeNote,
  normalizeProject,
  type GitHubConfig,
  type PersistedWorkspace,
  type SyncMetadata,
} from "./workspace-model";

const DATABASE_NAME = "doraemon-workspace-v2";
const DATABASE_VERSION = 1;
const WORKSPACE_STORE = "workspace";
const BACKUP_STORE = "backups";
const CURRENT_WORKSPACE_ID = "current";
const MAX_BACKUPS = 10;

const LEGACY_NOTES_KEY = "doraemon.notes";
const LEGACY_PROJECTS_KEY = "doraemon.projects";
const LEGACY_CONFIG_KEY = "doraemon.github";
const LEGACY_SELECTED_ID_KEY = "doraemon.selectedId";

type WorkspaceRecord = {
  id: typeof CURRENT_WORKSPACE_ID;
  workspace: PersistedWorkspace;
  config: GitHubConfig;
  savedAt: string;
  // Records created before multi-tab CAS did not have this field and are
  // intentionally treated as revision 0 on their first load.
  revision?: number;
};

type BackupRecord = {
  id: string;
  workspace: PersistedWorkspace;
  savedAt: string;
};

let databasePromise: Promise<IDBDatabase> | undefined;
let knownRevision: number | undefined;
let saveQueue: Promise<void> = Promise.resolve();

class WorkspaceRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`تغيّرت مساحة العمل في تبويب آخر (النسخة المحلية ${expected}، والحالية ${actual}). أعد تحميل الصفحة قبل متابعة الكتابة كي لا تضيع التغييرات.`);
    this.name = "WorkspaceRevisionConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذّر الوصول إلى التخزين المحلي"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("أُلغيت عملية التخزين المحلي"));
    transaction.onerror = () => reject(transaction.error ?? new Error("فشلت عملية التخزين المحلي"));
  });
}

function workspaceRevision(record: WorkspaceRecord | undefined): number {
  if (!record || record.revision === undefined) return 0;
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new Error("رقم نسخة مساحة العمل المحلية غير صالح؛ لم نكتب فوق البيانات حفاظًا عليها");
  }
  return record.revision;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB غير متاح في هذا المتصفح"));
  }

  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WORKSPACE_STORE)) {
        database.createObjectStore(WORKSPACE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(BACKUP_STORE)) {
        const backups = database.createObjectStore(BACKUP_STORE, { keyPath: "id" });
        backups.createIndex("savedAt", "savedAt");
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error("تعذّر فتح التخزين المحلي"));
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error("تعذّر تحديث التخزين المحلي لأن نافذة أخرى تستخدم إصدارًا قديمًا"));
    };
  });

  return databasePromise;
}

function normalizeBasePath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function pathToBasePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!path) return "";
  const segments = path.split("/");
  const lastSegment = segments.at(-1) ?? "";
  if (/\.json$/i.test(lastSegment)) segments.pop();
  return segments.join("/");
}

function normalizeConfig(value: unknown): GitHubConfig {
  if (!isRecord(value)) return { ...DEFAULT_GITHUB_CONFIG };
  const legacyBasePath = pathToBasePath(value.path);
  const requestedRepo = typeof value.repo === "string" ? value.repo.trim() : "";
  return {
    owner: typeof value.owner === "string" && value.owner.trim() ? value.owner.trim() : DEFAULT_GITHUB_CONFIG.owner,
    repo: requestedRepo && requestedRepo !== "doraemon-workspace" ? requestedRepo : DEFAULT_GITHUB_CONFIG.repo,
    branch: typeof value.branch === "string" && value.branch.trim() ? value.branch.trim() : DEFAULT_GITHUB_CONFIG.branch,
    basePath: normalizeBasePath(value.basePath ?? legacyBasePath, DEFAULT_GITHUB_CONFIG.basePath),
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1])),
  );
}

function normalizeSync(value: unknown, noteIds: string[], projectIds: string[]): SyncMetadata {
  const sync = isRecord(value) ? value : {};
  const dirtyNoteIds = Array.isArray(sync.dirtyNoteIds)
    ? [...new Set(sync.dirtyNoteIds.filter((id): id is string => typeof id === "string" && noteIds.includes(id)))]
    : [];
  const dirtyProjectIds = Array.isArray(sync.dirtyProjectIds)
    ? [...new Set(sync.dirtyProjectIds.filter((id): id is string => typeof id === "string" && projectIds.includes(id)))]
    : Boolean(sync.projectsDirty) ? projectIds : [];
  return {
    shas: normalizeStringRecord(sync.shas),
    projectSignatures: normalizeStringRecord(sync.projectSignatures),
    dirtyNoteIds,
    dirtyProjectIds,
    projectsDirty: Boolean(sync.projectsDirty),
    lastSyncAt: typeof sync.lastSyncAt === "string" ? sync.lastSyncAt : undefined,
    remoteRevision: typeof sync.remoteRevision === "string" ? sync.remoteRevision : undefined,
    destination: typeof sync.destination === "string" ? sync.destination : undefined,
  };
}

function normalizeWorkspace(value: unknown): PersistedWorkspace | null {
  if (!isRecord(value) || !Array.isArray(value.notes) || !Array.isArray(value.projects)) return null;
  const notes = value.notes.map(normalizeNote).filter((note) => note !== null);
  const projects = value.projects.map(normalizeProject).filter((project) => project !== null);
  if (notes.length !== value.notes.length || projects.length !== value.projects.length) return null;
  const selectedId = typeof value.selectedId === "string" && notes.some((note) => note.id === value.selectedId)
    ? value.selectedId
    : notes[0]?.id;

  return {
    schemaVersion: 2,
    notes,
    projects,
    selectedId,
    sync: normalizeSync(value.sync, notes.map((note) => note.id), projects.map((project) => project.id)),
  };
}

function safeLegacyJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function readCurrentWorkspaceRecord(): Promise<WorkspaceRecord | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(WORKSPACE_STORE, "readonly");
  const completion = transactionDone(transaction);
  const record = await requestResult(transaction.objectStore(WORKSPACE_STORE).get(CURRENT_WORKSPACE_ID)) as WorkspaceRecord | undefined;
  await completion;
  return record;
}

async function writeWorkspaceRecord(
  workspace: PersistedWorkspace,
  config: GitHubConfig,
): Promise<void> {
  const database = await openDatabase();
  if (knownRevision === undefined) {
    throw new Error("يجب تحميل مساحة العمل المحلية قبل حفظها كي لا نكتب فوق بيانات تبويب آخر");
  }
  const expectedRevision = knownRevision;

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(WORKSPACE_STORE, "readwrite");
    const store = transaction.objectStore(WORKSPACE_STORE);
    let nextRevision: number | undefined;
    let failure: Error | undefined;

    transaction.oncomplete = () => {
      if (nextRevision === undefined) {
        reject(failure ?? new Error("اكتملت عملية الحفظ دون رقم نسخة صالح"));
        return;
      }
      knownRevision = nextRevision;
      resolve();
    };
    transaction.onabort = () => {
      reject(failure ?? transaction.error ?? new Error("أُلغيت عملية حفظ مساحة العمل المحلية"));
    };
    transaction.onerror = () => {
      failure ??= transaction.error ?? new Error("فشلت عملية حفظ مساحة العمل المحلية");
    };

    const readRequest = store.get(CURRENT_WORKSPACE_ID);
    readRequest.onerror = () => {
      failure = readRequest.error ?? new Error("تعذّرت قراءة رقم نسخة مساحة العمل المحلية");
    };
    readRequest.onsuccess = () => {
      try {
        const currentRecord = readRequest.result as WorkspaceRecord | undefined;
        const actualRevision = workspaceRevision(currentRecord);
        if (actualRevision !== expectedRevision) {
          failure = new WorkspaceRevisionConflictError(expectedRevision, actualRevision);
          transaction.abort();
          return;
        }

        nextRevision = actualRevision + 1;
        const writeRequest = store.put({
          id: CURRENT_WORKSPACE_ID,
          workspace,
          config,
          savedAt: new Date().toISOString(),
          revision: nextRevision,
        } satisfies WorkspaceRecord);
        writeRequest.onerror = () => {
          failure = writeRequest.error ?? new Error("تعذّرت كتابة مساحة العمل المحلية");
        };
      } catch (error) {
        failure = error instanceof Error ? error : new Error("تعذّر التحقق من نسخة مساحة العمل المحلية");
        transaction.abort();
      }
    };
  });
}

function queuedWorkspaceSave(workspace: PersistedWorkspace, config: GitHubConfig): Promise<void> {
  const operation = saveQueue.then(() => writeWorkspaceRecord(workspace, config));
  saveQueue = operation.catch(() => undefined);
  return operation;
}

async function migrateLegacyWorkspace(): Promise<{ workspace: PersistedWorkspace; config: GitHubConfig } | null> {
  if (typeof localStorage === "undefined") return null;

  const rawNotes = safeLegacyJson(LEGACY_NOTES_KEY);
  const rawProjects = safeLegacyJson(LEGACY_PROJECTS_KEY);
  if (!Array.isArray(rawNotes) && !Array.isArray(rawProjects)) return null;

  const notes = Array.isArray(rawNotes) ? rawNotes.map(normalizeNote).filter((note) => note !== null) : [];
  const projects = Array.isArray(rawProjects) ? rawProjects.map(normalizeProject).filter((project) => project !== null) : [];
  if (Array.isArray(rawNotes) && notes.length !== rawNotes.length) throw new Error("تعذّر ترحيل جميع الملاحظات القديمة بأمان");
  if (Array.isArray(rawProjects) && projects.length !== rawProjects.length) throw new Error("تعذّر ترحيل جميع المشاريع القديمة بأمان");
  const rawSelectedId = safeLegacyJson(LEGACY_SELECTED_ID_KEY);
  const selectedId = typeof rawSelectedId === "string" && notes.some((note) => note.id === rawSelectedId)
    ? rawSelectedId
    : notes[0]?.id;
  const config = normalizeConfig(safeLegacyJson(LEGACY_CONFIG_KEY));
  const workspace: PersistedWorkspace = {
    schemaVersion: 2,
    notes,
    projects,
    selectedId,
    sync: {
      shas: {},
      projectSignatures: {},
      dirtyNoteIds: notes.map((note) => note.id),
      dirtyProjectIds: projects.map((project) => project.id),
      projectsDirty: projects.length > 0,
      destination: githubDestination(config),
    },
  };

  await saveWorkspace(workspace, config);
  return { workspace, config };
}

export async function loadWorkspace(): Promise<{ workspace: PersistedWorkspace; config: GitHubConfig } | null> {
  await saveQueue;
  const record = await readCurrentWorkspaceRecord();
  if (record) {
    const revision = workspaceRevision(record);
    const workspace = normalizeWorkspace(record.workspace);
    if (!workspace) throw new Error("بيانات مساحة العمل المحلية غير صالحة");
    knownRevision = revision;
    return { workspace, config: normalizeConfig(record.config) };
  }

  // Absence is itself a known CAS baseline. A concurrent tab that creates the
  // record after this point will advance it to revision 1 and our write will
  // be rejected rather than overwriting that tab.
  knownRevision = 0;
  try {
    const migrated = await migrateLegacyWorkspace();
    if (migrated) return migrated;
  } catch (error) {
    if (!(error instanceof WorkspaceRevisionConflictError)) throw error;
    const winner = await readCurrentWorkspaceRecord();
    if (!winner) throw error;
    const workspace = normalizeWorkspace(winner.workspace);
    if (!workspace) throw new Error("أنشأ تبويب آخر مساحة عمل محلية غير صالحة");
    knownRevision = workspaceRevision(winner);
    return { workspace, config: normalizeConfig(winner.config) };
  }

  // Cover the small race where another tab created an initialized workspace
  // while this tab was checking legacy localStorage that had nothing to move.
  const appeared = await readCurrentWorkspaceRecord();
  if (appeared) {
    const workspace = normalizeWorkspace(appeared.workspace);
    if (!workspace) throw new Error("أنشأ تبويب آخر مساحة عمل محلية غير صالحة");
    knownRevision = workspaceRevision(appeared);
    return { workspace, config: normalizeConfig(appeared.config) };
  }
  return null;
}

export async function saveWorkspace(workspace: PersistedWorkspace, config: GitHubConfig): Promise<void> {
  const normalizedWorkspace = normalizeWorkspace(workspace);
  if (!normalizedWorkspace) throw new Error("تعذّر حفظ مساحة عمل غير صالحة");
  await queuedWorkspaceSave(normalizedWorkspace, normalizeConfig(config));
}

export async function saveWorkspaceBackup(workspace: PersistedWorkspace): Promise<void> {
  const normalizedWorkspace = normalizeWorkspace(workspace);
  if (!normalizedWorkspace) throw new Error("تعذّر نسخ مساحة عمل غير صالحة احتياطيًا");

  const database = await openDatabase();
  const savedAt = new Date().toISOString();
  const backup = {
    id: `${savedAt}-${crypto.randomUUID()}`,
    workspace: normalizedWorkspace,
    savedAt,
  } satisfies BackupRecord;

  // Read and write in separate transactions so Safari cannot auto-close a
  // read/write transaction while the promise continuation is pending.
  const readTransaction = database.transaction(BACKUP_STORE, "readonly");
  const records = await requestResult(readTransaction.objectStore(BACKUP_STORE).getAll()) as BackupRecord[];

  const transaction = database.transaction(BACKUP_STORE, "readwrite");
  const store = transaction.objectStore(BACKUP_STORE);
  store.put(backup);
  [...records, backup]
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    .slice(MAX_BACKUPS)
    .forEach((record) => store.delete(record.id));
  await transactionDone(transaction);
}
