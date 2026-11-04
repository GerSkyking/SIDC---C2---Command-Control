// Phase 2 der Missionsbau-Werkzeuge (docs/MISSIONSBAU-WERKZEUGE.md): Feedback, Projektstatus, Meilensteine,
// Datei-Kommentare und Datei-Versionen. ALLE Backend-Aufrufe dafür liegen hier; weicht die Antwort in Details ab,
// genügt eine Anpassung in dieser Datei. Listen werden auch als `{items:[…]}` akzeptiert.
import { req, type TaskComment } from "./api";

const enc = encodeURIComponent;

/** Antwort als Liste lesen – auch wenn das Backend sie in `{items:[…]}` einpackt. */
function asList<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const items = (r as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

// ─── Karten-Notizen (Annotationen aller Pläne des Projekts; nur Missionsbau, sonst 404) ───

export interface MapNote {
  id: string;
  plan_id: string;
  plan_name: string;
  text: string;
  title?: string | null;
  world_x: number;
  world_y: number;
  updated_at?: string | null;
  updated_by_label?: string | null;
  href: string;
}

export const projectMapNotes = async (pid: string): Promise<MapNote[]> =>
  asList<MapNote>(await req<unknown>("GET", `/projects/${enc(pid)}/map-notes`));

// ─── Feedback ─────────────────────────────────────────────────────────────

export const FEEDBACK_KINDS = ["bug", "idea", "praise", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_STATUSES = ["new", "doing", "done", "rejected"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const isFeedbackKind = (v: unknown): v is FeedbackKind => FEEDBACK_KINDS.includes(v as FeedbackKind);
export const isFeedbackStatus = (v: unknown): v is FeedbackStatus => FEEDBACK_STATUSES.includes(v as FeedbackStatus);

export interface FeedbackItem {
  id: string;
  title: string;
  text: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  source: "internal" | "external";
  /** Name des Absenders (extern: frei eingegeben, intern: Anzeigename) */
  author_name?: string | null;
  author_label?: string | null;
  author_user_id?: string | null;
  plan_id?: string | null;
  doc_id?: string | null;
  task_id?: string | null;
  created_at: string;
  updated_at?: string | null;
  handled_by?: string | null;
}

export interface FeedbackCreate {
  title: string;
  text: string;
  kind: FeedbackKind;
  plan_id?: string | null;
  doc_id?: string | null;
}

/** Token-Antwort in `string | null` übersetzen (`{token}`, `{feedback_token}` oder reiner Text). */
function tokenOf(r: unknown): string | null {
  if (typeof r === "string") return r || null;
  const o = r as { token?: unknown; feedback_token?: unknown } | null;
  const v = o?.token ?? o?.feedback_token;
  return typeof v === "string" && v ? v : null;
}

export const feedbackApi = {
  list: async (pid: string): Promise<FeedbackItem[]> => asList<FeedbackItem>(await req<unknown>("GET", `/projects/${pid}/feedback`)),
  /** Anzahl der Einträge mit Status „neu" */
  newCount: async (pid: string): Promise<number> => asList<FeedbackItem>(await req<unknown>("GET", `/projects/${pid}/feedback?status=new`)).filter((f) => f.status === "new").length,
  create: (pid: string, b: FeedbackCreate) => req<FeedbackItem>("POST", `/projects/${pid}/feedback`, b),
  setStatus: (pid: string, id: string, status: FeedbackStatus) => req<FeedbackItem>("PATCH", `/projects/${pid}/feedback/${enc(id)}`, { status }),
  remove: (pid: string, id: string) => req<void>("DELETE", `/projects/${pid}/feedback/${enc(id)}`),
  /** Aufgabe aus dem Feedback anlegen → ID der neuen Aufgabe */
  toTask: async (pid: string, id: string): Promise<string> => {
    const r = await req<{ task_id?: string; id?: string; task?: { id?: string } } | null>("POST", `/projects/${pid}/feedback/${enc(id)}/to-task`);
    return r?.task_id ?? r?.task?.id ?? r?.id ?? "";
  },
  // Owner: externe Schnittstelle
  getToken: async (pid: string): Promise<string | null> => tokenOf(await req<unknown>("GET", `/projects/${pid}/feedback-token`)),
  newToken: async (pid: string): Promise<string | null> => tokenOf(await req<unknown>("POST", `/projects/${pid}/feedback-token`)),
  disableToken: (pid: string) => req<void>("DELETE", `/projects/${pid}/feedback-token`),
};

/** Öffentliches Formular (ohne Login). */
export const publicFeedbackApi = {
  info: async (token: string): Promise<{ project: string; kinds: string[] }> => {
    const r = await req<{ project?: string; kinds?: unknown }>("GET", `/api/public/feedback/${enc(token)}`);
    const kinds = Array.isArray(r?.kinds) ? (r.kinds as unknown[]).filter(isFeedbackKind) : [];
    return { project: String(r?.project ?? ""), kinds: kinds.length ? kinds : [...FEEDBACK_KINDS] };
  },
  submit: (token: string, b: { title: string; text: string; kind: string; name: string; website: string }) =>
    req<unknown>("POST", `/api/public/feedback/${enc(token)}`, b),
};

/** Zähler „neu" am Tab „Feedback" setzen (0 = ausblenden). */
export function setFeedbackBadge(n: number): void {
  const b = document.querySelector<HTMLElement>(".proj-tab-badge");
  if (!b) return;
  b.hidden = n <= 0;
  b.textContent = n > 99 ? "99+" : String(n);
  b.title = String(n);
}

// ─── Projektstatus & Meilensteine ─────────────────────────────────────────

export const STAGES = ["draft", "review", "test", "release"] as const;
export type ProjectStage = (typeof STAGES)[number];
export const isStage = (v: unknown): v is ProjectStage => STAGES.includes(v as ProjectStage);

export interface Milestone {
  id: string;
  title: string;
  due_date: string | null;
  done: boolean;
  ordering?: number;
}

export const stageApi = {
  set: (pid: string, stage: ProjectStage) => req<unknown>("PATCH", `/projects/${pid}`, { stage }),
};

export const milestoneApi = {
  list: async (pid: string): Promise<Milestone[]> => asList<Milestone>(await req<unknown>("GET", `/projects/${pid}/milestones`)),
  create: (pid: string, b: { title: string; due_date: string | null }) => req<Milestone>("POST", `/projects/${pid}/milestones`, b),
  patch: (pid: string, id: string, b: Partial<Pick<Milestone, "title" | "due_date" | "done">>) =>
    req<Milestone>("PATCH", `/projects/${pid}/milestones/${enc(id)}`, b),
  remove: (pid: string, id: string) => req<void>("DELETE", `/projects/${pid}/milestones/${enc(id)}`),
};

// ─── Datei-Kommentare & -Versionen ────────────────────────────────────────

export const docCommentApi = {
  list: async (pid: string, did: string): Promise<TaskComment[]> => asList<TaskComment>(await req<unknown>("GET", `/projects/${pid}/docs/${did}/comments`)),
  create: (pid: string, did: string, text: string) => req<TaskComment>("POST", `/projects/${pid}/docs/${did}/comments`, { text }),
  patch: (pid: string, did: string, cid: string, text: string) => req<TaskComment>("PATCH", `/projects/${pid}/docs/${did}/comments/${cid}`, { text }),
  remove: (pid: string, did: string, cid: string) => req<void>("DELETE", `/projects/${pid}/docs/${did}/comments/${cid}`),
};

export interface DocVersion {
  id: string;
  name?: string;
  created_at: string;
  saved_by?: string | null;
  saved_by_label?: string | null;
  author?: string | null;
  byte_size?: number;
  /** nur im Einzelabruf */
  content?: string;
}

/** Anzeigename des Speichernden (IDs ohne Namen werden nicht gezeigt). */
export function versionAuthor(v: DocVersion): string {
  const c = v.saved_by_label || v.author || v.saved_by || "";
  return /^[0-9a-f]{32}$/i.test(c) ? "" : c;
}

export const docVersionApi = {
  list: async (pid: string, did: string): Promise<DocVersion[]> => asList<DocVersion>(await req<unknown>("GET", `/projects/${pid}/docs/${did}/versions`)),
  get: (pid: string, did: string, vid: string) => req<DocVersion>("GET", `/projects/${pid}/docs/${did}/versions/${vid}`),
  restore: (pid: string, did: string, vid: string) => req<unknown>("POST", `/projects/${pid}/docs/${did}/versions/${vid}/restore`),
};
