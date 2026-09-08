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
  is_multipoint: boolean;
  max_line_points: number;
}
export interface Phase {
  id: string;
  name: string;
  ordering: number;
  notes: string;
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
  is_active: boolean;
  is_local: boolean;
}
export interface AdminGroup {
  id: string;
  name: string;
  can_create_plans: boolean;
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
export interface PublicShareRow {
  token: string;
  label: string;
  revoked: boolean;
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
  mapSourceFiles: (id: string) =>
    req<{ name: string; size: number; download_url: string }[]>("GET", `/api/map-sources/${id}/files`),
  importFromSource: (id: string, name: string, source_id: string, file: string) =>
    req<MapItem>("POST", "/api/maps/import-from-source", { id, name, source_id, file }),

  catalogStatus: () => req<Record<string, boolean>>("GET", "/api/catalog"),
  uploadCatalog: async (name: string, file: File) => {
    const text = await file.text();
    const r = await fetch(`/api/admin/catalog/${name}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: text,
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
  createUser: (b: { username: string; password: string; role: string; can_create_plans: boolean }) =>
    req<AdminUser>("POST", "/api/admin/users", b),
  patchUser: (id: string, b: Partial<{ role: string; can_create_plans: boolean; is_active: boolean; password: string }>) =>
    req<AdminUser>("PATCH", `/api/admin/users/${id}`, b),
  deleteUser: (id: string) => req<void>("DELETE", `/api/admin/users/${id}`),
  adminGroups: () => req<AdminGroup[]>("GET", "/api/admin/groups"),
  createGroup: (b: { name: string; can_create_plans: boolean }) => req<AdminGroup>("POST", "/api/admin/groups", b),
  setGroupMembers: (id: string, userIds: string[]) => req<AdminGroup>("PUT", `/api/admin/groups/${id}/members`, userIds),
  deleteGroup: (id: string) => req<void>("DELETE", `/api/admin/groups/${id}`),
  adminAudit: (q: { limit?: number; offset?: number; action?: string; user?: string }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return req<{ items: AuditRow[]; offset: number; limit: number }>("GET", `/api/admin/audit?${p}`);
  },

  plans: () => req<PlanItem[]>("GET", "/plans"),
  createPlan: (name: string, map_id: string) =>
    req<PlanItem>("POST", "/plans", { name, map_id }),
  snapshot: (planId: string) => req<any>("GET", `/plans/${planId}/snapshot`),
  deletePlan: (planId: string) => req<void>("DELETE", `/plans/${planId}`),
  createPhase: (planId: string, name: string) =>
    req<Phase>("POST", `/plans/${planId}/phases`, { name }),
  renamePhase: (planId: string, phaseId: string, name: string) =>
    req<Phase>("PATCH", `/plans/${planId}/phases/${phaseId}`, { name }),
  updatePhaseNotes: (planId: string, phaseId: string, notes: string) =>
    req<Phase>("PATCH", `/plans/${planId}/phases/${phaseId}`, { notes }),
  deletePhase: (planId: string, phaseId: string) =>
    req<void>("DELETE", `/plans/${planId}/phases/${phaseId}`),
  planAcl: (planId: string) => req<AclEntry[]>("GET", `/plans/${planId}/acl`),
  planAclCandidates: (planId: string) => req<AclCandidate[]>("GET", `/plans/${planId}/acl/candidates`),
  putPlanAcl: (planId: string, entries: Omit<AclEntry, "id">[]) =>
    req<AclEntry[]>("PUT", `/plans/${planId}/acl`, entries),
  planShares: (planId: string) => req<PublicShareRow[]>("GET", `/plans/${planId}/shares`),
  createShare: (planId: string, label: string, expiresDays?: number) =>
    req<{ token: string }>("POST", `/plans/${planId}/shares`, { label, expires_days: expiresDays }),
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
