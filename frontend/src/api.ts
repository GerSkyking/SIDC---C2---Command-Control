import { t } from "./i18n";
// Dünne fetch-Hülle. Session läuft über das HttpOnly-Cookie, daher nur credentials:"include".

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* kein JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface Me {
  id: string;
  username: string;
  display_name?: string;
  role: string;
  can_create_plans_effective: boolean;
  is_mission_builder_effective: boolean;
  is_zeus_effective?: boolean;
  ui_settings?: Record<string, unknown>;
}
export interface MapItem {
  id: string;
  name: string;
  status: string;
  error: string | null;
}

export interface ApiTokenItem {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked: boolean;
}

export interface MapSource {
  id: string;
  kind: string;
  name: string;
  base_url: string;
  repo: string;
  subpath: string;
  ref: string;
  has_token: boolean;
}
export interface PlanItem {
  id: string;
  name: string;
  map_id: string;
  folder_id: string | null;
  ordering: number;
  level: "viewer" | "editor" | "owner";
  project_id?: string | null;
}
export interface ProjectPlanItem extends PlanItem {
  project_name: string;
}
export interface PlanFolder {
  id: string;
  name: string;
  parent_id: string | null;
  ordering: number;
  /** Ersteller (fehlt bei Alt-Ordnern) – steuert, wer Umbenennen/Löschen angezeigt bekommt */
  created_by?: string | null;
}
export interface Favorite {
  id: string;
  label: string;
  sidc: string;
  rotation_degrees: number;
  unit_text: string;
  ai_text: string;
  channel?: string;
  is_multipoint: boolean;
  max_line_points: number;
  tint?: string;
}
export interface Phase {
  id: string;
  name: string;
  ordering: number;
  notes: string;
  plane?: "player" | "builder";
  parent_id?: string | null;
  sub_ordering?: number;
  start_at?: string | null;
  end_at?: string | null;
  locked?: boolean;
  zeus_released?: boolean;
  zeus_until?: string | null;
  player_released?: boolean;
}
export interface PlanLayer {
  id: string;
  name: string;
  color: number;
  ordering: number;
  is_default?: boolean;
}
export interface PlanVersionRow {
  id: string;
  label: string;
  created_at: string;
  author: string;
  marker_count: number;
  stroke_count: number;
}
export interface AdminUser {
  id: string;
  username: string;
  display_name?: string;
  role: string;
  can_create_plans: boolean;
  is_mission_builder: boolean;
  is_zeus?: boolean;
  is_active: boolean;
  is_local: boolean;
}
export interface PlanImage {
  id: string;
  plan_id?: string;
  phase_id: string | null;
  filename: string;
  content_type: string;
  byte_size: number;
  natural_w: number;
  natural_h: number;
  caption: string;
  note: string;
  author?: string | null;
}
/** Eine Platzierung eines PlanImage auf der Karte — ein Bild kann beliebig oft
 * (auch in mehreren Phasen) platziert werden. */
export interface ImagePlacement {
  id: string;
  image_id: string;
  plan_id?: string;
  phase_id: string | null;
  world_x: number;
  world_y: number;
  map_width: number;
  scale_fixed: boolean;
  ref_zoom: number;
}
// ─── Missionsbau-Projekte (docs/PROJEKTE.md) ──────────────────────────────
export type ProjectRole = "viewer" | "editor" | "owner";
export type ProjectSpace = "public" | "builder";
export type TaskStatus = "open" | "doing" | "review" | "done";
export type TaskPriority = "low" | "normal" | "high";
export type NoteColor = "yellow" | "green" | "blue" | "pink" | "orange" | "gray";
export interface ProjectItem {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  role: ProjectRole;
  plan_count: number;
  open_tasks: number;
  my_open_tasks: number;
  updated_at: string | null;
  folder_id?: string | null;
}
export interface ProjectFolder {
  id: string;
  name: string;
  parent_id: string | null;
  ordering?: number;
  created_by?: string | null;
}
export interface ProjectDetail {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  role: ProjectRole;
  is_builder: boolean;
}
export interface ProjectMember {
  subject_type: "user" | "group";
  subject_id: string;
  role: ProjectRole;
  name?: string;
}
export interface ProjectCandidate {
  subject_type: "user" | "group";
  subject_id: string;
  name: string;
}
export interface ProjectDocNode {
  id: string;
  parent_id: string | null;
  kind: "folder" | "doc";
  name: string;
  byte_size: number;
  updated_at: string;
  updated_by?: string | null;
}
export interface ProjectDoc extends ProjectDocNode {
  content: string;
  space?: ProjectSpace;
}
export interface ProjectImage {
  id: string;
  plan_id: string;
  plan_name: string;
  filename: string;
  caption: string;
  byte_size: number;
  natural_w: number;
  natural_h: number;
  created_at: string;
  author?: string | null;
}
export interface ProjectNote {
  id: string;
  text: string;
  color: NoteColor;
  x: number;
  y: number;
  w: number;
  h: number;
  updated_by?: string | null;
  /** Verknüpfte Aufgabe / verknüpfter Nutzer ("" beim Senden = Verknüpfung entfernen) */
  task_id?: string | null;
  task_title?: string | null;
  user_id?: string | null;
  user_label?: string | null;
}
export interface NoteLink {
  id: string;
  from_id: string;
  to_id: string;
}
export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  assignee_label?: string | null;
  due_date: string | null;
  ordering: number;
  plan_id: string | null;
  plan_name?: string | null;
  doc_id: string | null;
  doc_name?: string | null;
  done_at?: string | null;
}
export interface ChatConversation {
  id: string;
  kind: "dm" | "group";
  name: string;
  source_type: "group" | "project" | null;
  source_id: string | null;
  other_user_id: string | null;
  member_count: number;
  is_owner: boolean;
  unread: number;
  updated_at: string | null;
  last: { text: string; user_label: string | null; created_at: string } | null;
}
export interface ChatMessage {
  id: string;
  user_id: string | null;
  user_label: string | null;
  text: string;
  mentions: { type: "user" | "group" | "project"; id: string; token: string }[];
  origin?: string | null;
  created_at: string;
  edited_at: string | null;
  mine: boolean;
}
export interface NotifyField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string;
}
export interface NotifyType {
  type: string;
  label: string;
  help: string;
  fields: NotifyField[];
  form: boolean;
  available: boolean;
}
export type NotifyKind = "task_mention" | "chat_mention" | "assigned";
export interface NotifyChannel {
  id: string;
  type: string;
  name: string;
  kinds: NotifyKind[];
  enabled: boolean;
  config: Record<string, unknown> & { _set?: string[] };
  last_ok_at: string | null;
  last_error: string;
}
export interface ChatNotification {
  id: string;
  kind: "task_mention" | "chat_mention" | "assigned";
  actor_id: string | null;
  actor_label: string | null;
  title: string;
  text: string;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  conversation_id: string | null;
  read: boolean;
  created_at: string;
}
export interface ChatPeople {
  users: { id: string; label: string; username: string }[];
  groups: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}
export interface Mentionable {
  type: "user" | "group" | "project";
  id: string;
  handle: string;
  label: string;
}
export interface TaskComment {
  id: string;
  task_id: string;
  user_id: string | null;
  user_label: string | null;
  text: string;
  mentions: { type: "user" | "group" | "project"; id: string; token: string }[];
  created_at: string;
  edited_at: string | null;
  can_edit: boolean;
  can_delete: boolean;
}
export interface ActivityEntry {
  id: string;
  kind: string;
  target_type: "task" | "doc" | "note" | "project";
  target_id: string | null;
  target_title: string;
  user_id: string | null;
  user_label: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}
export interface ActivitySummaryRow {
  user_id: string | null;
  label: string | null;
  count: number;
  last: string | null;
}
export interface ProjectOverview {
  open_by_assignee: { user_id: string | null; label: string; open: number; doing: number; review: number }[];
  due_soon: ProjectTask[];
  overdue: ProjectTask[];
  recent_docs: { id: string; name: string; space?: ProjectSpace; kind?: string; updated_at: string; updated_by?: string | null }[];
  recent_plans: { id: string; name: string; updated_at?: string | null }[];
  counts: { docs: number; images: number; plans: number; tasks_open: number };
}
export interface ProjectStorageRow {
  project_id: string;
  name: string;
  images_bytes: number;
  docs_bytes: number;
  plans_count: number;
  total_bytes: number;
}
export interface AdminGroup {
  id: string;
  name: string;
  can_create_plans: boolean;
  is_mission_builder: boolean;
  is_zeus?: boolean;
  member_ids: string[];
}
export interface AclEntry {
  id: string;
  subject_type: "user" | "group";
  subject_id: string;
  level: "viewer" | "editor" | "owner";
  can_place: boolean;
  can_move: boolean;
  can_delete: boolean;
  can_draw: boolean;
}
export interface AclCandidate {
  subject_type: "user" | "group";
  subject_id: string;
  name: string;
}
export interface OrbatNode {
  id: string;
  parent_id: string | null;
  name: string;
  sidc: string;
  qty_planned: number | null;
  qty_current: number | null;
  status: "active" | "damaged" | "destroyed";
  ordering: number;
  notes: string;
  rel_visible?: boolean;
  rel_show_type?: boolean;
  rel_strength?: number;
  released?: boolean;
}
export interface Orbat {
  id: string;
  name: string;
  affiliation: "friend" | "hostile" | "neutral" | "unknown";
  notes?: string;
  level?: "viewer" | "editor" | null;
  is_owner?: boolean;
  nodes?: OrbatNode[];
  released?: boolean;
}
export interface ShareOpts {
  label?: string;
  expires_days?: number;
  include_builder?: boolean;
  can_point?: boolean;
  can_edit?: boolean;
  can_move?: boolean;
  phase_ids?: string[];
  date_from?: string | null;
  date_to?: string | null;
}
export interface PublicShareRow {
  token: string;
  label: string;
  revoked: boolean;
  include_builder?: boolean;
  can_point?: boolean;
  can_edit?: boolean;
  can_move?: boolean;
  phase_ids?: string[];
  date_from?: string | null;
  date_to?: string | null;
  created_at: string;
  expires_at: string | null;
}
export interface AuditRow {
  ts: string;
  user: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

/** Rohes ZIP per XHR hochladen (Fortschrittsanzeige, Cookie-Auth). */
function uploadZip<T>(url: string, file: File, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/zip");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.((e.loaded / e.total) * 100);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new ApiError(xhr.status, xhr.statusText || `HTTP ${xhr.status}`));
        }
      } else {
        let d = xhr.statusText;
        try {
          d = JSON.parse(xhr.responseText).detail ?? d;
        } catch {
          /* nicht-JSON */
        }
        reject(new ApiError(xhr.status, d || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, t("err.uploadNetwork")));
    xhr.send(file);
  });
}

export const api = {
  me: () => req<Me>("GET", "/auth/me"),
  saveSettings: (patch: Record<string, unknown>) => req<Me>("PATCH", "/auth/me/settings", patch),
  saveDisplayName: (display_name: string) => req<Me>("PATCH", "/auth/me", { display_name }),
  login: (username: string, password: string) =>
    req<Me>("POST", "/auth/login", { username, password }),
  logout: () => req<void>("POST", "/auth/logout"),
  uiDefaults: () => req<{ road_colors: { main: string; secondary: string; path: string } }>("GET", "/api/ui-defaults"),
  oidcEnabled: () => req<{ enabled: boolean }>("GET", "/auth/oidc/enabled"),

  maps: () => req<MapItem[]>("GET", "/api/maps"),
  importMap: (id: string, name: string, url: string) =>
    req<MapItem>("POST", "/api/maps", { id, name, url }),
  reimportMap: (id: string) => req<MapItem>("POST", `/api/maps/${id}/reimport`),
  uploadMapFile: (id: string, name: string, file: File, onProgress?: (pct: number) => void) =>
    uploadZip<MapItem>(`/api/maps/${id}/upload?name=${encodeURIComponent(name)}`, file, onProgress),
  apiTokens: () => req<ApiTokenItem[]>("GET", "/api/tokens"),
  createApiToken: (name: string, expires_days: number | null) =>
    req<ApiTokenItem & { token: string }>("POST", "/api/tokens", { name, expires_days }),
  revokeApiToken: (id: string) => req<{ ok: boolean }>("DELETE", `/api/tokens/${id}`),
  deleteMap: (id: string) => req<void>("DELETE", `/api/maps/${id}`),
  restartBackend: () => req<{ message: string }>("POST", "/api/admin/restart"),

  mapSources: () => req<MapSource[]>("GET", "/api/map-sources"),
  createMapSource: (url: string, name = "", token = "") =>
    req<MapSource>("POST", "/api/map-sources", { url, name, token: token || null }),
  deleteMapSource: (id: string) => req<void>("DELETE", `/api/map-sources/${id}`),
  mapSourceFiles: (id: string, all = false) =>
    req<{ name: string; size: number; download_url: string; path: string }[]>(
      "GET",
      `/api/map-sources/${id}/files${all ? "?all=true" : ""}`,
    ),
  importFromSource: (id: string, name: string, source_id: string, file: string) =>
    req<MapItem>("POST", "/api/maps/import-from-source", { id, name, source_id, file }),
  importCatalogFromSource: (sourceId: string, path: string, target: string) =>
    req<{ ok: boolean; target: string; bytes: number }>(
      "POST",
      `/api/map-sources/${sourceId}/import-catalog`,
      { path, target },
    ),

  catalogStatus: () => req<Record<string, boolean>>("GET", "/api/catalog"),
  uploadCatalog: async (name: string, file: File) => {
    const isXlsx = /\.xlsx$/i.test(file.name);
    const r = await fetch(`/api/admin/catalog/${name}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": isXlsx
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/json",
      },
      body: isXlsx ? file : await file.text(),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      let detail = body;
      try {
        detail = JSON.parse(body).detail ?? body;
      } catch {
        /* nicht-JSON (z.B. nginx-Fehlerseite) */
      }
      if (r.status === 413 || /request entity too large/i.test(body)) {
        detail = t("err.proxyTooLarge");
      }
      throw new ApiError(r.status, detail || `HTTP ${r.status}`);
    }
    return r.json();
  },
  deleteCatalog: (name: string) => req<void>("DELETE", `/api/admin/catalog/${name}`),

  exportMyData: async (): Promise<{ blob: Blob; filename: string }> => {
    const r = await fetch("/auth/me/export", { method: "GET", credentials: "include" });
    if (!r.ok) throw new ApiError(r.status, r.statusText);
    const cd = r.headers.get("content-disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    return { blob: await r.blob(), filename: m ? m[1] : "sidc-daten.zip" };
  },
  deleteMyAccount: () => req<{ ok: boolean }>("DELETE", "/auth/me"),

  legal: (page: "imprint" | "privacy") => req<{ content: string | null }>("GET", `/api/legal/${page}`),
  uploadLegal: async (page: "imprint" | "privacy", file: File) => {
    const r = await fetch(`/api/admin/legal/${page}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: await file.text(),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      let detail = body;
      try {
        detail = JSON.parse(body).detail ?? body;
      } catch {
        /* nicht-JSON */
      }
      throw new ApiError(r.status, detail || `HTTP ${r.status}`);
    }
    return r.json();
  },
  deleteLegal: (page: "imprint" | "privacy") => req<void>("DELETE", `/api/admin/legal/${page}`),

  favorites: () => req<Favorite[]>("GET", "/api/favorites"),
  addFavorite: (f: Omit<Favorite, "id">) => req<Favorite>("POST", "/api/favorites", f),
  deleteFavorite: (id: string) => req<void>("DELETE", `/api/favorites/${id}`),

  adminUsers: () => req<AdminUser[]>("GET", "/api/admin/users"),
  createUser: (b: { username: string; password: string; role: string; can_create_plans: boolean; is_mission_builder?: boolean; is_zeus?: boolean; display_name?: string }) =>
    req<AdminUser>("POST", "/api/admin/users", b),
  patchUser: (id: string, b: Partial<{ role: string; can_create_plans: boolean; is_mission_builder: boolean; is_zeus: boolean; is_active: boolean; password: string; display_name: string }>) =>
    req<AdminUser>("PATCH", `/api/admin/users/${id}`, b),
  deleteUser: (id: string) => req<void>("DELETE", `/api/admin/users/${id}`),
  adminGroups: () => req<AdminGroup[]>("GET", "/api/admin/groups"),
  createGroup: (b: { name: string; can_create_plans: boolean; is_mission_builder?: boolean; is_zeus?: boolean }) => req<AdminGroup>("POST", "/api/admin/groups", b),
  patchGroup: (id: string, b: { name: string; can_create_plans: boolean; is_mission_builder: boolean; is_zeus?: boolean }) =>
    req<AdminGroup>("PATCH", `/api/admin/groups/${id}`, b),

  orbats: () => req<Orbat[]>("GET", "/api/orbats"),
  createOrbat: (b: { name: string; affiliation: string; notes?: string }) =>
    req<Orbat>("POST", "/api/orbats", b),
  orbat: (id: string) => req<Orbat>("GET", `/api/orbats/${id}`),
  patchOrbat: (id: string, b: Partial<{ name: string; affiliation: string; notes: string }>) =>
    req<Orbat>("PATCH", `/api/orbats/${id}`, b),
  deleteOrbat: (id: string) => req<void>("DELETE", `/api/orbats/${id}`),
  createNode: (oid: string, b: Partial<OrbatNode> & { parent_id?: string | null }) =>
    req<OrbatNode>("POST", `/api/orbats/${oid}/nodes`, b),
  patchNode: (oid: string, nid: string, b: Partial<OrbatNode>) =>
    req<OrbatNode>("PATCH", `/api/orbats/${oid}/nodes/${nid}`, b),
  deleteNode: (oid: string, nid: string) => req<void>("DELETE", `/api/orbats/${oid}/nodes/${nid}`),
  cloneNode: (oid: string, nid: string) => req<OrbatNode>("POST", `/api/orbats/${oid}/nodes/${nid}/clone`),
  orbatAcl: (id: string) =>
    req<{ entries: any[]; candidates: AclCandidate[] }>("GET", `/api/orbats/${id}/acl`),
  putOrbatAcl: (id: string, entries: any[]) => req<any>("PUT", `/api/orbats/${id}/acl`, entries),
  planOrbats: (planId: string) => req<Orbat[]>("GET", `/plans/${planId}/orbats`),
  addPlanOrbat: (planId: string, orbat_id: string) =>
    req<void>("POST", `/plans/${planId}/orbats`, { orbat_id }),
  removePlanOrbat: (planId: string, orbatId: string) =>
    req<void>("DELETE", `/plans/${planId}/orbats/${orbatId}`),
  setGroupMembers: (id: string, userIds: string[]) => req<AdminGroup>("PUT", `/api/admin/groups/${id}/members`, userIds),
  deleteGroup: (id: string) => req<void>("DELETE", `/api/admin/groups/${id}`),
  adminAudit: (q: { limit?: number; offset?: number; action?: string; user?: string }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return req<{ items: AuditRow[]; offset: number; limit: number }>("GET", `/api/admin/audit?${p}`);
  },

  plans: () => req<PlanItem[]>("GET", "/plans"),
  plansInProjects: () => req<ProjectPlanItem[]>("GET", "/plans/in-projects"),
  createPlan: (name: string, map_id: string, folder_id: string | null = null) =>
    req<PlanItem>("POST", "/plans", { name, map_id, folder_id }),
  snapshot: (planId: string) => req<any>("GET", `/plans/${planId}/snapshot`),
  renamePlan: (planId: string, name: string) => req<PlanItem>("PATCH", `/plans/${planId}`, { name }),
  deletePlan: (planId: string) => req<void>("DELETE", `/plans/${planId}`),
  uploadThumbnail: async (planId: string, png: Blob) => {
    const res = await fetch(`/plans/${planId}/thumbnail`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "image/png" },
      body: png,
    });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return res;
  },
  uploadPlanImage: async (
    planId: string,
    file: File,
    o: { phase_id?: string | null; caption?: string; w?: number; h?: number } = {},
  ): Promise<PlanImage> => {
    const q = new URLSearchParams();
    if (o.phase_id) q.set("phase_id", o.phase_id);
    if (o.caption) q.set("caption", o.caption);
    if (o.w) q.set("w", String(o.w));
    if (o.h) q.set("h", String(o.h));
    const r = await fetch(`/plans/${planId}/images?${q}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": file.type, "x-filename": encodeURIComponent(file.name) },
      body: file,
    });
    if (!r.ok) throw new ApiError(r.status, (await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  planImages: (planId: string) => req<PlanImage[]>("GET", `/plans/${planId}/images`),
  planImageUrl: (planId: string, id: string) => `/plans/${planId}/images/${id}/raw`,
  publicImageUrl: (token: string, id: string) => `/public/plans/${token}/images/${id}/raw`,
  trash: () => req<PlanItem[]>("GET", "/plans/trash"),
  undeletePlan: (planId: string) => req<PlanItem>("POST", `/plans/${planId}/undelete`),
  purgePlan: (planId: string) => req<void>("DELETE", `/plans/${planId}/purge`),
  planLayers: (planId: string) => req<PlanLayer[]>("GET", `/plans/${planId}/layers`),
  createLayer: (planId: string, name: string) => req<PlanLayer>("POST", `/plans/${planId}/layers`, { name }),
  deleteLayer: (planId: string, layerId: string) => req<void>("DELETE", `/plans/${planId}/layers/${layerId}`),
  planPhases: (planId: string) => req<Phase[]>("GET", `/plans/${planId}/phases`),
  createPhase: (planId: string, name: string, opts: { plane?: string; parent_id?: string } = {}) =>
    req<Phase>("POST", `/plans/${planId}/phases`, { name, ...opts }),
  renamePhase: (planId: string, phaseId: string, name: string) =>
    req<Phase>("PATCH", `/plans/${planId}/phases/${phaseId}`, { name }),
  updatePhaseNotes: (planId: string, phaseId: string, notes: string) =>
    req<Phase>("PATCH", `/plans/${planId}/phases/${phaseId}`, { notes }),
  patchPhase: (
    planId: string,
    phaseId: string,
    body: { start_at?: string | null; end_at?: string | null; name?: string; zeus_released?: boolean; zeus_hours?: number | null; player_released?: boolean },
  ) => req<Phase>("PATCH", `/plans/${planId}/phases/${phaseId}`, body),
  patchPlan: (planId: string, body: { name?: string; h_hour?: string | null }) =>
    req<PlanItem>("PATCH", `/plans/${planId}`, body),
  deletePhase: (planId: string, phaseId: string) =>
    req<void>("DELETE", `/plans/${planId}/phases/${phaseId}`),
  planAcl: (planId: string) => req<AclEntry[]>("GET", `/plans/${planId}/acl`),
  planAclCandidates: (planId: string) => req<AclCandidate[]>("GET", `/plans/${planId}/acl/candidates`),
  putPlanAcl: (planId: string, entries: Omit<AclEntry, "id">[]) =>
    req<AclEntry[]>("PUT", `/plans/${planId}/acl`, entries),
  planShares: (planId: string) => req<PublicShareRow[]>("GET", `/plans/${planId}/shares`),
  createShare: (planId: string, opts: ShareOpts) =>
    req<PublicShareRow>("POST", `/plans/${planId}/shares`, opts),
  patchShare: (planId: string, token: string, opts: ShareOpts) =>
    req<PublicShareRow>("PATCH", `/plans/${planId}/shares/${token}`, opts),
  revokeShare: (planId: string, token: string) =>
    req<void>("DELETE", `/plans/${planId}/shares/${token}`),
  publicSnapshot: (token: string) => req<any>("GET", `/public/plans/${token}`),
  clonePlan: (planId: string, name: string, copy_acl: boolean, folder_id: string | null = null) =>
    req<PlanItem>("POST", `/plans/${planId}/clone`, { name, copy_acl, folder_id }),
  movePlan: (planId: string, folder_id: string | null) =>
    req<PlanItem>("POST", `/plans/${planId}/move`, { folder_id }),
  saveVersion: (planId: string, label: string) =>
    req<{ id: string }>("POST", `/plans/${planId}/versions`, { label }),
  planVersions: (planId: string) => req<PlanVersionRow[]>("GET", `/plans/${planId}/versions`),
  restoreVersion: (planId: string, versionId: string) =>
    req<void>("POST", `/plans/${planId}/restore/${versionId}`),

  folders: () => req<PlanFolder[]>("GET", "/folders"),
  createFolder: (name: string, parent_id: string | null = null) =>
    req<PlanFolder>("POST", "/folders", { name, parent_id }),
  renameFolder: (id: string, name: string) => req<PlanFolder>("PATCH", `/folders/${id}`, { name }),
  moveFolder: (id: string, parent_id: string | null) =>
    req<PlanFolder>("PATCH", `/folders/${id}`, parent_id === null ? { move_to_root: true } : { parent_id }),
  deleteFolder: (id: string) => req<void>("DELETE", `/folders/${id}`),

  // ─── Missionsbau-Projekte ───
  projects: () => req<ProjectItem[]>("GET", "/projects"),
  createProject: (name: string, description = "", folder_id: string | null = null) =>
    req<ProjectDetail>("POST", "/projects", { name, description, folder_id }),
  projectFolderList: () => req<ProjectFolder[]>("GET", "/project-folders"),
  createProjectFolder: (name: string, parent_id: string | null = null) =>
    req<ProjectFolder>("POST", "/project-folders", { name, parent_id }),
  renameProjectFolder: (id: string, name: string) => req<ProjectFolder>("PATCH", `/project-folders/${id}`, { name }),
  moveProjectFolder: (id: string, parent_id: string | null) =>
    req<ProjectFolder>("PATCH", `/project-folders/${id}`, parent_id === null ? { move_to_root: true } : { parent_id }),
  deleteProjectFolder: (id: string) => req<void>("DELETE", `/project-folders/${id}`),
  moveProject: (id: string, folder_id: string | null) => req<ProjectDetail>("PATCH", `/projects/${id}`, { folder_id }),
  project: (id: string) => req<ProjectDetail>("GET", `/projects/${id}`),
  patchProject: (id: string, b: Partial<{ name: string; description: string; archived: boolean; folder_id: string | null }>) =>
    req<ProjectDetail>("PATCH", `/projects/${id}`, b),
  deleteProject: (id: string) => req<void>("DELETE", `/projects/${id}`),
  projectMembers: (id: string) => req<ProjectMember[]>("GET", `/projects/${id}/members`),
  putProjectMembers: (id: string, m: ProjectMember[]) =>
    req<ProjectMember[]>(
      "PUT",
      `/projects/${id}/members`,
      m.map(({ subject_type, subject_id, role }) => ({ subject_type, subject_id, role })),
    ),
  /** Nutzer mit Projektzugriff (direkt oder über Gruppe) – Auswahl für Aufgaben-Zuständige. */
  projectAssignees: (id: string) => req<{ user_id: string; label: string }[]>("GET", `/projects/${id}/assignees`),
  projectCandidates: (id: string) => req<ProjectCandidate[]>("GET", `/projects/${id}/members/candidates`),
  projectActivity: (id: string, q: { task_id?: string; limit?: number; before?: string } = {}) => {
    const qs = new URLSearchParams();
    if (q.task_id) qs.set("task_id", q.task_id);
    if (q.limit) qs.set("limit", String(q.limit));
    if (q.before) qs.set("before", q.before);
    const s = qs.toString();
    return req<ActivityEntry[]>("GET", `/projects/${id}/activity${s ? "?" + s : ""}`);
  },
  chatConversations: () => req<ChatConversation[]>("GET", "/chat/conversations"),
  chatUnread: () => req<{ chats: number; notifications: number; total: number }>("GET", "/chat/unread"),
  chatUsers: () => req<ChatPeople>("GET", "/chat/users"),
  createChat: (b: { kind: "dm" | "group"; user_id?: string; name?: string; member_ids?: string[]; source_type?: "group" | "project"; source_id?: string }) =>
    req<ChatConversation>("POST", "/chat/conversations", b),
  chatRename: (id: string, name: string) => req<ChatConversation>("PATCH", `/chat/conversations/${id}`, { name }),
  chatMembers: (id: string) => req<{ user_id: string; label: string; is_owner: boolean }[]>("GET", `/chat/conversations/${id}/members`),
  chatPutMembers: (id: string, b: { add?: string[]; remove?: string[] }) => req<unknown>("PUT", `/chat/conversations/${id}/members`, b),
  chatLeave: (id: string) => req<void>("POST", `/chat/conversations/${id}/leave`),
  chatRead: (id: string) => req<void>("POST", `/chat/conversations/${id}/read`),
  chatMentionables: (id: string) => req<Mentionable[]>("GET", `/chat/conversations/${id}/mentionables`),
  chatMessages: (id: string) => req<ChatMessage[]>("GET", `/chat/conversations/${id}/messages`),
  postChatMessage: (id: string, text: string) => req<ChatMessage>("POST", `/chat/conversations/${id}/messages`, { text }),
  patchChatMessage: (id: string, mid: string, text: string) =>
    req<ChatMessage>("PATCH", `/chat/conversations/${id}/messages/${mid}`, { text }),
  deleteChatMessage: (id: string, mid: string) => req<void>("DELETE", `/chat/conversations/${id}/messages/${mid}`),
  chatNotifications: () => req<ChatNotification[]>("GET", "/chat/notifications"),
  chatReadNotifications: (b: { ids?: string[]; all?: boolean }) => req<void>("POST", "/chat/notifications/read", b),
  replyNotification: (id: string, text: string) => req<unknown>("POST", `/chat/notifications/${id}/reply`, { text }),
  notifyTypes: () => req<{ types: NotifyType[]; kinds: NotifyKind[] }>("GET", "/notify/types"),
  notifyChannels: () => req<NotifyChannel[]>("GET", "/notify/channels"),
  createNotifyChannel: (b: { type: string; name?: string; config: Record<string, string>; kinds: NotifyKind[] }) =>
    req<NotifyChannel>("POST", "/notify/channels", b),
  patchNotifyChannel: (id: string, b: { name?: string; config?: Record<string, string>; kinds?: NotifyKind[]; enabled?: boolean }) =>
    req<NotifyChannel>("PATCH", `/notify/channels/${id}`, b),
  deleteNotifyChannel: (id: string) => req<void>("DELETE", `/notify/channels/${id}`),
  testNotifyChannel: (id: string) => req<void>("POST", `/notify/channels/${id}/test`),
  bridgeMe: () => req<{ enabled: boolean; identities: { provider: string; external_id: string }[] }>("GET", "/bridge/me"),
  bridgeCode: (b: { kind: "user" | "conv"; conversation_id?: string }) =>
    req<{ code: string; expires_in: number }>("POST", "/bridge/code", b),
  bridgeUnlinkIdentity: (provider: string) => req<void>("DELETE", `/bridge/identities/${provider}`),
  bridgeLinks: (cid: string) =>
    req<{ id: string; provider: string; external_id: string }[]>("GET", `/bridge/conversations/${cid}/links`),
  bridgeDeleteLink: (id: string) => req<void>("DELETE", `/bridge/links/${id}`),
  webpushKey: () => req<{ key: string }>("GET", "/notify/webpush/key"),
  webpushSubscribe: (b: { endpoint: string; keys: { p256dh: string; auth: string }; name?: string }) =>
    req<NotifyChannel>("POST", "/notify/webpush", b),
  chatClearNotifications: () => req<void>("DELETE", "/chat/notifications"),
  projectMentionables: (id: string) => req<Mentionable[]>("GET", `/projects/${id}/mentionables`),
  taskComments: (id: string, tid: string) => req<TaskComment[]>("GET", `/projects/${id}/tasks/${tid}/comments`),
  createTaskComment: (id: string, tid: string, text: string) =>
    req<TaskComment>("POST", `/projects/${id}/tasks/${tid}/comments`, { text }),
  patchTaskComment: (id: string, tid: string, cid: string, text: string) =>
    req<TaskComment>("PATCH", `/projects/${id}/tasks/${tid}/comments/${cid}`, { text }),
  deleteTaskComment: (id: string, tid: string, cid: string) =>
    req<void>("DELETE", `/projects/${id}/tasks/${tid}/comments/${cid}`),
  projectActivitySummary: (id: string, days = 7) =>
    req<ActivitySummaryRow[]>("GET", `/projects/${id}/activity/summary?days=${days}`),
  projectOverview: (id: string) => req<ProjectOverview>("GET", `/projects/${id}/overview`),
  projectDocs: (id: string, space: ProjectSpace) => req<ProjectDocNode[]>("GET", `/projects/${id}/docs?space=${space}`),
  createProjectDoc: (
    id: string,
    b: { space: ProjectSpace; parent_id?: string | null; kind: "folder" | "doc"; name: string; content?: string },
  ) => req<ProjectDoc>("POST", `/projects/${id}/docs`, b),
  projectDoc: (id: string, docId: string) => req<ProjectDoc>("GET", `/projects/${id}/docs/${docId}`),
  patchProjectDoc: (
    id: string,
    docId: string,
    b: { name?: string; content?: string; parent_id?: string | null; expected_updated_at?: string },
  ) => req<ProjectDoc>("PATCH", `/projects/${id}/docs/${docId}`, b),
  deleteProjectDoc: (id: string, docId: string) => req<void>("DELETE", `/projects/${id}/docs/${docId}`),
  projectImages: (id: string, space: ProjectSpace) => req<ProjectImage[]>("GET", `/projects/${id}/images?space=${space}`),
  patchProjectImage: (id: string, imageId: string, b: { caption?: string; note?: string }) =>
    req<ProjectImage>("PATCH", `/projects/${id}/images/${imageId}`, b),
  deleteProjectImage: (id: string, imageId: string) => req<void>("DELETE", `/projects/${id}/images/${imageId}`),
  projectNotes: (id: string) => req<ProjectNote[]>("GET", `/projects/${id}/notes`),
  createProjectNote: (id: string, b: Partial<ProjectNote>) => req<ProjectNote>("POST", `/projects/${id}/notes`, b),
  patchProjectNote: (id: string, nid: string, b: Partial<ProjectNote>) =>
    req<ProjectNote>("PATCH", `/projects/${id}/notes/${nid}`, b),
  deleteProjectNote: (id: string, nid: string) => req<void>("DELETE", `/projects/${id}/notes/${nid}`),
  noteLinks: (id: string) => req<NoteLink[]>("GET", `/projects/${id}/note-links`),
  createNoteLink: (id: string, from_id: string, to_id: string) =>
    req<NoteLink>("POST", `/projects/${id}/note-links`, { from_id, to_id }),
  deleteNoteLink: (id: string, lid: string) => req<void>("DELETE", `/projects/${id}/note-links/${lid}`),
  projectTasks: (id: string, q: { assignee?: string; status?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const qs = p.toString();
    return req<ProjectTask[]>("GET", `/projects/${id}/tasks${qs ? "?" + qs : ""}`);
  },
  createProjectTask: (id: string, b: Partial<ProjectTask>) => req<ProjectTask>("POST", `/projects/${id}/tasks`, b),
  patchProjectTask: (id: string, tid: string, b: Partial<ProjectTask>) =>
    req<ProjectTask>("PATCH", `/projects/${id}/tasks/${tid}`, b),
  deleteProjectTask: (id: string, tid: string) => req<void>("DELETE", `/projects/${id}/tasks/${tid}`),
  moveProjectTask: (id: string, tid: string, status: TaskStatus, ordering: number) =>
    req<ProjectTask>("POST", `/projects/${id}/tasks/${tid}/move`, { status, ordering }),
  projectPlans: (id: string) => req<PlanItem[]>("GET", `/projects/${id}/plans`),
  projectFolders: (id: string) => req<PlanFolder[]>("GET", `/folders?project_id=${id}`),
  setPlanProject: (planId: string, project_id: string | null) =>
    req<PlanItem>("POST", `/plans/${planId}/project`, { project_id }),
  createPlanIn: (name: string, map_id: string, folder_id: string | null, project_id: string) =>
    req<PlanItem>("POST", "/plans", { name, map_id, folder_id, project_id }),
  createFolderIn: (name: string, parent_id: string | null, project_id: string) =>
    req<PlanFolder>("POST", "/folders", { name, parent_id, project_id }),
  adminProjectStorage: () => req<ProjectStorageRow[]>("GET", "/api/admin/projects/storage"),
};
