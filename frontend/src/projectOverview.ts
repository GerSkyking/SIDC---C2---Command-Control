// Projektübersicht: Zahlen, offene Aufgaben je Person, Fälliges, zuletzt Geändertes.
import { api, type ProjectOverview, type ProjectTask } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { type ProjCtx, fmtDate, relTime, startPolling } from "./projectUtil";

export function mountOverview(host: HTMLElement, ctx: ProjCtx): void {
  const taskLi = (x: ProjectTask, late: boolean): string =>
    `<li><a href="#/projects/${ctx.id}/tasks" title="${t("proj.overview.toTasks")}">
       <span class="ov-t">${esc(x.title)}</span>
       <span class="ov-m">${x.assignee_label ? esc(x.assignee_label) + " · " : ""}<span class="${late ? "due-late" : ""}">${esc(fmtDate(x.due_date))}</span></span></a></li>`;

  const paint = (o: ProjectOverview) => {
    const maxOpen = Math.max(1, ...o.open_by_assignee.map((a) => a.open + a.doing + a.review));
    const c = o.counts;
    const stat = (ic: string, n: number, label: string, href: string) =>
      `<a class="ov-stat" href="${href}" title="${esc(label)}">${icon(ic, 18)}<strong>${n}</strong><span>${esc(label)}</span></a>`;
    host.innerHTML = `
      <div class="ov-grid">
        <div class="ov-stats">
          ${stat("notes", c.docs, t("proj.overview.docs"), `#/projects/${ctx.id}/public`)}
          ${stat("image", c.images, t("proj.overview.images"), `#/projects/${ctx.id}/public`)}
          ${stat("map", c.plans, t("proj.overview.plans"), `#/projects/${ctx.id}/plans`)}
          ${stat("check", c.tasks_open, t("proj.overview.tasksOpen"), `#/projects/${ctx.id}/tasks`)}
        </div>
        <section class="ov-card">
          <h3>${t("proj.overview.byPerson")}</h3>
          ${
            o.open_by_assignee.length
              ? `<ul class="ov-people">${o.open_by_assignee
                  .map((a) => {
                    const tot = a.open + a.doing + a.review;
                    return `<li><span class="ov-who">${esc(a.label || t("proj.unassigned"))}</span>
                      <span class="ov-bar" title="${t("proj.col.open")}: ${a.open} · ${t("proj.col.doing")}: ${a.doing} · ${t("proj.col.review")}: ${a.review}">
                        <i class="b-open" style="width:${(a.open / maxOpen) * 100}%"></i><i class="b-doing" style="width:${(a.doing / maxOpen) * 100}%"></i><i class="b-review" style="width:${(a.review / maxOpen) * 100}%"></i></span>
                      <span class="ov-n">${tot}</span></li>`;
                  })
                  .join("")}</ul>
                 <div class="ov-legend"><span class="b-open">${t("proj.col.open")}</span><span class="b-doing">${t("proj.col.doing")}</span><span class="b-review">${t("proj.col.review")}</span></div>`
              : `<p class="muted">${t("proj.overview.noTasks")}</p>
                 <a href="#/projects/${ctx.id}/tasks">${t("proj.overview.createTask")}</a>`
          }
        </section>
        <section class="ov-card">
          <h3>${t("proj.overview.due")}</h3>
          ${
            o.overdue.length || o.due_soon.length
              ? `<ul class="ov-list">${o.overdue.map((x) => taskLi(x, true)).join("")}${o.due_soon.map((x) => taskLi(x, false)).join("")}</ul>`
              : `<p class="muted">${t("proj.overview.noDue")}</p>`
          }
        </section>
        <section class="ov-card">
          <h3>${t("proj.overview.recent")}</h3>
          ${
            o.recent_docs.length || o.recent_plans.length
              ? `<ul class="ov-list">${o.recent_docs
                  .map(
                    (d) =>
                      `<li><a href="#/projects/${ctx.id}/${d.space === "builder" ? "builder" : "public"}" data-doc="${esc(d.id)}" data-space="${d.space === "builder" ? "builder" : "public"}">
                        <span class="ov-t">${icon("notes", 13)} ${esc(d.name)}</span><span class="ov-m">${esc(d.updated_by ?? "")} ${esc(relTime(d.updated_at))}</span></a></li>`,
                  )
                  .join("")}${o.recent_plans
                  .map(
                    (p) =>
                      `<li><a href="#/plans/${esc(p.id)}"><span class="ov-t">${icon("map", 13)} ${esc(p.name)}</span><span class="ov-m">${esc(relTime(p.updated_at))}</span></a></li>`,
                  )
                  .join("")}</ul>`
              : `<p class="muted">${t("proj.overview.noRecent")}</p>`
          }
        </section>
      </div>`;
    // Dokument-Link: zuletzt geöffnetes Dokument des Bereichs merken, damit der Tab es direkt zeigt
    host.querySelectorAll<HTMLAnchorElement>("a[data-doc]").forEach((a) =>
      a.addEventListener("click", () => {
        try {
          localStorage.setItem(`sidc_proj_doc:${ctx.id}:${a.dataset.space}`, a.dataset.doc!);
        } catch {
          /* ignore */
        }
      }),
    );
  };

  host.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
  const load = async () => paint(await api.projectOverview(ctx.id));
  load().catch((e) => {
    host.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
  startPolling(host, load);
}
