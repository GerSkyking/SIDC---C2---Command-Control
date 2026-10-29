// Mitglieder-Tab: Nutzer/Gruppen mit Rolle viewer < editor < owner (Verwaltung nur für Owner).
import { api, type ProjectCandidate, type ProjectMember, type ProjectRole } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { toast, toastError } from "./notify";
import type { ProjCtx } from "./projectUtil";

const ROLES: ProjectRole[] = ["viewer", "editor", "owner"];

export function mountMembers(host: HTMLElement, ctx: ProjCtx): void {
  let members: ProjectMember[] = [];
  let cands: ProjectCandidate[] = [];
  let dirty = false;

  const nameOf = (m: { subject_type: string; subject_id: string; name?: string }): string =>
    m.name || cands.find((c) => c.subject_type === m.subject_type && c.subject_id === m.subject_id)?.name || m.subject_id.slice(0, 8);

  const paint = () => {
    const taken = new Set(members.map((m) => `${m.subject_type}:${m.subject_id}`));
    const free = cands.filter((c) => !taken.has(`${c.subject_type}:${c.subject_id}`));
    host.innerHTML = `
      <div class="mem stack">
        <div class="mem-roles muted">
          <span><strong>${t("proj.role.viewer")}</strong> – ${t("proj.roleHelp.viewer")}</span>
          <span><strong>${t("proj.role.editor")}</strong> – ${t("proj.roleHelp.editor")}</span>
          <span><strong>${t("proj.role.owner")}</strong> – ${t("proj.roleHelp.owner")}</span>
        </div>
        ${
          members.length
            ? `<table class="acl-tbl mem-tbl"><thead><tr><th></th><th>${t("common.name")}</th><th>${t("proj.members.role")}</th><th></th></tr></thead><tbody>${members
                .map(
                  (m, i) => `<tr data-i="${i}">
                    <td>${icon(m.subject_type === "group" ? "groups" : "users", 16)}</td>
                    <td style="text-align:left">${esc(nameOf(m))} <span class="muted">${m.subject_type === "group" ? t("proj.members.group") : ""}</span></td>
                    <td>${
                      ctx.isOwner
                        ? `<select data-role aria-label="${t("proj.members.role")}">${ROLES.map((r) => `<option value="${r}" ${r === m.role ? "selected" : ""}>${t("proj.role." + r)}</option>`).join("")}</select>`
                        : esc(t("proj.role." + m.role))
                    }</td>
                    <td>${ctx.isOwner ? `<button class="icon-btn" data-rm title="${t("proj.members.remove")}" aria-label="${t("proj.members.remove")}">${icon("x", 16)}</button>` : ""}</td>
                  </tr>`,
                )
                .join("")}</tbody></table>`
            : `<p class="muted">${t("proj.members.empty")}</p>`
        }
        ${
          ctx.isOwner
            ? `<div class="row mem-add">
                <select id="mem-new" aria-label="${t("proj.members.add")}">
                  <option value="">${t("proj.members.pick")}</option>
                  ${free.map((c) => `<option value="${esc(c.subject_type)}:${esc(c.subject_id)}">${c.subject_type === "group" ? "👥 " : ""}${esc(c.name)}</option>`).join("")}
                </select>
                <select id="mem-newrole" aria-label="${t("proj.members.role")}">${ROLES.map((r) => `<option value="${r}" ${r === "editor" ? "selected" : ""}>${t("proj.role." + r)}</option>`).join("")}</select>
                <button id="mem-add" title="${t("proj.members.addHint")}">${icon("plus", 14)} ${t("proj.members.add")}</button>
                <span class="grow"></span>
                <button class="primary" id="mem-save" ${dirty ? "" : "disabled"} title="${t("proj.members.saveHint")}">${t("common.save")}</button>
              </div>
              ${dirty ? `<p class="muted">${t("proj.members.unsaved")}</p>` : ""}`
            : `<p class="muted">${t("proj.members.readonly")}</p>`
        }
      </div>`;
    if (!ctx.isOwner) return;
    host.querySelectorAll<HTMLElement>("tr[data-i]").forEach((tr) => {
      const m = members[Number(tr.dataset.i)];
      tr.querySelector<HTMLSelectElement>("[data-role]")?.addEventListener("change", (e) => {
        m.role = (e.target as HTMLSelectElement).value as ProjectRole;
        dirty = true;
        paint();
      });
      tr.querySelector("[data-rm]")?.addEventListener("click", () => {
        members = members.filter((x) => x !== m);
        dirty = true;
        paint();
      });
    });
    host.querySelector("#mem-add")?.addEventListener("click", () => {
      const v = host.querySelector<HTMLSelectElement>("#mem-new")!.value;
      if (!v) return;
      const [st, ...rest] = v.split(":");
      const c = cands.find((x) => x.subject_type === st && x.subject_id === rest.join(":"));
      if (!c) return;
      members.push({
        subject_type: c.subject_type,
        subject_id: c.subject_id,
        name: c.name,
        role: host.querySelector<HTMLSelectElement>("#mem-newrole")!.value as ProjectRole,
      });
      dirty = true;
      paint();
    });
    host.querySelector("#mem-save")?.addEventListener("click", async () => {
      if (!members.some((m) => m.role === "owner")) {
        toast(t("proj.members.needOwner"), { kind: "warn" });
        return;
      }
      try {
        members = await api.putProjectMembers(ctx.id, members);
        dirty = false;
        toast(t("proj.members.saved"), { kind: "success" });
        paint();
      } catch (e) {
        toastError(e);
      }
    });
  };

  host.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
  Promise.all([api.projectMembers(ctx.id), ctx.isOwner ? api.projectCandidates(ctx.id).catch(() => []) : Promise.resolve([])])
    .then(([m, c]) => {
      members = m;
      cands = c;
      paint();
    })
    .catch((e) => {
      host.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
    });
}
