// Bereich „Öffentlich" / „Missionsbau" eines Projekts: Dateibaum + Markdown-Editor (mit Vorschau) und Bilder-Raster.
import { api, ApiError, type ProjectDoc, type ProjectDocNode, type ProjectImage, type ProjectSpace } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { openLightbox } from "./lightbox";
import { renderMarkdown } from "./md";
import { type DocSideHooks, type SideTab, mountSideTab } from "./projectDocExtras";
import { attachMdToolbar } from "./mdtoolbar";
import { confirmDialog, promptDialog, toast, toastError } from "./notify";
import { clearRefCache, copyBtn, mountBacklinks, onDeepLink, takeDeepLink, wireCopyButtons, wireRefChips } from "./projectRefs";
import { type DocType, DOC_TYPES, DOC_TYPE_ICON, askNewDoc, docTypeLabel, isDocType, templateContent } from "./projectTemplates";
import { type ProjCtx, fmtBytes, modalOpen, relTime, startPolling } from "./projectUtil";

type Mode = "edit" | "split" | "preview";

/** Markdown rendern; eigene Projektbilder `![](/plans/<plan>/images/<id>/raw)` werden zu <img> (nur dieses URL-Muster). */
function renderDoc(src: string): string {
  const imgs: { alt: string; url: string }[] = [];
  const pre = src.replace(/!\[([^\]\n]*)\]\((\/plans\/[0-9a-f]{32}\/images\/[0-9a-f]{32}\/raw)\)/g, (_m, alt: string, url: string) => {
    imgs.push({ alt, url });
    return `@@PIMG${imgs.length - 1}@@`;
  });
  return renderMarkdown(pre).replace(/@@PIMG(\d+)@@/g, (_m, i: string) => {
    const im = imgs[Number(i)];
    return im ? `<img class="pd-img" src="${esc(im.url)}" alt="${esc(im.alt)}" loading="lazy" data-hide-on-error />` : "";
  });
}

export function mountDocs(host: HTMLElement, ctx: ProjCtx, space: ProjectSpace): void {
  const key = (k: string) => `${k}:${ctx.id}:${space}`;
  const ls = {
    get: (k: string): string | null => {
      try {
        return localStorage.getItem(key(k));
      } catch {
        return null;
      }
    },
    set: (k: string, v: string | null) => {
      try {
        if (v === null) localStorage.removeItem(key(k));
        else localStorage.setItem(key(k), v);
      } catch {
        /* ignore */
      }
    },
  };
  let sub: "docs" | "images" = ls.get("sidc_proj_sub") === "images" ? "images" : "docs";
  // Deep-Links aus Verweis-Chips/Suche: ?doc=<id> öffnet die Datei, ?img=<id> das Bild
  const dl = takeDeepLink();
  let wantDoc = dl.get("doc") ?? "";
  let wantImg = dl.get("img") ?? "";
  if (wantDoc) sub = "docs";
  else if (wantImg) sub = "images";
  let selectDoc: ((id: string) => Promise<void>) | null = null;
  let imgFocus: ((id: string) => void) | null = null;
  onDeepLink(host, ctx.id, [space], (p) => {
    const d = p.get("doc");
    const im = p.get("img");
    if (d) {
      wantDoc = d;
      if (sub === "docs" && selectDoc) void selectDoc(d);
      else void switchSub("docs");
      return true;
    }
    if (im) {
      wantImg = im;
      if (sub === "images" && imgFocus) imgFocus(im);
      else void switchSub("images");
      return true;
    }
    return false;
  });

  host.innerHTML = `
    <div class="pd">
      <p class="muted pd-intro">${space === "builder" ? t("proj.docs.introBuilder") : t("proj.docs.intro")}</p>
      <div class="segmented pd-sub" role="tablist">
        <button type="button" class="seg-btn" data-sub="docs" title="${t("proj.docs.tabDocsHint")}">${icon("notes", 15)} ${t("proj.docs.tabDocs")}</button>
        <button type="button" class="seg-btn" data-sub="images" title="${t("proj.docs.tabImagesHint")}">${icon("image", 15)} ${t("proj.docs.tabImages")}</button>
      </div>
      <div class="pd-main" id="pdMain"></div>
    </div>`;
  const main = host.querySelector<HTMLElement>("#pdMain")!;
  let stopPoll: (() => void) | null = null;
  const showSub = () => {
    stopPoll?.();
    stopPoll = null;
    host.querySelectorAll<HTMLElement>("[data-sub]").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
    if (sub === "docs") stopPoll = mountTree();
    else mountImages();
  };
  async function switchSub(next: "docs" | "images"): Promise<void> {
    if (next === sub) return;
    if (dirtyCheck && !(await dirtyCheck())) return;
    sub = next;
    ls.set("sidc_proj_sub", sub);
    showSub();
  }
  host.querySelectorAll<HTMLElement>("[data-sub]").forEach((b) => b.addEventListener("click", () => void switchSub(b.dataset.sub as "docs" | "images")));
  let dirtyCheck: (() => Promise<boolean>) | null = null;

  // ─── Dateibaum + Editor ──────────────────────────────────────────────────
  function mountTree(): () => void {
    let nodes: ProjectDocNode[] = [];
    let doc: ProjectDoc | null = null;
    let dirty = false;
    let mode: Mode = (ls.get("sidc_proj_mode") as Mode) || (window.innerWidth >= 1100 ? "split" : "edit");
    if (!ctx.canEdit) mode = "preview";
    else if (mode === "split" && window.innerWidth < 800) mode = "edit";
    const open = new Set<string>(JSON.parse(ls.get("sidc_proj_open") || "[]") as string[]);
    let dragId = "";
    let conflict = false;
    let saving = false;
    let sideTab: SideTab | null = null; // geöffneter Reiter der Seitenleiste (Kommentare / Verlauf / Export)
    let sideRefresh: (() => void) | undefined;

    main.innerHTML = `
      <div class="pd-split">
        <aside class="pd-tree">
          <div class="pd-tree-bar">
            ${
              ctx.canEdit
                ? `<button class="primary" id="pdNewDoc" title="${t("proj.docs.newDocHint")}">${icon("plus", 14)} ${t("proj.docs.newDoc")}</button>
                   <button id="pdNewFolder" title="${t("proj.docs.newFolderHint")}">${icon("folder", 14)} ${t("proj.docs.newFolder")}</button>`
                : `<span class="muted">${t("proj.docs.readonly")}</span>`
            }
          </div>
          <div class="pd-tree-list" id="pdTree"></div>
        </aside>
        <section class="pd-editor" id="pdEd"></section>
      </div>`;
    const split = main.querySelector<HTMLElement>(".pd-split")!;
    const treeEl = main.querySelector<HTMLElement>("#pdTree")!;
    const edEl = main.querySelector<HTMLElement>("#pdEd")!;
    wireCopyButtons(treeEl);
    wireCopyButtons(edEl);

    const byId = () => new Map(nodes.map((n) => [n.id, n]));
    const kids = (pid: string | null) =>
      nodes
        .filter((n) => (n.parent_id ?? null) === pid)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "folder" ? -1 : 1));
    const isDesc = (anc: string, id: string | null): boolean => {
      const m = byId();
      for (let cur = id ? m.get(id) : undefined, n = 0; cur && n < 50; n++) {
        if (cur.id === anc) return true;
        cur = cur.parent_id ? m.get(cur.parent_id) : undefined;
      }
      return false;
    };
    const saveOpen = () => ls.set("sidc_proj_open", JSON.stringify([...open]));

    /** Zielordner für „Neu": gewählter Ordner bzw. Ordner des gewählten Dokuments */
    const currentFolder = (): string | null => {
      if (!doc) return null;
      return doc.parent_id ?? null;
    };

    const move = async (id: string, parent: string | null) => {
      const n = byId().get(id);
      if (!n || (n.parent_id ?? null) === parent || isDesc(id, parent)) return;
      try {
        await api.patchProjectDoc(ctx.id, id, { parent_id: parent });
        if (parent) open.add(parent);
        saveOpen();
        await refresh();
      } catch (e) {
        toastError(e);
      }
    };

    const rowHtml = (n: ProjectDocNode, depth: number): string => {
      const isOpen = open.has(n.id);
      const sel = doc?.id === n.id;
      const edit = ctx.canEdit
        ? `${
            n.kind === "folder"
              ? `<button class="icon-btn" data-a="newdoc" title="${t("proj.docs.newDocIn")}" aria-label="${t("proj.docs.newDocIn")}">${icon("plus", 14)}</button>
                 <button class="icon-btn" data-a="newfolder" title="${t("proj.docs.newFolderIn")}" aria-label="${t("proj.docs.newFolderIn")}">${icon("folder", 14)}</button>`
              : ""
          }<button class="icon-btn" data-a="ren" title="${t("common.rename")}" aria-label="${t("common.rename")}">${icon("edit", 14)}</button>
            <button class="icon-btn" data-a="del" title="${t("common.delete")}" aria-label="${t("common.delete")}">${icon("x", 14)}</button>`
        : "";
      const acts = n.kind === "doc" || edit ? `<span class="pd-acts">${n.kind === "doc" ? copyBtn("doc", n.id) : ""}${edit}</span>` : "";
      const dt = n.doc_type ? docTypeLabel(n.doc_type) : "";
      return `<div class="pd-row ${n.kind} ${sel ? "selected" : ""}" data-id="${esc(n.id)}" style="padding-left:${0.4 + depth * 1.1}rem" ${ctx.canEdit ? 'draggable="true"' : ""}>
        ${
          n.kind === "folder"
            ? `<button class="tree-tw icon-btn" data-a="tw" title="${isOpen ? t("common.collapse") : t("common.expand")}" aria-label="${isOpen ? t("common.collapse") : t("common.expand")}">${icon(isOpen ? "chevronDown" : "chevron", 14)}</button>${icon(isOpen ? "folderOpen" : "folder", 15)}`
            : `<span class="pd-sp"></span>${
                dt ? `<span class="pd-type" role="img" title="${esc(dt)}" aria-label="${esc(dt)}">${icon(DOC_TYPE_ICON[n.doc_type!] ?? "notes", 15)}</span>` : icon("notes", 15)
              }`
        }
        <span class="pd-name" title="${esc(n.name)}">${esc(n.name)}</span>${acts}</div>`;
    };
    const branch = (pid: string | null, depth: number): string =>
      kids(pid)
        .map((n) => rowHtml(n, depth) + (n.kind === "folder" && open.has(n.id) ? branch(n.id, depth + 1) : ""))
        .join("");

    const paintTree = () => {
      treeEl.innerHTML = nodes.length
        ? branch(null, 0)
        : `<div class="pd-empty muted">${icon("notes", 28)}<p>${ctx.canEdit ? t("proj.docs.emptyTree") : t("proj.docs.emptyTreeRo")}</p></div>`;
      if (nodes.length && ctx.canEdit) treeEl.insertAdjacentHTML("beforeend", `<div class="pd-rootdrop muted">${t("proj.docs.dropRoot")}</div>`);
      wireTree();
    };

    const wireTree = () => {
      const clearHi = () => treeEl.querySelectorAll(".drop-hi").forEach((x) => x.classList.remove("drop-hi"));
      treeEl.querySelectorAll<HTMLElement>(".pd-row").forEach((row) => {
        const id = row.dataset.id!;
        const n = byId().get(id)!;
        row.addEventListener("click", async (e) => {
          const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
          if (a === "tw" || (!a && n.kind === "folder")) {
            if (open.has(id)) open.delete(id);
            else open.add(id);
            saveOpen();
            paintTree();
            return;
          }
          if (a === "ren") return void rename(n);
          if (a === "del") return void remove(n);
          if (a === "newdoc") return void create("doc", id);
          if (a === "newfolder") return void create("folder", id);
          if (n.kind === "doc") await select(id);
        });
        if (!ctx.canEdit) return;
        row.addEventListener("dragstart", (e) => {
          dragId = id;
          e.dataTransfer?.setData("text/plain", id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          row.classList.add("dragging");
        });
        row.addEventListener("dragend", () => {
          dragId = "";
          row.classList.remove("dragging");
          clearHi();
        });
        // Ziel: Ordner = hinein, Dokument = in dessen Ordner
        const target = n.kind === "folder" ? id : (n.parent_id ?? null);
        row.addEventListener("dragover", (e) => {
          if (!dragId) return;
          e.preventDefault();
          e.stopPropagation();
          if (!row.classList.contains("drop-hi")) {
            clearHi();
            row.classList.add("drop-hi");
          }
        });
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          e.stopPropagation();
          clearHi();
          const d = e.dataTransfer?.getData("text/plain") || dragId;
          if (d) void move(d, target);
        });
      });
      treeEl.ondragover = (e) => {
        if (!dragId) return;
        e.preventDefault();
      };
      treeEl.ondrop = (e) => {
        e.preventDefault();
        clearHi();
        const d = e.dataTransfer?.getData("text/plain") || dragId;
        if (d) void move(d, null);
      };
    };

    const create = async (kind: "doc" | "folder", parent: string | null = currentFolder()) => {
      let name = "";
      let type: DocType = "";
      if (kind === "doc") {
        const pick = await askNewDoc(); // Name + Vorlage
        if (!pick) return;
        name = pick.name;
        type = pick.type;
      } else {
        name = (await promptDialog(t("proj.docs.namePromptFolder"), { placeholder: t("proj.docs.namePhFolder") }))?.trim() ?? "";
      }
      if (!name) return;
      if (!(await leave())) return;
      try {
        const nm = kind === "doc" && !/\.md$/i.test(name) ? name + ".md" : name;
        const c = await api.createProjectDoc(ctx.id, {
          space,
          parent_id: parent,
          kind,
          name: nm,
          content: kind === "doc" ? templateContent(type, name.replace(/\.md$/i, "")) : undefined,
          doc_type: kind === "doc" && type ? type : undefined,
        });
        if (parent) open.add(parent);
        saveOpen();
        await refresh();
        if (kind === "doc") await select(c.id, true);
      } catch (e) {
        toastError(e);
      }
    };
    const rename = async (n: ProjectDocNode) => {
      const name = (await promptDialog(t("proj.docs.renamePrompt"), { value: n.name }))?.trim();
      if (!name || name === n.name) return;
      try {
        await api.patchProjectDoc(ctx.id, n.id, { name });
        clearRefCache();
        if (doc?.id === n.id) doc.name = name;
        await refresh();
        if (doc?.id === n.id) paintEditor(false);
      } catch (e) {
        toastError(e);
      }
    };
    const remove = async (n: ProjectDocNode) => {
      if (!(await confirmDialog(n.kind === "folder" ? t("proj.docs.deleteFolderConfirm") : t("proj.docs.deleteConfirm"), { danger: true, trash: true }))) return;
      try {
        await api.deleteProjectDoc(ctx.id, n.id);
        if (doc && (doc.id === n.id || isDesc(n.id, doc.id))) {
          doc = null;
          dirty = false;
          ls.set("sidc_proj_doc", null);
        }
        await refresh();
        paintEditor();
      } catch (e) {
        toastError(e);
      }
    };

    // ─ Editor ─
    const leave = async (): Promise<boolean> => {
      if (!dirty) return true;
      const ok = await confirmDialog(t("proj.docs.discardConfirm"), { okLabel: t("proj.docs.discard"), danger: true });
      if (ok) dirty = false;
      return ok;
    };
    dirtyCheck = leave;

    const select = async (id: string, fresh = false) => {
      if (doc?.id === id) {
        split.classList.add("has-doc");
        return;
      }
      if (!fresh && !(await leave())) return;
      try {
        doc = await api.projectDoc(ctx.id, id);
        dirty = false;
        conflict = false;
        ls.set("sidc_proj_doc", id);
        paintEditor();
        paintTree();
      } catch (e) {
        toastError(e);
      }
    };

    selectDoc = async (id) => {
      if (!nodes.some((n) => n.id === id && n.kind === "doc")) await refresh().catch(() => {});
      if (!nodes.some((n) => n.id === id && n.kind === "doc")) return;
      await select(id);
      // Eltern aufklappen, damit die Datei im Baum sichtbar ist
      const m = byId();
      for (let c = m.get(id)?.parent_id ? m.get(m.get(id)!.parent_id!) : undefined; c; c = c.parent_id ? m.get(c.parent_id) : undefined) open.add(c.id);
      saveOpen();
      paintTree();
    };

    const folderOptions = (): string => {
      const out: string[] = [`<option value="">${t("proj.docs.rootFolder")}</option>`];
      const walk = (pid: string | null, depth: number) => {
        for (const f of kids(pid).filter((x) => x.kind === "folder")) {
          out.push(`<option value="${esc(f.id)}" ${doc?.parent_id === f.id ? "selected" : ""}>${"  ".repeat(depth)}${esc(f.name)}</option>`);
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      return out.join("");
    };

    function paintEditor(full = true): void {
      split.classList.toggle("has-doc", !!doc);
      if (!doc) {
        edEl.innerHTML = `<div class="pd-noDoc muted">${icon("notes", 40)}<h3>${t("proj.docs.noDoc")}</h3><p>${ctx.canEdit ? t("proj.docs.noDocHint") : t("proj.docs.noDocHintRo")}</p>${
          ctx.canEdit ? `<button class="primary" id="pdNewDoc2">${icon("plus", 14)} ${t("proj.docs.newDoc")}</button>` : ""
        }</div>`;
        edEl.querySelector("#pdNewDoc2")?.addEventListener("click", () => void create("doc", null));
        return;
      }
      if (!full) {
        const nm = edEl.querySelector(".pd-docname");
        if (nm) nm.textContent = doc.name;
        return;
      }
      const ro = !ctx.canEdit;
      edEl.innerHTML = `
        <div class="pd-ed-head">
          <button class="icon-btn pd-back" id="pdBack" title="${t("proj.docs.backToTree")}" aria-label="${t("proj.docs.backToTree")}">${icon("back", 18)}</button>
          <strong class="pd-docname" title="${esc(doc.name)}">${esc(doc.name)}</strong>
          <span class="pd-dirty" id="pdDirty" hidden title="${t("proj.docs.unsaved")}">●</span>
          ${copyBtn("doc", doc.id, "icon-btn", 15)}
          <span class="grow"></span>
          ${
            ro
              ? doc.doc_type
                ? `<span class="badge pd-typebadge">${esc(docTypeLabel(doc.doc_type))}</span>`
                : ""
              : `<select id="pdType" class="pd-folder" title="${t("tpl.typeHint")}" aria-label="${t("tpl.typeHint")}">${["", ...DOC_TYPES]
                  .map((ty) => `<option value="${ty}" ${(doc!.doc_type ?? "") === ty ? "selected" : ""}>${ty ? t("dt." + ty) : t("dt.none")}</option>`)
                  .join("")}</select>`
          }
          <div class="segmented pd-sidebtns" role="group" aria-label="${t("dx.panel")}">${(["comments", "history", "export"] as const)
            .map(
              (k) =>
                `<button type="button" class="seg-btn" data-side="${k}" aria-pressed="false" aria-controls="pdSide" title="${t("dx." + k + "Hint")}" aria-label="${t("dx." + k)}">${icon(
                  k === "comments" ? "textbox" : k === "history" ? "versions" : "download",
                  14,
                )}<span class="pd-lbl"> ${t("dx." + k)}</span></button>`,
            )
            .join("")}</div>
          ${ro ? "" : `<select id="pdFolder" class="pd-folder" title="${t("proj.docs.moveTo")}" aria-label="${t("proj.docs.moveTo")}">${folderOptions()}</select>`}
          ${
            ro
              ? ""
              : `<div class="segmented" role="group" aria-label="${t("proj.docs.mode")}">
                  <button type="button" class="seg-btn" data-mode="edit" title="${t("proj.docs.modeEdit")}">${icon("edit", 14)}<span class="pd-lbl"> ${t("proj.docs.modeEdit")}</span></button>
                  <button type="button" class="seg-btn pd-split-btn" data-mode="split" title="${t("proj.docs.modeSplit")}">${icon("layers", 14)}<span class="pd-lbl"> ${t("proj.docs.modeSplit")}</span></button>
                  <button type="button" class="seg-btn" data-mode="preview" title="${t("proj.docs.modePreview")}">${icon("search", 14)}<span class="pd-lbl"> ${t("proj.docs.modePreview")}</span></button>
                </div>
                <button class="primary" id="pdSave" title="${t("proj.docs.saveHint")}" disabled>${t("common.save")}</button>`
          }
        </div>
        <div class="pd-conflict" id="pdConflict" hidden></div>
        <div class="pd-ed-body mode-${mode}">
          ${ro ? "" : `<textarea id="pdText" spellcheck="false" maxlength="200000" placeholder="${t("proj.docs.textPh")}" aria-label="${t("proj.docs.text")}"></textarea>`}
          <div class="pd-preview md-preview" id="pdPrev"></div>
        </div>
        <div class="pd-ed-foot muted" id="pdFoot"></div>
        <div class="pd-backlinks" id="pdBl"></div>
        <aside class="pd-side" id="pdSide" hidden aria-label="${t("dx.panel")}">
          <div class="pd-side-head"><strong id="pdSideT"></strong><span class="grow"></span>
            <button type="button" class="icon-btn" data-sideclose title="${t("common.close")}" aria-label="${t("common.close")}">${icon("x", 16)}</button></div>
          <div class="pd-side-body" id="pdSideBody"></div>
        </aside>`;
      const sideEl = edEl.querySelector<HTMLElement>("#pdSide")!;
      const showSide = (tab: SideTab | null) => {
        sideTab = tab;
        sideRefresh = undefined;
        edEl.querySelectorAll<HTMLElement>("[data-side]").forEach((b) => {
          b.classList.toggle("active", b.dataset.side === tab);
          b.setAttribute("aria-pressed", String(b.dataset.side === tab));
        });
        sideEl.hidden = !tab;
        const body = sideEl.querySelector<HTMLElement>("#pdSideBody")!;
        body.innerHTML = "";
        if (!tab || !doc) return;
        sideEl.querySelector("#pdSideT")!.textContent = t("dx." + tab);
        sideRefresh = mountSideTab(body, tab, ctx, doc, sideHooks);
      };
      edEl.querySelectorAll<HTMLElement>("[data-side]").forEach((b) =>
        b.addEventListener("click", () => showSide(sideTab === b.dataset.side ? null : (b.dataset.side as SideTab))),
      );
      sideEl.querySelector("[data-sideclose]")!.addEventListener("click", () => {
        showSide(null);
        edEl.querySelector<HTMLElement>(`[data-side]`)?.focus();
      });
      void mountBacklinks(edEl.querySelector<HTMLElement>("#pdBl")!, ctx.id, "doc", doc.id);
      edEl.querySelector<HTMLSelectElement>("#pdType")?.addEventListener("change", async (e) => {
        const sel = e.target as HTMLSelectElement;
        const v = isDocType(sel.value) ? sel.value : "";
        try {
          const r = await api.patchProjectDoc(ctx.id, doc!.id, { doc_type: v });
          doc!.doc_type = v;
          doc!.updated_at = r.updated_at ?? doc!.updated_at;
          const nd = nodes.find((x) => x.id === doc!.id);
          if (nd) nd.doc_type = v;
          paintTree();
        } catch (err) {
          sel.value = doc!.doc_type ?? "";
          toastError(err);
        }
      });
      const ta = edEl.querySelector<HTMLTextAreaElement>("#pdText");
      const prev = edEl.querySelector<HTMLElement>("#pdPrev")!;
      const body = edEl.querySelector<HTMLElement>(".pd-ed-body")!;
      const foot = edEl.querySelector<HTMLElement>("#pdFoot")!;
      const saveBtn = edEl.querySelector<HTMLButtonElement>("#pdSave");
      const paintPrev = () => {
        prev.innerHTML = renderDoc(ta ? ta.value : doc!.content);
        void wireRefChips(prev, ctx.id);
      };
      const paintFoot = () =>
        (foot.textContent = `${fmtBytes(new Blob([ta ? ta.value : doc!.content]).size)} · ${t("proj.docs.saved")} ${relTime(doc!.updated_at)}${doc!.updated_by ? " · " + doc!.updated_by : ""}`);
      const setDirty = (v: boolean) => {
        dirty = v;
        edEl.querySelector<HTMLElement>("#pdDirty")!.hidden = !v;
        if (saveBtn) saveBtn.disabled = !v || saving;
      };
      const setMode = (m: Mode) => {
        mode = m;
        ls.set("sidc_proj_mode", m);
        body.className = `pd-ed-body mode-${m}`;
        edEl.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
        paintPrev();
      };
      edEl.querySelector("#pdBack")!.addEventListener("click", async () => {
        if (!(await leave())) return;
        doc = null;
        ls.set("sidc_proj_doc", null);
        paintEditor();
        paintTree();
      });
      edEl.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as Mode)));
      if (ta) {
        ta.value = doc.content;
        attachMdToolbar(ta, { projectId: ctx.id, isBuilder: ctx.isBuilder, timeline: true });
        let tm = 0;
        ta.addEventListener("input", () => {
          setDirty(true);
          window.clearTimeout(tm);
          tm = window.setTimeout(paintPrev, 150);
        });
        const save = async (force = false) => {
          if (!doc || !dirty || saving) return;
          saving = true;
          if (saveBtn) saveBtn.disabled = true;
          try {
            let expected = doc.updated_at;
            if (force) expected = (await api.projectDoc(ctx.id, doc.id)).updated_at;
            const r = await api.patchProjectDoc(ctx.id, doc.id, { content: ta.value, expected_updated_at: expected });
            doc.content = ta.value;
            doc.updated_at = r.updated_at ?? doc.updated_at;
            doc.byte_size = r.byte_size ?? doc.byte_size;
            conflict = false;
            showConflict(false);
            setDirty(false);
            paintFoot();
            toast(t("proj.docs.savedToast"), { kind: "success", timeout: 1800 });
            sideRefresh?.();
            void refresh();
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
              conflict = true;
              showConflict(true);
            } else toastError(e);
          } finally {
            saving = false;
            if (saveBtn) saveBtn.disabled = !dirty;
          }
        };
        saveFn = save;
        saveBtn?.addEventListener("click", () => void save());
        const cf = edEl.querySelector<HTMLElement>("#pdConflict")!;
        function showConflict(v: boolean): void {
          cf.hidden = !v;
          if (!v) return;
          cf.innerHTML = `<span>${icon("lock", 14)} ${t("proj.docs.conflict")}</span>
            <button data-o title="${t("tip.doc.mine")}">${t("proj.docs.conflictMine")}</button><button data-l title="${t("tip.doc.theirs")}">${t("proj.docs.conflictTheirs")}</button>`;
          cf.querySelector("[data-o]")!.addEventListener("click", () => void save(true));
          cf.querySelector("[data-l]")!.addEventListener("click", async () => {
            try {
              doc = await api.projectDoc(ctx.id, doc!.id);
              ta!.value = doc.content;
              conflict = false;
              showConflict(false);
              setDirty(false);
              paintPrev();
              paintFoot();
            } catch (e) {
              toastError(e);
            }
          });
        }
        showConflictFn = showConflict;
        if (conflict) showConflict(true);
        edEl.querySelector<HTMLSelectElement>("#pdFolder")?.addEventListener("change", (e) => {
          const v = (e.target as HTMLSelectElement).value || null;
          void move(doc!.id, v).then(() => {
            if (doc) doc.parent_id = v;
          });
        });
      }
      setMode(mode);
      paintFoot();
      showSide(sideTab);
    }
    /** Editor-Zustand für die Seitenleiste (Verlauf/Export) */
    const sideHooks: DocSideHooks = {
      render: renderDoc,
      content: () => edEl.querySelector<HTMLTextAreaElement>("#pdText")?.value ?? doc?.content ?? "",
      dirty: () => dirty,
      reload: async () => {
        if (!doc) return;
        doc = await api.projectDoc(ctx.id, doc.id); // Entwurf und Konflikt-Zustand gelten nach dem Wiederherstellen nicht mehr
        dirty = false;
        conflict = false;
        paintEditor();
        void refresh().catch(() => {});
      },
    };
    let saveFn: ((force?: boolean) => Promise<void>) | null = null;
    let showConflictFn: ((v: boolean) => void) | null = null;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && host.isConnected && doc && ctx.canEdit) {
        e.preventDefault();
        void saveFn?.();
      }
    };
    document.addEventListener("keydown", onKey);

    // ─ Laden / Polling ─
    const refresh = async () => {
      const next = await api.projectDocs(ctx.id, space);
      const changed = JSON.stringify(next) !== JSON.stringify(nodes);
      nodes = next;
      // geöffnetes Dokument gelöscht?
      if (doc && !nodes.some((n) => n.id === doc!.id)) {
        toast(t("proj.docs.vanished"), { kind: "warn" });
        doc = null;
        dirty = false;
        ls.set("sidc_proj_doc", null);
        paintEditor();
      } else if (doc) {
        const cur = nodes.find((n) => n.id === doc!.id)!;
        if (cur.updated_at !== doc.updated_at) {
          if (!dirty && !saving) {
            doc = await api.projectDoc(ctx.id, doc.id);
            paintEditor();
          } else if (dirty) {
            conflict = true;
            showConflictFn?.(true);
          }
        }
      }
      if (changed && !dragId) paintTree();
    };

    const poll = startPolling(host, refresh, () => !!dragId || modalOpen());
    refresh()
      .then(async () => {
        const last = wantDoc || ls.get("sidc_proj_doc");
        wantDoc = "";
        if (last && nodes.some((n) => n.id === last && n.kind === "doc")) {
          try {
            doc = await api.projectDoc(ctx.id, last);
          } catch {
            doc = null;
          }
        }
        paintTree();
        paintEditor();
        // geöffnetes Dokument: Eltern aufklappen
        if (doc) {
          const m = byId();
          for (let c = doc.parent_id ? m.get(doc.parent_id) : undefined; c; c = c.parent_id ? m.get(c.parent_id) : undefined) open.add(c.id);
          paintTree();
        }
      })
      .catch((e) => {
        treeEl.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
      });

    main.querySelector("#pdNewDoc")?.addEventListener("click", () => void create("doc"));
    main.querySelector("#pdNewFolder")?.addEventListener("click", () => void create("folder"));
    return () => {
      poll();
      document.removeEventListener("keydown", onKey);
      dirtyCheck = null;
      selectDoc = null;
    };
  }

  // ─── Bilder ──────────────────────────────────────────────────────────────
  function mountImages(): void {
    dirtyCheck = null;
    main.innerHTML = `<div class="pd-imgs"><p class="muted">${t("common.loading")}</p></div>`;
    const box = main.querySelector<HTMLElement>(".pd-imgs")!;
    let imgs: ProjectImage[] = [];
    const url = (i: ProjectImage) => api.planImageUrl(i.plan_id, i.id);
    const md = (i: ProjectImage) => `![${(i.caption || i.filename).replace(/[\[\]\n]/g, " ")}](${url(i)})`;
    const paint = () => {
      box.innerHTML = `
        <div class="pd-imgs-bar"><span class="muted">${t("proj.img.hint")}</span><span class="grow"></span>
          <button id="imgReload" title="${t("proj.img.reload")}">${t("proj.img.reload")}</button></div>
        ${
          imgs.length
            ? `<div class="pd-grid">${imgs
                .map(
                  (i) => `<figure class="pd-imgcard" data-id="${esc(i.id)}">
                    <a href="${esc(url(i))}" target="_blank" rel="noopener" title="${t("proj.img.open")}"><img src="${esc(url(i))}" alt="${esc(i.caption || i.filename)}" loading="lazy" data-hide-on-error /></a>
                    <figcaption>
                      <strong title="${esc(i.caption || i.filename)}">${esc(i.caption || i.filename)}</strong>
                      <span class="muted"><a href="#/plans/${esc(i.plan_id)}">${icon("map", 11)} ${esc(i.plan_name)}</a> · ${fmtBytes(i.byte_size)}${i.natural_w ? ` · ${i.natural_w}×${i.natural_h}` : ""}${i.author ? " · " + esc(i.author) : ""}</span>
                      <span class="pd-imgacts">
                        <button data-a="copy" title="${t("proj.img.copyHint")}">${icon("clone", 13)} ${t("proj.img.copy")}</button>
                        ${copyBtn("img", i.id, "icon-btn", 14)}
                        ${
                          ctx.canEdit
                            ? `<button class="icon-btn" data-a="ren" title="${t("common.rename")}" aria-label="${t("common.rename")}">${icon("edit", 14)}</button>
                               <button class="icon-btn" data-a="del" title="${t("common.delete")}" aria-label="${t("common.delete")}">${icon("trash", 14)}</button>`
                            : ""
                        }
                      </span>
                    </figcaption></figure>`,
                )
                .join("")}</div>`
            : `<div class="pd-empty muted">${icon("image", 36)}<h3>${t("proj.img.empty")}</h3><p>${t("proj.img.emptyHint")}</p><a href="#/projects/${ctx.id}/plans">${t("proj.img.toPlans")}</a></div>`
        }`;
      box.querySelector("#imgReload")!.addEventListener("click", () => void load());
      box.querySelectorAll<HTMLElement>(".pd-imgcard").forEach((c) => {
        const i = imgs.find((x) => x.id === c.dataset.id)!;
        c.querySelector('[data-a="copy"]')!.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(md(i));
            toast(t("proj.img.copied"), { kind: "success", timeout: 2200 });
          } catch {
            await promptDialog(t("proj.img.copyManual"), { value: md(i) });
          }
        });
        c.querySelector('[data-a="ren"]')?.addEventListener("click", async () => {
          const v = (await promptDialog(t("proj.img.renamePrompt"), { value: i.caption || i.filename }))?.trim();
          if (!v || v === i.caption) return;
          try {
            await api.patchProjectImage(ctx.id, i.id, { caption: v });
            await load();
          } catch (e) {
            toastError(e);
          }
        });
        c.querySelector('[data-a="del"]')?.addEventListener("click", async () => {
          if (!(await confirmDialog(t("proj.img.deleteConfirm"), { danger: true, trash: true }))) return;
          try {
            await api.deleteProjectImage(ctx.id, i.id);
            await load();
          } catch (e) {
            toastError(e);
          }
        });
      });
    };
    const load = async () => {
      try {
        imgs = await api.projectImages(ctx.id, space);
        paint();
      } catch (e) {
        box.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
      }
    };
    wireCopyButtons(box);
    imgFocus = (id) => {
      const i = imgs.find((x) => x.id === id);
      if (i) openLightbox([{ url: url(i), caption: i.caption || i.filename }]);
      else toast(t("ref.unavailable"), { kind: "warn" });
    };
    void load().then(() => {
      if (!wantImg) return;
      const w = wantImg;
      wantImg = "";
      imgFocus?.(w);
    });
  }

  showSub();
}
