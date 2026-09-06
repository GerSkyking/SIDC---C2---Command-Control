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

export const api = {
  me: () => req<Me>("GET", "/auth/me"),
  login: (username: string, password: string) =>
    req<Me>("POST", "/auth/login", { username, password }),
  logout: () => req<void>("POST", "/auth/logout"),
  oidcEnabled: () => req<{ enabled: boolean }>("GET", "/auth/oidc/enabled"),

  maps: () => req<MapItem[]>("GET", "/api/maps"),
  importMap: (id: string, name: string, url: string) =>
    req<MapItem>("POST", "/api/maps", { id, name, url }),

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
