// Aufgaben-Board (Kanban): Spalten Offen / In Arbeit / Review / Erledigt. Karten per Maus oder Touch ziehbar.
import { api, type PlanItem, type ProjectMember, type ProjectTask, type TaskPriority, type TaskStatus } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { a11yModal, confirmDialog, toastError } from "./notify";
import { type ProjCtx, dragWith, fmtDate, modalOpen, startPolling, todayStr } from "./projectUtil";

const COLS: TaskStatus[] = ["open", "doing", "review", "done"];
const PRIOS: TaskPriority[] = ["low", "normal", "high"];

export function mountBoard(host: HTMLElement, ctx: ProjCtx): void {
  let tasks: ProjectTask[] = [];
  let members: ProjectMember[] = [];
  let plans: PlanItem[] = [];
  let dragging = false;
  let mineOnly = false;
  try {
    mineOnly = localStorage.getItem(`sidc_proj_mine:${ctx.id}`) === "1";
  } catch {
    /* ignore */
  }

  host.innerHTML = `
    <div class="kb-wrap">
      <div class="kb-bar">
        <div class="segmented" role="group" aria-label="${t("proj.task.filter")}">
          <button type="button" class="seg-btn" data-flt="all" title="${t("proj.task.filterAll")}">${t("proj.task.filterAll")}</button>
          <button type="button" class="seg-btn" data-flt="me" title="${t("proj.task.filterMine")}">${t("proj.task.filterMine")}</button>
        </div>
        <span class="muted kb-hint">${ctx.canEdit ? t("proj.task.hint") : t("proj.task.hintRo")}</span>
      </div>
      <div class="kb-cols" id="kbCols"></div>
    </div>`;
  const cols = host.querySelector<HTMLElement>("#kbCols")!;

  const assigneeName = (x: ProjectTask): string =>
    x.assignee_label || members.find((m) => m.subject_type === "user" && m.subject_id === x.assignee_id)?.name || "";
  const sorted = (st: TaskStatus) => tasks.filter((x) => x.status === st).sort((a, b) => a.ordering - b.ordering);

  const paintBar = () =>
    host.querySelectorAll<HTMLElement>("[data-flt]").forEach((b) => b.classList.toggle("active", (b.dataset.flt === "me") === mineOnly));

  const cardHtml = (x: ProjectTask): string => {
    const late = !!x.due_date && x.status !== "done" && x.due_date < todayStr();
    const who = assigneeName(x);
    return `<div class="kb-card prio-${x.priority}" data-id="${esc(x.id)}" tabindex="0" role="button" title="${t("proj.task.open")}">
      ${ctx.canEdit ? `<span class="kb-grip" title="${t("proj.task.drag")}">${icon("drag", 14)}</span>` : ""}
      <div class="kb-title">${esc(x.title)}</div>
      <div class="kb-meta">
        ${x.priority !== "normal" ? `<span class="kb-prio p-${x.priority}">${t("proj.prio." + x.priority)}</span>` : ""}
        ${x.due_date ? `<span class="kb-due ${late ? "due-late" : ""}" title="${t("proj.task.due")}">${icon("calendar", 12)} ${esc(fmtDate(x.due_date))}</span>` : ""}
        ${who ? `<span class="kb-who" title="${t("proj.task.assignee")}">${icon("users", 12)} ${esc(who)}</span>` : ""}
      </div>
      ${
        x.plan_id || x.doc_id
          ? `<div class="kb-links">${x.plan_id ? `<a href="#/plans/${esc(x.plan_id)}" title="${t("proj.task.openPlan")}">${icon("map", 12)} ${esc(x.plan_name || t("proj.task.plan"))}</a>` : ""}${
              x.doc_id ? `<span class="kb-doclink">${icon("notes", 12)} ${esc(x.doc_name || t("proj.task.doc"))}</span>` : ""
            }</div>`
          : ""
      }
    </div>`;
  };

  const paint = () => {
    paintBar();
    const keepScroll = cols.scrollLeft;
    cols.innerHTML = COLS.map((st) => {
      const list = sorted(st);
      return `<section class="kb-col col-${st}" data-st="${st}" aria-label="${t("proj.col." + st)}">
        <header><strong>${t("proj.col." + st)}</strong><span class="kb-count">${list.length}</span></header>
        <div class="kb-list">${list.map(cardHtml).join("")}${
          list.length ? "" : `<div class="kb-empty muted">${ctx.canEdit ? t("proj.task.emptyCol") : t("proj.task.emptyColRo")}</div>`
        }</div>
        ${
          ctx.canEdit
            ? `<div class="kb-add"><input maxlength="200" placeholder="${t("proj.task.titlePh")}" aria-label="${t("proj.task.titlePh")}" />
                <button class="icon-btn" title="${t("proj.task.add")}" aria-label="${t("proj.task.add")}">${icon("plus", 16)}</button></div>`
            : ""
        }
      </section>`;
    }).join("");
    cols.scrollLeft = keepScroll;
    wire();
  };

  const reload = async () => {
    tasks = await api.projectTasks(ctx.id, mineOnly ? { assignee: "me" } : {});
    if (!dragging) paint();
  };

  const wire = () => {
    cols.querySelectorAll<HTMLElement>(".kb-add").forEach((add) => {
      const st = (add.closest(".kb-col") as HTMLElement).dataset.st as TaskStatus;
      const inp = add.querySelector("input")!;
      const go = async () => {
        const title = inp.value.trim();
        if (!title) return;
        inp.value = "";
        try {
          await api.createProjectTask(ctx.id, { title, status: st, ordering: sorted(st).length });
          await reload();
        } catch (e) {
          toastError(e);
        }
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void go();
      });
      add.querySelector("button")!.addEventListener("click", () => void go());
    });
    cols.querySelectorAll<HTMLElement>(".kb-card").forEach((card) => {
      const task = tasks.find((x) => x.id === card.dataset.id)!;
      const open = () => openTaskDialog(ctx, task, members, plans, reload);
      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        if (suppressClick) return;
        open();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.target === card) open();
      });
      if (ctx.canEdit) card.addEventListener("pointerdown", (e) => startDrag(card, task, e));
    });
  };

  let suppressClick = false;

  const startDrag = (card: HTMLElement, task: ProjectTask, e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("a,input,select,button")) return;
    // Touch: nur am Griff ziehen (sonst scrollt die Seite/das Board); Maus: überall nach 5 px
    if (e.pointerType !== "mouse" && !(e.target as HTMLElement).closest(".kb-grip")) return;
    let ghost: HTMLElement | null = null;
    const mark = document.createElement("div");
    mark.className = "kb-drop";
    let target: { st: TaskStatus; idx: number } | null = null;
    const ox = e.clientX - card.getBoundingClientRect().left;
    const oy = e.clientY - card.getBoundingClientRect().top;

    dragWith(
      card,
      e,
      (ev) => {
        if (!ghost) {
          dragging = true;
          ghost = card.cloneNode(true) as HTMLElement;
          ghost.classList.add("kb-ghost");
          ghost.style.width = `${card.offsetWidth}px`;
          document.body.appendChild(ghost);
          card.classList.add("dragging");
        }
        ghost.style.left = `${ev.clientX - ox}px`;
        ghost.style.top = `${ev.clientY - oy}px`;
        // Rand-Autoscroll des Boards (schmale Bildschirme)
        const r = cols.getBoundingClientRect();
        if (ev.clientX < r.left + 36) cols.scrollLeft -= 14;
        else if (ev.clientX > r.right - 36) cols.scrollLeft += 14;
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const col = el?.closest<HTMLElement>(".kb-col");
        if (!col) {
          mark.remove();
          target = null;
          return;
        }
        const list = col.querySelector<HTMLElement>(".kb-list")!;
        const others = [...list.querySelectorAll<HTMLElement>(".kb-card")].filter((c) => c !== card);
        let idx = others.length;
        for (let i = 0; i < others.length; i++) {
          const b = others[i].getBoundingClientRect();
          if (ev.clientY < b.top + b.height / 2) {
            idx = i;
            break;
          }
        }
        target = { st: col.dataset.st as TaskStatus, idx };
        list.querySelector(".kb-empty")?.remove();
        if (idx < others.length) list.insertBefore(mark, others[idx]);
        else list.appendChild(mark);
      },
      async (_ev, moved) => {
        ghost?.remove();
        mark.remove();
        card.classList.remove("dragging");
        if (!moved) {
          dragging = false;
          return;
        }
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 0);
        const tg = target;
        if (!tg) {
          dragging = false;
          paint();
          return;
        }
        // lokal sofort umsortieren, dann Server
        const list = sorted(tg.st).filter((x) => x.id !== task.id);
        list.splice(tg.idx, 0, task);
        task.status = tg.st;
        list.forEach((x, i) => (x.ordering = i));
        dragging = false;
        paint();
        try {
          await api.moveProjectTask(ctx.id, task.id, tg.st, tg.idx);
          await reload();
        } catch (err) {
          toastError(err);
          await reload().catch(() => {});
        }
      },
      5,
    );
  };

  host.querySelectorAll<HTMLElement>("[data-flt]").forEach((b) =>
    b.addEventListener("click", () => {
      mineOnly = b.dataset.flt === "me";
      try {
        localStorage.setItem(`sidc_proj_mine:${ctx.id}`, mineOnly ? "1" : "0");
      } catch {
        /* ignore */
      }
      void reload().catch(toastError);
    }),
  );

  cols.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
  void Promise.all([
    // Zuständige = alle Nutzer mit Zugriff, auch über Gruppen (nicht nur direkt eingetragene Mitglieder)
    api
      .projectAssignees(ctx.id)
      .then((a): ProjectMember[] => a.map((u) => ({ subject_type: "user", subject_id: u.user_id, role: "viewer", name: u.label })))
      .catch((): ProjectMember[] => []),
    api.projectPlans(ctx.id).catch((): PlanItem[] => []),
  ]).then(([m, p]) => {
    members = m;
    plans = p;
    return reload();
  }).catch((e) => {
    cols.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
  startPolling(
    host,
    reload,
    () => dragging || modalOpen() || !!cols.querySelector(".kb-add input:focus") || !!cols.querySelector(".kb-add input:not(:placeholder-shown)"),
  );
}

async function openTaskDialog(
  ctx: ProjCtx,
  task: ProjectTask,
  members: ProjectMember[],
  plans: PlanItem[],
  done: () => Promise<void>,
): Promise<void> {
  const users = members.filter((m) => m.subject_type === "user");
  // Dokumente für den Bezug (Missionsbau-Dokumente nur für Builder)
  const docs = [
    ...(await api.projectDocs(ctx.id, "public").catch(() => [])),
    ...(ctx.isBuilder ? await api.projectDocs(ctx.id, "builder").catch(() => []) : []),
  ].filter((d) => d.kind === "doc");
  const ro = !ctx.canEdit;
  const dis = ro ? "disabled" : "";
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card stack kb-dlg" style="width:min(34rem,94vw);max-height:92vh;overflow:auto">
    <h1 style="margin:0;font-size:1.05rem">${t("proj.task.edit")}</h1>
    <label class="muted" for="tk-t">${t("proj.task.title")}</label>
    <input id="tk-t" maxlength="200" value="${esc(task.title)}" placeholder="${t("proj.task.titlePh")}" ${dis} />
    <label class="muted" for="tk-d">${t("proj.task.desc")}</label>
    <textarea id="tk-d" rows="5" maxlength="20000" placeholder="${t("proj.task.descPh")}" ${dis}>${esc(task.description)}</textarea>
    <div class="kb-dlg-grid">
      <div class="field"><label class="muted" for="tk-s">${t("proj.task.status")}</label>
        <select id="tk-s" ${dis}>${COLS.map((s) => `<option value="${s}" ${s === task.status ? "selected" : ""}>${t("proj.col." + s)}</option>`).join("")}</select></div>
      <div class="field"><label class="muted" for="tk-p">${t("proj.task.priority")}</label>
        <select id="tk-p" ${dis}>${PRIOS.map((s) => `<option value="${s}" ${s === task.priority ? "selected" : ""}>${t("proj.prio." + s)}</option>`).join("")}</select></div>
      <div class="field"><label class="muted" for="tk-a">${t("proj.task.assignee")}</label>
        <select id="tk-a" ${dis}><option value="">${t("proj.unassigned")}</option>${users
          .map((m) => `<option value="${esc(m.subject_id)}" ${m.subject_id === task.assignee_id ? "selected" : ""}>${esc(m.name || m.subject_id.slice(0, 8))}</option>`)
          .join("")}${
          task.assignee_id && !users.some((m) => m.subject_id === task.assignee_id)
            ? `<option value="${esc(task.assignee_id)}" selected>${esc(task.assignee_label || task.assignee_id.slice(0, 8))}</option>`
            : ""
        }</select></div>
      <div class="field"><label class="muted" for="tk-due">${t("proj.task.due")}</label>
        <input id="tk-due" type="date" value="${esc(task.due_date ?? "")}" ${dis} /></div>
      <div class="field"><label class="muted" for="tk-pl">${t("proj.task.plan")}</label>
        <select id="tk-pl" ${dis}><option value="">${t("proj.task.none")}</option>${plans
          .map((p) => `<option value="${esc(p.id)}" ${p.id === task.plan_id ? "selected" : ""}>${esc(p.name)}</option>`)
          .join("")}</select></div>
      <div class="field"><label class="muted" for="tk-dc">${t("proj.task.doc")}</label>
        <select id="tk-dc" ${dis}><option value="">${t("proj.task.none")}</option>${docs
          .map((d) => `<option value="${esc(d.id)}" ${d.id === task.doc_id ? "selected" : ""}>${esc(d.name)}</option>`)
          .join("")}</select></div>
    </div>
    <div class="row" style="justify-content:space-between">
      ${ctx.canEdit ? `<button class="danger" data-del title="${t("common.delete")}">${icon("trash", 14)} ${t("common.delete")}</button>` : "<span></span>"}
      <span class="row"><button data-c>${ro ? t("common.close") : t("common.cancel")}</button>
      ${ro ? "" : `<button class="primary" data-ok>${t("common.save")}</button>`}</span>
    </div></div>`;
  document.body.appendChild(back);
  a11yModal(back, t("proj.task.edit"));
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  back.querySelector("[data-c]")!.addEventListener("click", close);
  const v = (id: string) => back.querySelector<HTMLInputElement>(id)!.value;
  back.querySelector("[data-ok]")?.addEventListener("click", async () => {
    const title = v("#tk-t").trim();
    if (!title) {
      back.querySelector("#tk-t")!.classList.add("invalid");
      return;
    }
    try {
      await api.patchProjectTask(ctx.id, task.id, {
        title,
        description: v("#tk-d"),
        status: v("#tk-s") as TaskStatus,
        priority: v("#tk-p") as TaskPriority,
        assignee_id: v("#tk-a") || null,
        due_date: v("#tk-due") || null,
        plan_id: v("#tk-pl") || null,
        doc_id: v("#tk-dc") || null,
      });
      close();
      await done();
    } catch (e) {
      toastError(e);
    }
  });
  back.querySelector("[data-del]")?.addEventListener("click", async () => {
    if (!(await confirmDialog(t("proj.task.deleteConfirm"), { danger: true, trash: true }))) return;
    try {
      await api.deleteProjectTask(ctx.id, task.id);
      close();
      await done();
    } catch (e) {
      toastError(e);
    }
  });
}
