import {
  noteContentSignature,
  normalizeNote,
  normalizeProject,
  projectContentSignature,
  type GitHubConfig,
  type Note,
  type Project,
} from "./workspace-model";

const GITHUB_API = "https://api.github.com";

type GitHubContentFile = {
  type: "file";
  path: string;
  sha: string;
  content?: string;
  encoding?: string;
};

type GitHubDirectoryEntry = {
  type: "file" | "dir" | "symlink" | "submodule";
  path: string;
  name: string;
  sha: string;
};

type GitHubWriteResponse = {
  content?: {
    path?: string;
    sha?: string;
  } | null;
  commit?: {
    sha?: string;
  } | null;
};

type GitHubBlob = {
  sha?: string;
  content?: string;
  encoding?: string;
};

type MigrationMarker = {
  schemaVersion: 2;
  legacySha: string | null;
  completedAt: string;
  migratedNoteIds?: string[];
  migratedProjectIds?: string[];
};

export type RemoteNote = {
  note: Note;
  sha: string;
  path: string;
};

export type RemoteProjects = {
  projects: Project[];
  sha: string;
  path: string;
};

export type PullRemoteWorkspaceResult = {
  notes: RemoteNote[];
  projects?: RemoteProjects;
  legacy?: boolean;
  revision: string;
  auxiliaryShas?: Record<string, string>;
  preservedLegacyNoteSignatures: string[];
  preservedLegacyProjectSignatures: string[];
};

export type PushDirtyWorkspaceProgress = {
  kind: "preview" | "note" | "projects" | "marker";
  path: string;
  noteId?: string;
  shas: Record<string, string>;
  remoteRevision: string;
};

export type PushDirtyWorkspaceInput = {
  config: GitHubConfig;
  token: string;
  notes: Note[];
  projects: Project[];
  dirtyNoteIds: string[];
  projectsDirty: boolean;
  shas: Record<string, string>;
  previews: Record<string, string>;
  onProgress?: (progress: PushDirtyWorkspaceProgress) => void;
};

export type PushDirtyWorkspaceResult = {
  shas: Record<string, string>;
  lastSyncAt: string;
  syncedNoteIds: string[];
  projectsSynced: boolean;
  remoteRevision: string;
};

export class SyncConflictError extends Error {
  readonly path: string;
  readonly remoteSha?: string;

  constructor(path: string, message = "توجد نسخة أحدث على GitHub", remoteSha?: string) {
    super(message);
    this.name = "SyncConflictError";
    this.path = path;
    this.remoteSha = remoteSha;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseManifestIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) return null;
  const ids = value.map((id) => (id as string).trim());
  if (new Set(ids).size !== ids.length) return null;
  return ids.sort((left, right) => left.localeCompare(right));
}

function parseMigrationMarker(file: GitHubContentFile): MigrationMarker | null {
  try {
    const value = parseFileJson(file);
    if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.completedAt !== "string" || !value.completedAt) return null;
    if (value.legacySha !== null && (typeof value.legacySha !== "string" || !value.legacySha)) return null;
    const migratedNoteIds = value.migratedNoteIds === undefined ? undefined : parseManifestIds(value.migratedNoteIds);
    const migratedProjectIds = value.migratedProjectIds === undefined ? undefined : parseManifestIds(value.migratedProjectIds);
    return {
      schemaVersion: 2,
      legacySha: value.legacySha as string | null,
      completedAt: value.completedAt,
      ...(migratedNoteIds ? { migratedNoteIds } : {}),
      ...(migratedProjectIds ? { migratedProjectIds } : {}),
    };
  } catch {
    return null;
  }
}

function createMigrationMarker(
  legacySha: string | null,
  completedAt = new Date().toISOString(),
): MigrationMarker {
  return {
    schemaVersion: 2,
    legacySha,
    completedAt,
  };
}

function migrationMarkerMatchesLegacy(marker: MigrationMarker, legacySha: string | null): boolean {
  return marker.legacySha === legacySha;
}

function stableConflictHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function legacyNoteConflictCopy(note: Note, id: string): Note {
  const notice = "نسخة محفوظة من ملف workspace.json أثناء الترحيل؛ راجعها قبل دمجها.";
  const previousInstruction = note.organization.instruction?.trim();
  return {
    ...note,
    id,
    title: `${note.title} — نسخة قديمة محفوظة`,
    status: "raw",
    organization: {
      ...note.organization,
      state: "draft",
      instruction: previousInstruction ? `${notice}\n\n${previousInstruction}` : notice,
    },
  };
}

function legacyProjectConflictCopy(project: Project, id: string): Project {
  return {
    ...project,
    id,
    name: `${project.name} — نسخة قديمة محفوظة`,
  };
}

function mergeLegacyNotes(
  legacyNotes: RemoteNote[],
  v2Notes: RemoteNote[],
  legacyProjectIdRemap: ReadonlyMap<string, string>,
): RemoteNote[] {
  const merged = new Map(v2Notes.map((record) => [record.note.id, record]));
  for (const legacyRecord of legacyNotes) {
    const remappedProjectId = legacyRecord.note.projectId
      ? legacyProjectIdRemap.get(legacyRecord.note.projectId)
      : undefined;
    const candidateRecord = remappedProjectId
      ? { ...legacyRecord, note: { ...legacyRecord.note, projectId: remappedProjectId } }
      : legacyRecord;
    const v2Record = merged.get(candidateRecord.note.id);
    if (!v2Record) {
      merged.set(candidateRecord.note.id, candidateRecord);
      continue;
    }
    if (noteContentSignature(v2Record.note) === noteContentSignature(candidateRecord.note)) continue;

    const baseId = `note-legacy-conflict-${stableConflictHash(`${candidateRecord.note.id}\u0000${noteContentSignature(candidateRecord.note)}`)}`;
    let suffix = 1;
    while (true) {
      const id = suffix === 1 ? baseId : `${baseId}-${suffix}`;
      const conflictNote = legacyNoteConflictCopy(candidateRecord.note, id);
      const existing = merged.get(id);
      if (!existing) {
        merged.set(id, { ...candidateRecord, note: conflictNote });
        break;
      }
      if (noteContentSignature(existing.note) === noteContentSignature(conflictNote)) break;
      suffix += 1;
    }
  }
  return [...merged.values()];
}

function mergeLegacyProjects(
  legacyProjects: Project[],
  v2Projects: Project[],
): { projects: Project[]; legacyIdRemap: Map<string, string> } {
  const merged = new Map(v2Projects.map((project) => [project.id, project]));
  const legacyIdRemap = new Map<string, string>();
  for (const legacyProject of legacyProjects) {
    const v2Project = merged.get(legacyProject.id);
    if (!v2Project) {
      merged.set(legacyProject.id, legacyProject);
      continue;
    }
    if (projectContentSignature(v2Project) === projectContentSignature(legacyProject)) continue;

    const baseId = `project-legacy-conflict-${stableConflictHash(`${legacyProject.id}\u0000${projectContentSignature(legacyProject)}`)}`;
    let suffix = 1;
    while (true) {
      const id = suffix === 1 ? baseId : `${baseId}-${suffix}`;
      const conflictProject = legacyProjectConflictCopy(legacyProject, id);
      const existing = merged.get(id);
      if (!existing) {
        merged.set(id, conflictProject);
        legacyIdRemap.set(legacyProject.id, id);
        break;
      }
      if (projectContentSignature(existing) === projectContentSignature(conflictProject)) {
        legacyIdRemap.set(legacyProject.id, id);
        break;
      }
      suffix += 1;
    }
  }
  return { projects: [...merged.values()], legacyIdRemap };
}

function ensureConfig(config: GitHubConfig, token: string): void {
  if (!config.owner.trim() || !config.repo.trim() || !config.branch.trim() || !token.trim()) {
    throw new Error("أكمل إعدادات مستودع GitHub الخاص ورمز الوصول");
  }
  const segments = normalizedBasePath(config).split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("مسار بيانات GitHub غير صالح");
  }
}

function normalizedBasePath(config: GitHubConfig): string {
  return config.basePath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function joinPath(config: GitHubConfig, ...segments: string[]): string {
  return [normalizedBasePath(config), ...segments].filter(Boolean).join("/");
}

function notePath(config: GitHubConfig, noteId: string): string {
  if (!noteId || /[\\/\u0000-\u001f]/.test(noteId) || noteId === "." || noteId === "..") {
    throw new Error(`معرّف الملاحظة غير صالح: ${noteId || "فارغ"}`);
  }
  return joinPath(config, "notes", `${noteId}.json`);
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function repositoryUrl(config: GitHubConfig): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(config.owner.trim())}/${encodeURIComponent(config.repo.trim())}`;
}

function contentsUrl(config: GitHubConfig, path: string): string {
  return `${repositoryUrl(config)}/contents/${encodedPath(path)}`;
}

function requestHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token.trim()}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown };
    return typeof body.message === "string" ? body.message : `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function ensurePrivateRepository(config: GitHubConfig, token: string): Promise<void> {
  const response = await fetch(repositoryUrl(config), { headers: requestHeaders(token) });
  if (!response.ok) throw new Error(`تعذّر الوصول إلى مستودع GitHub: ${await readError(response)}`);
  const repository = await response.json() as { private?: unknown };
  if (repository.private !== true) {
    throw new Error("رُفضت المزامنة لأن مستودع البيانات ليس خاصًا");
  }
}

async function readBranchRevision(config: GitHubConfig, token: string): Promise<string> {
  const response = await fetch(`${repositoryUrl(config)}/commits/${encodeURIComponent(config.branch.trim())}`, {
    headers: requestHeaders(token),
  });
  if (!response.ok) throw new Error(`تعذّر فحص أحدث نسخة في GitHub: ${await readError(response)}`);
  const commit = await response.json() as { sha?: unknown };
  if (typeof commit.sha !== "string" || !commit.sha) throw new Error("لم يُرجع GitHub معرّف نسخة صالحًا");
  return commit.sha;
}

export async function getRemoteRevision(config: GitHubConfig, token: string): Promise<string> {
  ensureConfig(config, token);
  await ensurePrivateRepository(config, token);
  return readBranchRevision(config, token);
}

function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function getContent(
  config: GitHubConfig,
  token: string,
  path: string,
  includeBody = true,
): Promise<GitHubContentFile | null> {
  const url = new URL(contentsUrl(config, path));
  url.searchParams.set("ref", config.branch.trim());
  const response = await fetch(url, { headers: requestHeaders(token) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`تعذّرت قراءة ${path}: ${await readError(response)}`);
  const content = await response.json() as GitHubContentFile | GitHubDirectoryEntry[];
  if (Array.isArray(content) || content.type !== "file" || !content.sha) {
    throw new Error(`المسار ${path} ليس ملفًا صالحًا`);
  }
  if (includeBody && (content.encoding !== "base64" || typeof content.content !== "string" || !content.content)) {
    const blobResponse = await fetch(
      `${repositoryUrl(config)}/git/blobs/${encodeURIComponent(content.sha)}`,
      { headers: requestHeaders(token) },
    );
    if (!blobResponse.ok) throw new Error(`تعذّرت قراءة محتوى ${path}: ${await readError(blobResponse)}`);
    const blob = await blobResponse.json() as GitHubBlob;
    if (blob.encoding !== "base64" || typeof blob.content !== "string") {
      throw new Error(`ملف ${path} أكبر من الحد الذي تدعمه مزامنة GitHub`);
    }
    return { ...content, content: blob.content, encoding: blob.encoding };
  }
  return content;
}

async function listDirectory(config: GitHubConfig, token: string, path: string): Promise<GitHubDirectoryEntry[]> {
  const url = new URL(contentsUrl(config, path));
  url.searchParams.set("ref", config.branch.trim());
  const response = await fetch(url, { headers: requestHeaders(token) });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`تعذّرت قراءة مجلد ${path}: ${await readError(response)}`);
  const entries = await response.json() as GitHubContentFile | GitHubDirectoryEntry[];
  if (!Array.isArray(entries)) throw new Error(`المسار ${path} ليس مجلدًا صالحًا`);
  return entries;
}

function parseFileJson(file: GitHubContentFile): unknown {
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error(`تعذّر فك محتوى ${file.path}`);
  }
  try {
    return JSON.parse(decodeBase64(file.content));
  } catch {
    throw new Error(`ملف ${file.path} لا يحتوي JSON صالحًا`);
  }
}

async function putContent(
  config: GitHubConfig,
  token: string,
  path: string,
  value: unknown,
  knownSha: string | undefined,
  message: string,
  encodedContent?: string,
): Promise<{ contentSha: string; commitSha: string }> {
  if (!knownSha) {
    const existing = await getContent(config, token, path, false);
    if (existing) {
      throw new SyncConflictError(path, "الملف موجود على GitHub لكن نسخته لم تُقرأ في هذه الجلسة", existing.sha);
    }
  }

  const response = await fetch(contentsUrl(config, path), {
    method: "PUT",
    headers: {
      ...requestHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: encodedContent ?? encodeBase64(`${JSON.stringify(value)}\n`),
      branch: config.branch.trim(),
      ...(knownSha ? { sha: knownSha } : {}),
    }),
  });

  if (response.status === 409 || response.status === 422) {
    throw new SyncConflictError(path, `رفض GitHub الكتابة لأن الملف تغيّر: ${await readError(response)}`);
  }
  if (!response.ok) throw new Error(`تعذّرت كتابة ${path}: ${await readError(response)}`);
  const result = await response.json() as GitHubWriteResponse;
  const sha = result.content?.sha;
  if (!sha) throw new Error(`نجحت كتابة ${path} دون إعادة SHA صالح من GitHub`);
  const commitSha = result.commit?.sha;
  if (!commitSha) throw new Error(`نجحت كتابة ${path} دون إعادة نسخة commit صالحة من GitHub`);
  return { contentSha: sha, commitSha };
}

function parseLegacyWorkspace(file: GitHubContentFile, revision: string): PullRemoteWorkspaceResult {
  const path = file.path;
  const value = parseFileJson(file);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ملف ${path} القديم غير صالح`);
  }
  const record = value as Record<string, unknown>;
  const rawNotes = Array.isArray(record.notes) ? record.notes : [];
  const rawProjects = Array.isArray(record.projects) ? record.projects : [];
  const normalizedNotes = rawNotes.map(normalizeNote).filter((note) => note !== null);
  const projects = rawProjects.map(normalizeProject).filter((project) => project !== null);
  if (normalizedNotes.length !== rawNotes.length || projects.length !== rawProjects.length) {
    throw new Error(`ملف ${path} يحتوي عناصر لا يمكن ترحيلها بأمان`);
  }
  const notes = normalizedNotes.map((note) => ({ note, sha: file.sha, path }));
  return {
    notes,
    projects: { projects, sha: file.sha, path },
    legacy: true,
    revision,
    preservedLegacyNoteSignatures: normalizedNotes.map((note) => `${note.id}\u0000${noteContentSignature(note)}`),
    preservedLegacyProjectSignatures: projects.map((project) => `${project.id}\u0000${projectContentSignature(project)}`),
  };
}

export async function pullRemoteWorkspace(config: GitHubConfig, token: string): Promise<PullRemoteWorkspaceResult> {
  ensureConfig(config, token);
  await ensurePrivateRepository(config, token);
  const revision = await readBranchRevision(config, token);
  const migrationMarkerPath = joinPath(config, "schema-v2.json");
  const legacyPath = joinPath(config, "workspace.json");
  const migrationMarker = await getContent(config, token, migrationMarkerPath);
  const legacyMetadata = await getContent(config, token, legacyPath, false);
  const currentLegacySha = legacyMetadata?.sha ?? null;
  const auxiliaryShas: Record<string, string> = migrationMarker ? { [migrationMarkerPath]: migrationMarker.sha } : {};
  if (legacyMetadata) auxiliaryShas[legacyPath] = legacyMetadata.sha;
  const previewEntries = await listDirectory(config, token, joinPath(config, "previews"));
  for (const entry of previewEntries) {
    if (entry.type === "file" && entry.name.endsWith(".webp")) auxiliaryShas[entry.path] = entry.sha;
  }

  const notesDirectory = joinPath(config, "notes");
  const entries = await listDirectory(config, token, notesDirectory);
  const noteEntries = entries
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".json"))
    .sort((left, right) => left.path.localeCompare(right.path));
  const notes: RemoteNote[] = [];
  for (const entry of noteEntries) {
    const file = await getContent(config, token, entry.path);
    if (!file) throw new Error(`اختفى ملف ${entry.path} أثناء المزامنة`);
    const note = normalizeNote(parseFileJson(file));
    if (!note) throw new Error(`الملاحظة في ${entry.path} غير صالحة`);
    if (entry.name !== `${note.id}.json`) {
      throw new Error(`اسم ملف الملاحظة ${entry.path} لا يطابق معرّفها`);
    }
    notes.push({ note, sha: file.sha, path: file.path });
  }

  const projectsPath = joinPath(config, "projects.json");
  const projectsFile = await getContent(config, token, projectsPath);
  let projects: RemoteProjects | undefined;
  if (projectsFile) {
    const value = parseFileJson(projectsFile);
    if (!Array.isArray(value)) throw new Error(`ملف ${projectsPath} غير صالح`);
    const normalizedProjects = value.map(normalizeProject).filter((project) => project !== null);
    if (normalizedProjects.length !== value.length) throw new Error(`ملف ${projectsPath} يحتوي مشاريع غير صالحة`);
    projects = { projects: normalizedProjects, sha: projectsFile.sha, path: projectsFile.path };
  }

  const markerValue = migrationMarker ? parseMigrationMarker(migrationMarker) : null;
  const markerIsComplete = Boolean(markerValue && migrationMarkerMatchesLegacy(markerValue, currentLegacySha));
  if (!markerIsComplete) {
    if (legacyMetadata) {
      const legacyFile = await getContent(config, token, legacyPath);
      if (!legacyFile) throw new Error(`اختفى ملف ${legacyPath} أثناء المزامنة`);
      auxiliaryShas[legacyPath] = legacyFile.sha;
      const legacy = parseLegacyWorkspace(legacyFile, revision);
      const mergedProjects = mergeLegacyProjects(legacy.projects?.projects ?? [], projects?.projects ?? []);
      const mergedNotes = mergeLegacyNotes(legacy.notes, notes, mergedProjects.legacyIdRemap);
      return {
        notes: mergedNotes,
        projects: {
          projects: mergedProjects.projects,
          sha: projects?.sha ?? legacy.projects?.sha ?? "",
          path: projects?.path ?? legacy.projects?.path ?? projectsPath,
        },
        legacy: true,
        revision,
        auxiliaryShas,
        preservedLegacyNoteSignatures: legacy.preservedLegacyNoteSignatures,
        preservedLegacyProjectSignatures: legacy.preservedLegacyProjectSignatures,
      };
    }
    return {
      notes,
      projects,
      legacy: true,
      revision,
      auxiliaryShas,
      preservedLegacyNoteSignatures: [],
      preservedLegacyProjectSignatures: [],
    };
  }
  return {
    notes,
    projects,
    revision,
    auxiliaryShas,
    preservedLegacyNoteSignatures: [],
    preservedLegacyProjectSignatures: [],
  };
}

function reportPushProgress(
  input: PushDirtyWorkspaceInput,
  kind: PushDirtyWorkspaceProgress["kind"],
  path: string,
  shas: Record<string, string>,
  remoteRevision: string,
  noteId?: string,
): void {
  input.onProgress?.({
    kind,
    path,
    ...(noteId ? { noteId } : {}),
    shas: { ...shas },
    remoteRevision,
  });
}

export async function pushDirtyWorkspace(input: PushDirtyWorkspaceInput): Promise<PushDirtyWorkspaceResult> {
  ensureConfig(input.config, input.token);
  await ensurePrivateRepository(input.config, input.token);

  const shas = { ...input.shas };
  const syncedNoteIds: string[] = [];
  let remoteRevision = "";
  const dirtyIds = new Set(input.dirtyNoteIds);
  for (const note of input.notes) {
    if (!dirtyIds.has(note.id)) continue;
    const preview = input.previews[note.id];
    if (preview) {
      const previewPath = joinPath(input.config, "previews", `${note.id}.webp`);
      const previewWrite = await putContent(
        input.config,
        input.token,
        previewPath,
        null,
        shas[previewPath],
        `Save note preview ${note.id}`,
        preview,
      );
      shas[previewPath] = previewWrite.contentSha;
      remoteRevision = previewWrite.commitSha;
      reportPushProgress(input, "preview", previewPath, shas, remoteRevision, note.id);
    }
    const path = notePath(input.config, note.id);
    const write = await putContent(
      input.config,
      input.token,
      path,
      note,
      shas[path],
      `Save note ${note.id}`,
    );
    shas[path] = write.contentSha;
    remoteRevision = write.commitSha;
    reportPushProgress(input, "note", path, shas, remoteRevision, note.id);
    syncedNoteIds.push(note.id);
  }

  let projectsSynced = false;
  if (input.projectsDirty) {
    const path = joinPath(input.config, "projects.json");
    const write = await putContent(
      input.config,
      input.token,
      path,
      input.projects,
      shas[path],
      "Save projects",
    );
    shas[path] = write.contentSha;
    remoteRevision = write.commitSha;
    reportPushProgress(input, "projects", path, shas, remoteRevision);
    projectsSynced = true;
  }

  const migrationMarkerPath = joinPath(input.config, "schema-v2.json");
  const legacyPath = joinPath(input.config, "workspace.json");
  const currentLegacyFile = await getContent(input.config, input.token, legacyPath, false);
  const currentLegacySha = currentLegacyFile?.sha ?? null;
  if (currentLegacySha) shas[legacyPath] = currentLegacySha;
  else delete shas[legacyPath];
  const existingMarkerFile = await getContent(input.config, input.token, migrationMarkerPath);
  const existingMarker = existingMarkerFile ? parseMigrationMarker(existingMarkerFile) : null;
  if (existingMarkerFile && existingMarker && migrationMarkerMatchesLegacy(existingMarker, currentLegacySha)) {
    shas[migrationMarkerPath] = existingMarkerFile.sha;
  } else {
    if (currentLegacySha && input.shas[legacyPath] !== currentLegacySha) {
      throw new SyncConflictError(
        legacyPath,
        "تغيّر ملف workspace.json القديم؛ استخدم «جلب ودمج» قبل إكمال الترحيل",
        currentLegacySha,
      );
    }
    const desiredMarker = createMigrationMarker(currentLegacySha);
    const markerWrite = await putContent(
      input.config,
      input.token,
      migrationMarkerPath,
      desiredMarker,
      existingMarkerFile?.sha,
      existingMarkerFile ? "Update workspace data manifest" : "Complete workspace data migration",
    );
    shas[migrationMarkerPath] = markerWrite.contentSha;
    remoteRevision = markerWrite.commitSha;
    reportPushProgress(input, "marker", migrationMarkerPath, shas, remoteRevision);
  }

  if (!remoteRevision) remoteRevision = await readBranchRevision(input.config, input.token);

  return {
    shas,
    lastSyncAt: new Date().toISOString(),
    syncedNoteIds,
    projectsSynced,
    remoteRevision,
  };
}
