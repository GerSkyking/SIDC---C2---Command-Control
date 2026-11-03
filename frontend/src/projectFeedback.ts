// Tab „Feedback": interne und externe Rückmeldungen sichten, Status setzen, zu Aufgaben machen;
// Owner verwalten die externe Schnittstelle (Token, Link, Einbettungs-Code, curl-Beispiel).
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { renderMarkdown } from "./md";
import { a11yModal, confirmDialog, promptDialog, toast, toastError } from "./notify";
import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
  feedbackApi,
  isFeedbackKind,
  isFeedbackStatus,
  setFeedbackBadge,
} from "./projectFeedbackApi";
import { openHref, wireRefChips } from "./projectRefs";
import { type ProjCtx, fmtDate, modalOpen, relTime, startPolling } from "./projectUtil";

const KIND_ICON: Record<FeedbackKind, string> = { bug: "eraser", idea: "star", praise: "check", other: "help" };

/** Text in die Zwischenablage; ohne Clipboard-API zeigt ein Dialog den Text zum Kopieren. */
async function copyText(text: string, okMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, { kind: "success", timeout: 2200 });
  } catch {
    await promptDialog(t("fb.ext.manual"), { value: text });
  }
}

/** Codes ({{doc:…}} usw.) der Bezüge einer Rückmeldung; Chips löst wireRefChips auf. */
function refCodes(f: FeedbackItem): string {
  const ok = (v: string | null | undefined) => (v && /^[0-9a-f]{32}$/.test(v) ? v : "");
  return [ok(f.plan_id) && `{{plan:${f.plan_id}}}`, ok(f.doc_id) && `{{doc:${f.doc_id}}}`, ok(f.task_id) && `{{task:${f.task_id}}}`].filter(Boolean).join(" ");
}

export function mountFeedback(host: HTMLElement, ctx: ProjCtx): void {
  let items: FeedbackItem[] = [];
  let fStatus = "";
  let fKind = "";
  let q = "";
  let lastJson = "";

  host.innerHTML = `
    <div class="fb-wrap">
      <p class="muted fb-intro">${t("fb.intro")}</p>
      <div class="fb-bar">
        <input type="search" id="fbQ" class="fb-q" placeholder="${esc(t("fb.search"))}" aria-label="${esc(t("fb.search"))}" autocomplete="off" />
        <select id="fbS" aria-label="${esc(t("fb.filterStatus"))}" title="${esc(t("fb.filterStatus"))}">
          <option value="">${t("fb.filterStatus")}: ${t("fb.all")}</option>
          ${FEEDBACK_STATUSES.map((s) => `<option value="${s}">${t("fb.status." + s)}</option>`).join("")}
        </select>
        <select id="fbK" aria-label="${esc(t("fb.filterKind"))}" title="${esc(t("fb.filterKind"))}">
          <option value="">${t("fb.filterKind")}: ${t("fb.all")}</option>
          ${FEEDBACK_KINDS.map((k) => `<option value="${k}">${t("fb.kind." + k)}</option>`).join("")}
        </select>
        <span class="grow"></span>
        <button class="primary" id="fbNew" title="${esc(t("fb.newHint"))}">${icon("plus", 14)} ${t("fb.new")}</button>
      </div>
      <div class="fb-list" id="fbList" aria-live="polite"><p class="muted">${t("common.loading")}</p></div>
      ${ctx.isOwner ? `<details class="fb-ext" id="fbExt"><summary>${icon("channel", 15)} ${t("fb.ext.title")}</summary><div class="fb-ext-body" id="fbExtBody"></div></details>` : ""}
    </div>`;
  const list = host.querySelector<HTMLElement>("#fbList")!;

  const visible = (): FeedbackItem[] => {
    const ql = q.trim().toLowerCase();
    return items.filter(
      (f) =>
        (!fStatus || f.status === fStatus) &&
        (!fKind || f.kind === fKind) &&
        (!ql || `${f.title}\n${f.text}\n${f.author_name ?? ""}\n${f.author_label ?? ""}`.toLowerCase().includes(ql)),
    );
  };

  const cardHtml = (f: FeedbackItem): string => {
    const kind: FeedbackKind = isFeedbackKind(f.kind) ? f.kind : "other";
    const status: FeedbackStatus = isFeedbackStatus(f.status) ? f.status : "new";
    const ext = f.source === "external";
    const who = (f.author_label || f.author_name || "").trim();
    const refs = refCodes(f);
    return `<article class="fb-card st-${status}" data-id="${esc(f.id)}" aria-label="${esc(f.title)}">
      <header class="fb-head">
        <span class="fb-kind k-${kind}">${icon(KIND_ICON[kind], 13)} ${t("fb.kind." + kind)}</span>
        <span class="badge fb-src ${ext ? "ext" : ""}" title="${esc(ext ? t("fb.src.externalHint") : t("fb.src.internalHint"))}">${ext ? t("fb.src.external") : t("fb.src.internal")}${
          who || ext ? " · " + esc(who || t("fb.anon")) : ""
        }</span>
        <span class="muted fb-date" title="${esc(new Date(f.created_at).toLocaleString())}">${esc(fmtDate(f.created_at))} · ${esc(relTime(f.created_at))}</span>
        <span class="grow"></span>
        ${status === "new" ? `<span class="fb-new" aria-label="${esc(t("fb.status.new"))}">${t("fb.status.new")}</span>` : ""}
      </header>
      <h3 class="fb-title">${esc(f.title)}</h3>
      ${f.text ? `<div class="fb-text">${esc(f.text)}</div>` : ""}
      ${refs ? `<div class="fb-refs" data-refs="${esc(refs)}"></div>` : ""}
      <footer class="fb-foot">
        ${
          ctx.canEdit
            ? `<label class="fb-stlbl"><span class="visually-hidden">${t("fb.statusChange")}</span>
                 <select data-st aria-label="${esc(t("fb.statusChange"))}" title="${esc(t("fb.statusChange"))}">${FEEDBACK_STATUSES.map(
                   (s) => `<option value="${s}" ${s === status ? "selected" : ""}>${t("fb.status." + s)}</option>`,
                 ).join("")}</select></label>`
            : `<span class="badge">${t("fb.status." + status)}</span>`
        }
        ${
          ctx.canEdit && !f.task_id
            ? `<button data-totask title="${esc(t("fb.toTaskHint"))}">${icon("check", 14)} ${t("fb.toTask")}</button>`
            : ""
        }
        ${f.task_id ? `<button data-opentask>${icon("check", 14)} ${t("fb.openTask")}</button>` : ""}
        <span class="grow"></span>
        ${ctx.isOwner ? `<button class="icon-btn" data-del title="${esc(t("common.delete"))}" aria-label="${esc(t("common.delete"))}">${icon("trash", 14)}</button>` : ""}
      </footer>
    </article>`;
  };

  const paintList = () => {
    const vis = visible();
    list.innerHTML = vis.length
      ? vis.map(cardHtml).join("")
      : `<div class="fb-empty muted">${icon("star", 32)}<p>${items.length ? t("fb.emptyFilter") : t("fb.empty")}</p></div>`;
    list.querySelectorAll<HTMLElement>(".fb-refs").forEach((el) => {
      el.innerHTML = renderMarkdown(el.dataset.refs ?? "");
      void wireRefChips(el, ctx.id);
    });
  };

  const apply = (next: FeedbackItem[]) => {
    const json = JSON.stringify(next);
    setFeedbackBadge(next.filter((f) => f.status === "new").length);
    if (json === lastJson) return;
    lastJson = json;
    items = next;
    paintList();
  };
  const reload = async () => apply(await feedbackApi.list(ctx.id));

  host.querySelector("#fbQ")!.addEventListener("input", (e) => {
    q = (e.target as HTMLInputElement).value;
    paintList();
  });
  host.querySelector("#fbS")!.addEventListener("change", (e) => {
    fStatus = (e.target as HTMLSelectElement).value;
    paintList();
  });
  host.querySelector("#fbK")!.addEventListener("change", (e) => {
    fKind = (e.target as HTMLSelectElement).value;
    paintList();
  });

  list.addEventListener("change", async (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-st]");
    const card = sel?.closest<HTMLElement>(".fb-card");
    if (!sel || !card || !isFeedbackStatus(sel.value)) return;
    try {
      await feedbackApi.setStatus(ctx.id, card.dataset.id!, sel.value);
      await reload();
    } catch (err) {
      toastError(err);
      lastJson = "";
      void reload().catch(() => {});
    }
  });
  list.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const card = el.closest<HTMLElement>(".fb-card");
    if (!card) return;
    const f = items.find((x) => x.id === card.dataset.id);
    if (!f) return;
    try {
      if (el.closest("[data-totask]")) {
        const tid = await feedbackApi.toTask(ctx.id, f.id);
        toast(t("fb.toTaskDone"), { kind: "success", timeout: 2200 });
        await reload().catch(() => {});
        if (tid) openHref(`#/projects/${ctx.id}/tasks?task=${tid}`, ctx.id);
        else location.hash = `#/projects/${ctx.id}/tasks`;
      } else if (el.closest("[data-opentask]") && f.task_id) {
        openHref(`#/projects/${ctx.id}/tasks?task=${f.task_id}`, ctx.id);
      } else if (el.closest("[data-del]")) {
        if (!(await confirmDialog(t("fb.deleteConfirm"), { danger: true, trash: true }))) return;
        await feedbackApi.remove(ctx.id, f.id);
        await reload();
      }
    } catch (err) {
      toastError(err);
    }
  });

  host.querySelector("#fbNew")!.addEventListener("click", () => newFeedbackDialog(ctx, () => void reload().catch(toastError)));

  if (ctx.isOwner) mountExternal(host.querySelector<HTMLElement>("#fbExtBody")!, ctx);

  reload().catch((e) => {
    list.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
  startPolling(host, reload, () => modalOpen());
}

// ─── Dialog „Neues Feedback" ──────────────────────────────────────────────

function newFeedbackDialog(ctx: ProjCtx, done: () => void): void {
  let planId = "";
  let docId = "";
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card stack" style="width:min(30rem,94vw)">
    <h1 style="margin:0;font-size:1.05rem">${t("fb.new")}</h1>
    <label class="muted" for="fn-k">${t("fb.dlg.kind")}</label>
    <select id="fn-k">${FEEDBACK_KINDS.map((k) => `<option value="${k}">${t("fb.kind." + k)}</option>`).join("")}</select>
    <label class="muted" for="fn-t">${t("fb.dlg.title")}</label>
    <input id="fn-t" maxlength="200" autocomplete="off" />
    <label class="muted" for="fn-x">${t("fb.dlg.text")}</label>
    <textarea id="fn-x" rows="5" maxlength="5000"></textarea>
    <div class="muted">${t("fb.dlg.ref")}</div>
    <div class="row fb-refrow">
      <button type="button" id="fn-pick">${icon("link", 14)} ${t("fb.dlg.pick")}</button>
      <span id="fn-ref" class="fb-pickedref"></span>
    </div>
    <p class="error" id="fn-err" role="alert"></p>
    <div class="row" style="justify-content:flex-end">
      <button data-c>${t("common.cancel")}</button>
      <button class="primary" data-ok>${t("fb.dlg.send")}</button>
    </div></div>`;
  document.body.appendChild(back);
  a11yModal(back, t("fb.new"));
  const close = () => back.remove();
  const $ = <T extends HTMLElement>(s: string) => back.querySelector<T>(s)!;
  const err = $("#fn-err");
  const paintRef = () => {
    const codes = [planId && `{{plan:${planId}}}`, docId && `{{doc:${docId}}}`].filter(Boolean).join(" ");
    const box = $("#fn-ref");
    box.innerHTML = codes
      ? `${renderMarkdown(codes)}<button type="button" class="icon-btn" data-clr title="${esc(t("fb.dlg.clear"))}" aria-label="${esc(t("fb.dlg.clear"))}">${icon("x", 12)}</button>`
      : "";
    if (codes) void wireRefChips(box, ctx.id);
    box.querySelector("[data-clr]")?.addEventListener("click", () => {
      planId = "";
      docId = "";
      paintRef();
    });
  };
  $("#fn-pick").addEventListener("click", async () => {
    const { openRefPicker } = await import("./refPicker");
    const code = await openRefPicker({ projectId: ctx.id, mode: "insert", isBuilder: ctx.isBuilder });
    const m = code?.match(/^\{\{(doc|plan):([0-9a-f]{32})\}\}$/);
    if (code && !m) {
      err.textContent = t("fb.dlg.refOnly");
      return;
    }
    err.textContent = "";
    if (m?.[1] === "plan") planId = m[2];
    else if (m) docId = m[2];
    paintRef();
  });
  back.addEventListener("mousedown", (e) => e.target === back && close());
  $("[data-c]").addEventListener("click", close);
  $("[data-ok]").addEventListener("click", async () => {
    const title = $<HTMLInputElement>("#fn-t").value.trim();
    if (!title) {
      err.textContent = t("fb.dlg.needTitle");
      $("#fn-t").classList.add("invalid");
      return;
    }
    const kind = $<HTMLSelectElement>("#fn-k").value;
    try {
      await feedbackApi.create(ctx.id, {
        title,
        text: $<HTMLTextAreaElement>("#fn-x").value.trim(),
        kind: isFeedbackKind(kind) ? kind : "other",
        plan_id: planId || null,
        doc_id: docId || null,
      });
      toast(t("fb.sent"), { kind: "success", timeout: 2000 });
      close();
      done();
    } catch (e) {
      toastError(e);
    }
  });
}

// ─── Externe Schnittstelle (Owner) ────────────────────────────────────────

function mountExternal(box: HTMLElement, ctx: ProjCtx): void {
  const paint = (token: string | null) => {
    if (!token) {
      box.innerHTML = `<p class="muted">${t("fb.ext.intro")}</p><p class="muted">${t("fb.ext.off")}</p>
        <button class="primary" data-on>${icon("plus", 14)} ${t("fb.ext.enable")}</button>`;
      box.querySelector("[data-on]")!.addEventListener("click", async () => {
        try {
          paint(await feedbackApi.newToken(ctx.id));
        } catch (e) {
          toastError(e);
        }
      });
      return;
    }
    const origin = location.origin;
    const link = `${origin}/#/feedback/${token}`;
    const curl = `curl -X POST '${origin}/api/public/feedback/${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"kind":"idea","title":"Titel","text":"Beschreibung","name":"Name","website":""}'`;
    box.innerHTML = `
      <p class="muted">${t("fb.ext.intro")}</p>
      <label class="muted" for="fx-link">${t("fb.ext.link")}</label>
      <div class="row fb-linkrow">
        <input id="fx-link" readonly data-select-on-click value="${esc(link)}" />
        <button data-copy="link">${icon("clone", 14)} ${t("fb.ext.copyLink")}</button>
      </div>
      <div class="row fb-ext-acts">
        <button data-copy="curl">${icon("clone", 14)} ${t("fb.ext.copyCurl")}</button>
        <span class="grow"></span>
        <button data-regen>${icon("redo", 14)} ${t("fb.ext.regen")}</button>
        <button class="danger" data-off>${t("fb.ext.disable")}</button>
      </div>
`;
    const texts: Record<string, string> = { link, curl };
    box.querySelectorAll<HTMLElement>("[data-copy]").forEach((b) =>
      b.addEventListener("click", () => void copyText(texts[b.dataset.copy!], t("fb.ext.copied"))),
    );
    box.querySelector("[data-regen]")!.addEventListener("click", async () => {
      if (!(await confirmDialog(t("fb.ext.regenConfirm"), { okLabel: t("fb.ext.regen"), danger: true }))) return;
      try {
        paint(await feedbackApi.newToken(ctx.id));
      } catch (e) {
        toastError(e);
      }
    });
    box.querySelector("[data-off]")!.addEventListener("click", async () => {
      if (!(await confirmDialog(t("fb.ext.disableConfirm"), { okLabel: t("fb.ext.disable"), danger: true }))) return;
      try {
        await feedbackApi.disableToken(ctx.id);
        paint(null);
      } catch (e) {
        toastError(e);
      }
    });
  };
  box.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
  feedbackApi
    .getToken(ctx.id)
    .then(paint)
    .catch((e) => {
      box.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
    });
}
