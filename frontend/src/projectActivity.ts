// Aktivitätsfeed: Tab „Aktivität“ (Projekt-Feed + wer war wie aktiv) und Verlauf einer einzelnen Aufgabe.
import { type ActivityEntry, api } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { type ProjCtx, fmtDate, relTime, startPolling } from "./projectUtil";

const ICON: Record<string, string> = { task: "check", doc: "notes", note: "textbox", project: "users" };

/** Satz zu einem Eintrag, z. B. „Anna → Aufgabe «Briefing»: Status Offen → In Arbeit“. */
function what(e: ActivityEntry): string {
  const d = e.detail as Record<string, string | number | boolean | null | undefined>;
  const title = `<strong>${esc(e.target_title)}</strong>`;
  const st = (s: unknown) => esc(t("proj.col." + String(s)));
  switch (e.kind) {
    case "task.create": return t("act.task.create").replace("{t}", title);
    case "task.delete": return t("act.task.delete").replace("{t}", title);
    case "task.status": return t("act.task.status").replace("{t}", title).replace("{a}", st(d.old)).replace("{b}", st(d.new));
    case "task.assignee":
      return t("act.task.assignee").replace("{t}", title)
        .replace("{a}", esc(String(d.old || t("proj.unassigned")))).replace("{b}", esc(String(d.new || t("proj.unassigned"))));
    case "task.priority":
      return t("act.task.priority").replace("{t}", title)
        .replace("{a}", esc(t("proj.prio." + String(d.old)))).replace("{b}", esc(t("proj.prio." + String(d.new))));
    case "task.due":
      return t("act.task.due").replace("{t}", title)
        .replace("{b}", esc(d.new ? fmtDate(String(d.new)) : t("act.none")));
    case "task.rename": return t("act.task.rename").replace("{t}", title).replace("{a}", esc(String(d.old ?? "")));
    case "task.description": return t("act.task.description").replace("{t}", title);
    case "task.comment": return t("act.task.comment").replace("{t}", title);
    case "task.link": return t("act.task.link").replace("{t}", title);
    case "doc.create": return t(d.folder ? "act.folder.create" : "act.doc.create").replace("{t}", title);
    case "doc.update": return t("act.doc.update").replace("{t}", title);
    case "doc.rename": return t("act.doc.rename").replace("{t}", title).replace("{a}", esc(String(d.old ?? "")));
    case "doc.delete": return t("act.doc.delete").replace("{t}", title);
    case "note.create": return t("act.note.create").replace("{t}", title);
    case "note.update": return t("act.note.update").replace("{t}", title);
    case "note.delete": return t("act.note.delete").replace("{t}", title);
    case "project.members": return t("act.project.members");
    default: return esc(e.kind) + " " + title;
  }
}

function itemHtml(e: ActivityEntry): string {
  const who = esc(e.user_label || t("act.unknown"));
  const ic = icon(ICON[e.target_type] ?? "audit", 14);
  const body = what(e);
  return `<li class="act-i" title="${esc(new Date(e.created_at).toLocaleString())}">
    <span class="act-ic">${ic}</span>
    <span class="act-tx"><strong class="act-who">${who}</strong> ${body}</span>
    <span class="act-t muted">${esc(relTime(e.created_at))}</span></li>`;
}

/** Verlauf einer Aufgabe (für den Aufgaben-Dialog). */
export async function mountTaskHistory(host: HTMLElement, projectId: string, taskId: string): Promise<void> {
  host.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
  try {
    const rows = await api.projectActivity(projectId, { task_id: taskId, limit: 100 });
    host.innerHTML = rows.length
      ? `<ul class="act-list">${rows.map((e) => itemHtml(e)).join("")}</ul>`
      : `<p class="muted">${t("act.empty")}</p>`;
  } catch (e) {
    host.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

/** Tab „Aktivität“: Personen-Übersicht + Gesamtfeed des Projekts. */
export function mountActivity(host: HTMLElement, ctx: ProjCtx): void {
  let days = 7;
  let feed: ActivityEntry[] = [];
  let more = true;
  const PAGE = 50;

  host.innerHTML = `<div class="ov-grid act-grid">
      <section class="ov-card"><div class="row"><h3 style="flex:1;margin:0">${t("act.who")}</h3>
        <select id="act-days" aria-label="${t("act.period")}">
          <option value="1">${t("act.d1")}</option><option value="7" selected>${t("act.d7")}</option>
          <option value="30">${t("act.d30")}</option><option value="365">${t("act.d365")}</option></select></div>
        <div id="act-sum"></div></section>
      <section class="ov-card"><h3>${t("act.feed")}</h3><div id="act-feed"></div>
        <button id="act-more" hidden>${t("act.more")}</button></section></div>`;
  const sumEl = host.querySelector<HTMLElement>("#act-sum")!;
  const feedEl = host.querySelector<HTMLElement>("#act-feed")!;
  const moreBtn = host.querySelector<HTMLButtonElement>("#act-more")!;

  const paintFeed = () => {
    feedEl.innerHTML = feed.length ? `<ul class="act-list">${feed.map((e) => itemHtml(e)).join("")}</ul>` : `<p class="muted">${t("act.empty")}</p>`;
    moreBtn.hidden = !more;
  };
  const loadSummary = async () => {
    const rows = await api.projectActivitySummary(ctx.id, days);
    const max = Math.max(1, ...rows.map((r) => r.count));
    sumEl.innerHTML = rows.length
      ? `<ul class="ov-people">${rows
          .map(
            (r) => `<li><span class="ov-who">${esc(r.label || t("act.unknown"))}</span>
              <span class="ov-bar" title="${esc(t("act.last"))}: ${esc(relTime(r.last))}"><i class="b-doing" style="width:${(r.count / max) * 100}%"></i></span>
              <span class="ov-n">${r.count}</span></li>`,
          )
          .join("")}</ul><p class="muted" style="font-size:.75rem;margin:.5rem 0 0">${t("act.sumHint")}</p>`
      : `<p class="muted">${t("act.empty")}</p>`;
  };
  const loadFeed = async () => {
    // Neu laden: bisher geladene Länge behalten, damit „Mehr laden“ beim Polling nicht verloren geht
    const lim = Math.min(200, Math.max(PAGE, feed.length));
    const rows = await api.projectActivity(ctx.id, { limit: lim });
    feed = rows;
    more = rows.length >= lim;
    paintFeed();
  };
  const reload = async () => {
    await Promise.all([loadSummary(), loadFeed()]);
  };

  host.querySelector<HTMLSelectElement>("#act-days")!.addEventListener("change", (ev) => {
    days = Number((ev.target as HTMLSelectElement).value);
    void loadSummary();
  });
  moreBtn.addEventListener("click", async () => {
    const last = feed[feed.length - 1];
    if (!last) return;
    const rows = await api.projectActivity(ctx.id, { limit: PAGE, before: last.created_at });
    feed = feed.concat(rows);
    more = rows.length === PAGE;
    paintFeed();
  });

  reload().catch((e) => {
    host.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
  startPolling(host, reload);
}
