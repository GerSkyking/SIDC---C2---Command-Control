// Seitenleiste am Datei-Editor: Kommentare, Verlauf (Versionen) und Export (Markdown / Drucken).
// projectDocs.ts reicht den Editor-Zustand über `DocSideHooks` herein (kein Rück-Import → keine Zirkelbezüge).
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { a11yModal, confirmDialog, toast, toastError } from "./notify";
import { type DocVersion, docCommentApi, docVersionApi, versionAuthor } from "./projectFeedbackApi";
import { wireRefChips } from "./projectRefs";
import { mountThread } from "./projectThread";
import { type ProjCtx, fmtBytes, relTime } from "./projectUtil";

export type SideTab = "comments" | "history" | "export";

export interface DocSideHooks {
  /** Markdown → HTML wie im Editor (inkl. Projektbilder) */
  render(src: string): string;
  /** aktueller Text im Editor (auch ungespeicherter Entwurf) */
  content(): string;
  /** ungespeicherte Änderungen vorhanden? */
  dirty(): boolean;
  /** Datei vom Server neu laden und den Editor neu zeichnen (Entwurf/Konflikt-Zustand verwerfen) */
  reload(): Promise<void>;
}

/** Dateiname aus dem Titel: ohne Pfadzeichen/Steuerzeichen, ohne doppelte „.md". */
export function exportFileName(title: string): string {
  const base = title
    .replace(/\.md$/i, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100);
  return (base || "Datei") + ".md";
}

export function downloadMarkdown(title: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(title);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Druckansicht: nur die gerenderte Datei (Titel + Inhalt), Projekt-Chips als Text. Der Rest der Seite wird per
 * Druck-Stylesheet (`body.printing`) ausgeblendet; `window.print()` öffnet den Druck-/PDF-Dialog.
 */
export async function printDoc(ctx: ProjCtx, title: string, content: string, render: (s: string) => string): Promise<void> {
  document.getElementById("printRoot")?.remove();
  const root = document.createElement("div");
  root.id = "printRoot";
  root.className = "print-doc md-preview";
  root.innerHTML = `<h1 class="print-title">${esc(title.replace(/\.md$/i, ""))}</h1>
    <p class="print-meta">${esc(ctx.project.name)} · ${esc(new Date().toLocaleDateString())}</p>
    <div class="print-body">${render(content)}</div>`;
  document.body.appendChild(root);
  try {
    await wireRefChips(root, ctx.id); // Namen auflösen …
  } catch {
    /* Chips bleiben dann mit Typnamen */
  }
  // … und die Chips als reinen Text ausgeben (Links/Symbole sind auf Papier nutzlos)
  root.querySelectorAll<HTMLElement>(".ref-chip, .note-img-ref").forEach((c) => {
    const lbl = c.querySelector(".ref-lbl")?.textContent?.trim() || (c.classList.contains("note-img-ref") ? t("ref.type.img") : c.textContent?.trim() || "");
    c.replaceWith(document.createTextNode(`[${lbl}]`));
  });
  const cleanup = () => {
    document.body.classList.remove("printing");
    root.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Bilder abwarten, damit sie im Ausdruck erscheinen
  await Promise.all(
    [...root.querySelectorAll("img")].map((im) => (im.complete ? Promise.resolve() : new Promise((r) => { im.onload = im.onerror = () => r(null); }))),
  );
  document.body.classList.add("printing");
  window.print();
}

/** Inhalt eines Seitenleisten-Reiters aufbauen. Rückgabe: Funktion zum Auffrischen nach dem Speichern (oder undefined). */
export function mountSideTab(box: HTMLElement, tab: SideTab, ctx: ProjCtx, doc: { id: string; name: string }, hooks: DocSideHooks): (() => void) | undefined {
  if (tab === "comments") {
    void mountThread(box, ctx, doc.id, {
      list: () => docCommentApi.list(ctx.id, doc.id),
      create: (text) => docCommentApi.create(ctx.id, doc.id, text),
      patch: (id, text) => docCommentApi.patch(ctx.id, doc.id, id, text),
      remove: (id) => docCommentApi.remove(ctx.id, doc.id, id),
    });
    return undefined;
  }
  if (tab === "export") {
    box.innerHTML = `<p class="muted">${t("dx.exp.intro")}</p>
      <div class="dx-exp stack">
        <button data-md title="${esc(t("dx.exp.mdHint"))}">${icon("download", 14)} ${t("dx.exp.md")}</button>
        <button data-print title="${esc(t("dx.exp.printHint"))}">${icon("pdf", 14)} ${t("dx.exp.print")}</button>
      </div>`;
    box.querySelector("[data-md]")!.addEventListener("click", () => downloadMarkdown(doc.name, hooks.content()));
    box.querySelector("[data-print]")!.addEventListener("click", () => void printDoc(ctx, doc.name, hooks.content(), hooks.render).catch(toastError));
    return undefined;
  }
  return mountHistory(box, ctx, doc, hooks);
}

function mountHistory(box: HTMLElement, ctx: ProjCtx, doc: { id: string; name: string }, hooks: DocSideHooks): () => void {
  box.innerHTML = `<p class="muted">${t("dx.hist.intro")}</p><ul class="dx-hist" aria-live="polite"><li class="muted">${t("common.loading")}</li></ul>`;
  const ul = box.querySelector<HTMLElement>(".dx-hist")!;
  let versions: DocVersion[] = [];

  const paint = () => {
    ul.innerHTML = versions.length
      ? versions
          .map((v) => {
            const who = versionAuthor(v);
            return `<li class="dx-v" data-id="${esc(v.id)}">
              <div class="dx-vh"><strong title="${esc(new Date(v.created_at).toLocaleString())}">${esc(new Date(v.created_at).toLocaleString())}</strong>
                <span class="muted">${esc(relTime(v.created_at))}${who ? " · " + esc(t("dx.hist.by")) + " " + esc(who) : ""}${v.byte_size != null ? " · " + esc(fmtBytes(v.byte_size)) : ""}</span></div>
              <div class="row"><button data-view>${icon("search", 13)} ${t("dx.hist.view")}</button>
                ${ctx.canEdit ? `<button data-restore>${icon("undo", 13)} ${t("dx.hist.restore")}</button>` : ""}</div></li>`;
          })
          .join("")
      : `<li class="muted">${t("dx.hist.empty")}</li>`;
  };
  const load = async () => {
    try {
      versions = (await docVersionApi.list(ctx.id, doc.id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
      paint();
    } catch (e) {
      ul.innerHTML = `<li class="error">${esc(e instanceof Error ? e.message : String(e))}</li>`;
    }
  };

  const restore = async (v: DocVersion): Promise<boolean> => {
    const msg = hooks.dirty() ? `${t("dx.hist.restoreConfirm")}\n\n${t("dx.hist.restoreDirty")}` : t("dx.hist.restoreConfirm");
    if (!(await confirmDialog(msg, { okLabel: t("dx.hist.restore"), danger: hooks.dirty() }))) return false;
    try {
      await docVersionApi.restore(ctx.id, doc.id, v.id);
      toast(t("dx.hist.restored"), { kind: "success", timeout: 2200 });
      await hooks.reload();
      await load();
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };

  const view = async (v: DocVersion) => {
    let full: DocVersion;
    try {
      full = await docVersionApi.get(ctx.id, doc.id, v.id);
    } catch (e) {
      toastError(e);
      return;
    }
    const back = document.createElement("div");
    back.className = "edit-modal";
    const when = new Date(full.created_at).toLocaleString();
    back.innerHTML = `<div class="card stack dx-view">
      <div class="row"><h1 style="margin:0;font-size:1.05rem;flex:1">${esc(t("dx.hist.version"))} ${esc(when)}</h1>
        <button class="icon-btn" data-x title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${icon("x", 16)}</button></div>
      <div class="dx-view-body md-preview"></div>
      <div class="row" style="justify-content:flex-end">
        ${ctx.canEdit ? `<button class="primary" data-restore>${icon("undo", 14)} ${t("dx.hist.restore")}</button>` : ""}
        <button data-x>${t("common.close")}</button>
      </div></div>`;
    document.body.appendChild(back);
    a11yModal(back, `${t("dx.hist.version")} ${when}`);
    const bodyEl = back.querySelector<HTMLElement>(".dx-view-body")!;
    bodyEl.innerHTML = hooks.render(full.content ?? "");
    void wireRefChips(bodyEl, ctx.id);
    const close = () => back.remove();
    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.addEventListener("keydown", (e) => e.key === "Escape" && close());
    back.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", close));
    back.querySelector("[data-restore]")?.addEventListener("click", async () => {
      if (await restore(full)) close();
    });
  };

  ul.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const v = versions.find((x) => x.id === el.closest<HTMLElement>(".dx-v")?.dataset.id);
    if (!v) return;
    if (el.closest("[data-view]")) void view(v);
    else if (el.closest("[data-restore]")) void restore(v);
  });
  void load();
  return () => void load();
}
