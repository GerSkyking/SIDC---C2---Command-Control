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
  role: string;
  can_create_plans_effective: boolean;
  is_mission_builder_effective: boolean;
  ui_settings?: Record<string, unknown>;
}
export interface MapItem {
  id: string;
  name: string;
  status: string;
  error: string | null;
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
}
export interface PlanFolder {
  id: string;
  name: string;
  parent_id: string | null;
  ordering: number;
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
  role: string;
  can_create_plans: boolean;
  is_mission_builder: boolean;
  is_active: boolean;
  is_local: boolean;
}
export interface AdminGroup {
  id: string;
  name: string;
  can_create_plans: boolean;
  is_mission_builder: boolean;
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

export const api = {
  me: () => req<Me>("GET", "/auth/me"),
  saveSettings: (patch: Record<string, unknown>) => req<Me>("PATCH", "/auth/me/settings", patch),
  login: (username: string, password: string) =>
    req<Me>("POST", "/auth/login", { username, password }),
  logout: () => req<void>("POST", "/auth/logout"),
  oidcEnabled: () => req<{ enabled: boolean }>("GET", "/auth/oidc/enabled"),

  maps: () => req<MapItem[]>("GET", "/api/maps"),
  importMap: (id: string, name: string, url: string) =>
    req<MapItem>("POST", "/api/maps", { id, name, url }),
  reimportMap: (id: string) => req<MapItem>("POST", `/api/maps/${id}/reimport`),
  uploadMapFile: (id: string, name: string, file: File, onProgress?: (pct: number) => void) =>
    new Promise<MapItem>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/maps/${id}/upload?name=${encodeURIComponent(name)}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", "application/zip");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.((e.loaded / e.total) * 100);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else {
          let d = xhr.statusText;
          try {
            d = JSON.parse(xhr.responseText).detail ?? d;
          } catch {
            /* nicht-JSON */
          }
          reject(new ApiError(xhr.status, d || `HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "Netzwerkfehler beim Upload"));
      xhr.send(file);
    }),
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
        detail =
          "Datei zu groß für den Reverse Proxy. Im Nginx Proxy Manager beim Proxy Host " +
          "unter 'Advanced' eintragen: client_max_body_size 25m;";
      }
      throw new ApiError(r.status, detail || `HTTP ${r.status}`);
    }
    return r.json();
  },
  deleteCatalog: (name: string) => req<void>("DELETE", `/api/admin/catalog/${name}`),

  favorites: () => req<Favorite[]>("GET", "/api/favorites"),
  addFavorite: (f: Omit<Favorite, "id">) => req<Favorite>("POST", "/api/favorites", f),
  deleteFavorite: (id: string) => req<void>("DELETE", `/api/favorites/${id}`),

  adminUsers: () => req<AdminUser[]>("GET", "/api/admin/users"),
  createUser: (b: { username: string; password: string; role: string; can_create_plans: boolean; is_mission_builder?: boolean }) =>
    req<AdminUser>("POST", "/api/admin/users", b),
  patchUser: (id: string, b: Partial<{ role: string; can_create_plans: boolean; is_mission_builder: boolean; is_active: boolean; password: string }>) =>
    req<AdminUser>("PATCH", `/api/admin/users/${id}`, b),
  deleteUser: (id: string) => req<void>("DELETE", `/api/admin/users/${id}`),
  adminGroups: () => req<AdminGroup[]>("GET", "/api/admin/groups"),
  createGroup: (b: { name: string; can_create_plans: boolean; is_mission_builder?: boolean }) => req<AdminGroup>("POST", "/api/admin/groups", b),
  patchGroup: (id: string, b: { name: string; can_create_plans: boolean; is_mission_builder: boolean }) =>
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
  createPlan: (name: string, map_id: string, folder_id: string | null = null) =>
    req<PlanItem>("POST", "/plans", { name, map_id, folder_id }),
  snapshot: (planId: string) => req<any>("GET", `/plans/${planId}/snapshot`),
  renamePlan: (planId: string, name: string) => req<PlanItem>("PATCH", `/plans/${planId}`, { name }),
  deletePlan: (planId: string) => req<void>("DELETE", `/plans/${planId}`),
  uploadThumbnail: (planId: string, png: Blob) =>
    fetch(`/plans/${planId}/thumbnail`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "image/png" },
      body: png,
    }),
  trash: () => req<PlanItem[]>("GET", "/plans/trash"),
  undeletePlan: (planId: string) => req<PlanItem>("POST", `/plans/${planId}/undelete`),
  purgePlan: (planId: string) => req<void>("DELETE", `/plans/${planId}/purge`),
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
    body: { start_at?: string | null; end_at?: string | null; name?: string },
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
};
