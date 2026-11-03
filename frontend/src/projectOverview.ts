// Projektübersicht: Zahlen, offene Aufgaben je Person, Fälliges, zuletzt Geändertes.
import { api, type ProjectOverview, type ProjectTask } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { a11yModal, confirmDialog, toastError } from "./notify";
import { type Milestone, STAGES, type ProjectStage, feedbackApi, isStage, milestoneApi, setFeedbackBadge, stageApi } from "./projectFeedbackApi";
import { type ProjCtx, fmtDate, modalOpen, relTime, startPolling, todayStr } from "./projectUtil";

/** Meilenstein anlegen/bearbeiten (Titel + Termin). */
function milestoneDialog(ctx: ProjCtx, ms: Milestone | null, done: () => void): void {
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card stack" style="width:min(26rem,94vw)">
    <h1 style="margin:0;font-size:1.05rem">${ms ? t("ms.edit") : t("ms.add")}</h1>
    <label class="muted" for="ms-t">${t("ms.titleLbl")}</label>
    <input id="ms-t" maxlength="120" autocomplete="off" value="${esc(ms?.title ?? "")}" />
    <label class="muted" for="ms-d">${t("ms.due")}</label>
    <input id="ms-d" type="date" value="${esc((ms?.due_date ?? "").slice(0, 10))}" />
    <p class="error" id="ms-err" role="alert"></p>
    <div class="row" style="justify-content:flex-end">
      <button data-c>${t("common.cancel")}</button>
      <button class="primary" data-ok>${t("common.save")}</button>
    </div></div>`;
  document.body.appendChild(back);
  a11yModal(back, ms ? t("ms.edit") : t("ms.add"));
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.querySelector("[data-c]")!.addEventListener("click", close);
  const go = async () => {
    const title = back.querySelector<HTMLInputElement>("#ms-t")!.value.trim();
    if (!title) {
      back.querySelector("#ms-err")!.textContent = t("ms.needTitle");
      back.querySelector("#ms-t")!.classList.add("invalid");
      return;
    }
    const due = back.querySelector<HTMLInputElement>("#ms-d")!.value || null;
    try {
      if (ms) await milestoneApi.patch(ctx.id, ms.id, { title, due_date: due });
      else await milestoneApi.create(ctx.id, { title, due_date: due });
      close();
      done();
    } catch (e) {
      toastError(e);
    }
  };
  back.querySelector("[data-ok]")!.addEventListener("click", () => void go());
  back.querySelector("#ms-t")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void go();
  });
}

export function mountOverview(host: HTMLElement, ctx: ProjCtx): void {
  const taskLi = (x: ProjectTask, late: boolean): string =>
    `<li><a href="#/projects/${ctx.id}/tasks" title="${t("proj.overview.toTasks")}">
       <span class="ov-t">${esc(x.title)}</span>
       <span class="ov-m">${x.assignee_label ? esc(x.assignee_label) + " · " : ""}<span class="${late ? "due-late" : ""}">${esc(fmtDate(x.due_date))}</span></span></a></li>`;

  let last: ProjectOverview | null = null;
  let milestones: Milestone[] | null = null;
  let fbNew: number | null = null;

  const stageHtml = (): string => {
    const cur: ProjectStage = isStage(ctx.project.stage) ? ctx.project.stage : "draft";
    const idx = STAGES.indexOf(cur);
    return `<section class="ov-card ov-wide" aria-labelledby="ovStageH">
      <h3 id="ovStageH">${t("stage.title")}</h3>
      <ol class="stg" aria-label="${esc(t("stage.title"))}">${STAGES.map((s, i) => {
        const cls = i < idx ? "past" : i === idx ? "cur" : "next";
        const inner = `<span class="stg-n">${i < idx ? icon("check", 12) : i + 1}</span><span class="stg-l">${t("stage." + s)}</span>`;
        return `<li class="stg-i ${cls}">${
          ctx.canEdit
            ? `<button type="button" class="stg-b" data-stage="${s}" aria-pressed="${i === idx}" ${i === idx ? 'aria-current="step"' : ""} title="${esc(t("stage.setTo") + ": " + t("stage." + s))}">${inner}</button>`
            : `<span class="stg-b" ${i === idx ? 'aria-current="step"' : ""}>${inner}</span>`
        }</li>`;
      }).join("")}</ol>
      <p class="muted stg-hint">${t("stage.hint." + cur)}${ctx.canEdit ? "" : " · " + t("stage.readonly")}</p>
    </section>`;
  };

  const milestonesHtml = (): string => {
    if (milestones === null) return "";
    const today = todayStr();
    const list = [...milestones].sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        (a.due_date || "9999").localeCompare(b.due_date || "9999") ||
        (a.ordering ?? 0) - (b.ordering ?? 0),
    );
    const nDone = list.filter((m) => m.done).length;
    const pct = list.length ? Math.round((nDone / list.length) * 100) : 0;
    return `<section class="ov-card ov-wide" aria-labelledby="ovMsH">
      <div class="ms-head"><h3 id="ovMsH">${t("ms.title")}</h3><span class="grow"></span>
        ${ctx.canEdit ? `<button data-ms-add>${icon("plus", 14)} ${t("ms.add")}</button>` : ""}</div>
      ${
        list.length
          ? `<div class="ms-prog"><div class="ms-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"
               aria-label="${esc(t("ms.title"))}"><i style="width:${pct}%"></i></div>
             <span class="muted">${nDone} ${t("ms.of")} ${list.length} ${t("ms.doneN")} · ${pct} %</span></div>
             <ul class="ms-list">${list
               .map((m) => {
                 const late = !m.done && !!m.due_date && m.due_date.slice(0, 10) < today;
                 return `<li class="ms-i ${m.done ? "done" : ""} ${late ? "late" : ""}" data-id="${esc(m.id)}">
                   <input type="checkbox" class="ms-chk" ${m.done ? "checked" : ""} ${ctx.canEdit ? "" : "disabled"} aria-label="${esc(t("ms.done") + ": " + m.title)}" />
                   <span class="ms-t">${esc(m.title)}</span>
                   <span class="ms-d ${late ? "due-late" : "muted"}">${
                     m.due_date ? `${icon("calendar", 12)} ${esc(fmtDate(m.due_date))}${late ? " · " + t("ms.overdue") : ""}` : esc(t("ms.noDue"))
                   }</span>
                   ${
                     ctx.canEdit
                       ? `<button class="icon-btn" data-ms-edit title="${esc(t("ms.edit"))}" aria-label="${esc(t("ms.edit"))}">${icon("edit", 14)}</button>
                          <button class="icon-btn" data-ms-del title="${esc(t("common.delete"))}" aria-label="${esc(t("common.delete"))}">${icon("trash", 14)}</button>`
                       : ""
                   }</li>`;
               })
               .join("")}</ul>`
          : `<p class="muted">${t("ms.empty")}</p>`
      }
    </section>`;
  };

  const wireExtras = () => {
    host.querySelectorAll<HTMLButtonElement>("[data-stage]").forEach((b) =>
      b.addEventListener("click", async () => {
        const s = b.dataset.stage!;
        if (!isStage(s) || s === ctx.project.stage) return;
        try {
          await stageApi.set(ctx.id, s);
          ctx.project.stage = s;
          if (last) paint(last);
        } catch (e) {
          toastError(e);
        }
      }),
    );
    host.querySelector("[data-ms-add]")?.addEventListener("click", () => milestoneDialog(ctx, null, () => void load().catch(toastError)));
    host.querySelectorAll<HTMLElement>(".ms-i").forEach((row) => {
      const m = milestones?.find((x) => x.id === row.dataset.id);
      if (!m) return;
      row.querySelector<HTMLInputElement>(".ms-chk")!.addEventListener("change", async (e) => {
        try {
          await milestoneApi.patch(ctx.id, m.id, { done: (e.target as HTMLInputElement).checked });
          await load();
        } catch (err) {
          toastError(err);
          void load().catch(() => {});
        }
      });
      row.querySelector("[data-ms-edit]")?.addEventListener("click", () => milestoneDialog(ctx, m, () => void load().catch(toastError)));
      row.querySelector("[data-ms-del]")?.addEventListener("click", async () => {
        if (!(await confirmDialog(t("ms.delConfirm"), { danger: true, trash: true }))) return;
        try {
          await milestoneApi.remove(ctx.id, m.id);
          await load();
        } catch (err) {
          toastError(err);
        }
      });
    });
  };

  const paint = (o: ProjectOverview) => {
    last = o;
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
          ${fbNew === null ? "" : stat("star", fbNew, t("proj.overview.feedbackNew"), `#/projects/${ctx.id}/feedback`)}
        </div>
        ${stageHtml()}
        ${milestonesHtml()}
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
    wireExtras();
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
  const load = async () => {
    const [o, ms, fb, p] = await Promise.all([
      api.projectOverview(ctx.id),
      milestoneApi.list(ctx.id).catch((): Milestone[] | null => null),
      feedbackApi.newCount(ctx.id).catch((): number | null => null),
      api.project(ctx.id).catch(() => null),
    ]);
    milestones = ms;
    fbNew = fb;
    if (fb !== null) setFeedbackBadge(fb);
    if (p && isStage(p.stage)) ctx.project.stage = p.stage;
    paint(o);
  };
  load().catch((e) => {
    host.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
  startPolling(host, load, () => modalOpen());
}
