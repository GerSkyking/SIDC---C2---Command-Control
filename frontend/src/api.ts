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
export interface PlanItem {
  id: string;
  name: string;
  map_id: string;
  level: "viewer" | "editor" | "owner";
}
export interface Favorite {
  id: string;
  label: string;
  sidc: string;
  rotation_degrees: number;
  unit_text: string;
  ai_text: string;
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
  deleteMap: (id: string) => req<void>("DELETE", `/api/maps/${id}`),
  restartBackend: () => req<{ message: string }>("POST", "/api/admin/restart"),

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

  plans: () => req<PlanItem[]>("GET", "/plans"),
  createPlan: (name: string, map_id: string) =>
    req<PlanItem>("POST", "/plans", { name, map_id }),
  snapshot: (planId: string) => req<any>("GET", `/plans/${planId}/snapshot`),
  deletePlan: (planId: string) => req<void>("DELETE", `/plans/${planId}`),
  clonePlan: (planId: string, name: string, copy_acl: boolean) =>
    req<PlanItem>("POST", `/plans/${planId}/clone`, { name, copy_acl }),
  saveVersion: (planId: string, label: string) =>
    req<{ id: string }>("POST", `/plans/${planId}/versions`, { label }),
};
