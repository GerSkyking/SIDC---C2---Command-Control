// Tab „Verzeichnis": Dateien beider Bereiche nach Dokumenttyp gruppiert (Personen, Fraktionen, Orte, Szenen …),
// Suche nach Titel UND Inhalt (search?types=doc). Klick öffnet die Datei, „Neu" legt sie mit passender Vorlage an.
import { api, type ProjectSpace } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { toastError } from "./notify";
import { copyBtn, projectLink, refApi, wireCopyButtons } from "./projectRefs";
import { DOC_TYPE_ICON, type DocType, askNewDoc, docTypeLabel, isDocType, templateContent } from "./projectTemplates";
import type { ProjCtx } from "./projectUtil";

interface DirDoc {
  id: string;
  name: string;
  space: ProjectSpace;
  type: string;
}

const GROUPS: { id: string; types: string[]; newType: DocType }[] = [
  { id: "mission", types: ["mission"], newType: "mission" },
  { id: "character", types: ["character"], newType: "character" },
  { id: "faction", types: ["faction"], newType: "faction" },
  { id: "place", types: ["place"], newType: "place" },
  { id: "scene", types: ["scene"], newType: "scene" },
  { id: "orders", types: ["opord", "briefing"], newType: "opord" },
  { id: "other", types: [""], newType: "" },
];

export function mountDirectory(host: HTMLElement, ctx: ProjCtx): void {
  let docs: DirDoc[] = [];
  let query = "";
  let hits: Map<string, string> | null = null; // Doc-ID → Snippet (nur bei aktiver Suche)
  let order: string[] = [];
  let seq = 0;
  let timer = 0;

  host.innerHTML = `
    <div class="dir">
      <p class="muted dir-intro">${t("dir.intro")}</p>
      <div class="dir-bar">
        <input type="search" id="dirQ" class="dir-q" maxlength="200" autocomplete="off" placeholder="${esc(t("dir.searchPh"))}" aria-label="${esc(t("dir.search"))}" />
        <span class="muted dir-status" id="dirStatus" role="status" aria-live="polite"></span>
      </div>
      <div class="dir-groups" id="dirGroups"><p class="muted">${t("common.loading")}</p></div>
    </div>`;
  const box = host.querySelector<HTMLElement>("#dirGroups")!;
  const status = host.querySelector<HTMLElement>("#dirStatus")!;
  const qEl = host.querySelector<HTMLInputElement>("#dirQ")!;
  wireCopyButtons(box);

  const groupOf = (d: DirDoc) => GROUPS.find((g) => g.types.includes(isDocType(d.type) ? d.type : "")) ?? GROUPS[GROUPS.length - 1];

  const paint = () => {
    const shown = hits ? docs.filter((d) => hits!.has(d.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : docs;
    box.innerHTML = GROUPS.map((g) => {
      const list = shown
        .filter((d) => groupOf(d) === g)
        .sort((a, b) => (hits ? 0 : a.name.localeCompare(b.name, undefined, { numeric: true })));
      if (hits && !list.length) return "";
      return `<section class="dir-group" aria-labelledby="dg-${g.id}">
        <header class="dir-ghead">
          <h3 id="dg-${g.id}">${g.id === "other" ? icon("notes", 15) : icon(DOC_TYPE_ICON[g.newType], 15)} ${t("dir.g." + g.id)} <span class="dir-count">${list.length}</span></h3>
          ${ctx.canEdit ? `<button type="button" data-new="${g.id}" title="${esc(t("dir.newIn").replace("{g}", t("dir.g." + g.id)))}" aria-label="${esc(t("dir.newIn").replace("{g}", t("dir.g." + g.id)))}">${icon("plus", 13)} ${t("dir.new")}</button>` : ""}
        </header>
        ${
          list.length
            ? `<ul class="dir-list">${list
                .map(
                  (d) => `<li class="dir-item">
                    <a class="dir-link" href="${esc(projectLink(ctx.id, d.space, "doc=" + d.id))}">
                      <span class="dir-name">${esc(d.name.replace(/\.md$/i, ""))}</span>
                      ${d.type ? `<span class="badge" title="${esc(docTypeLabel(d.type))}">${esc(docTypeLabel(d.type))}</span>` : ""}
                      ${d.space === "builder" ? `<span class="dir-space" title="${esc(t("proj.tab.builder"))}">${icon("lock", 12)}</span>` : ""}
                      ${hits?.get(d.id) ? `<span class="dir-snip">${esc(hits.get(d.id)!)}</span>` : ""}
                    </a>${copyBtn("doc", d.id, "icon-btn", 14)}</li>`,
                )
                .join("")}</ul>`
            : `<p class="muted dir-none">${t("dir.emptyGroup")}</p>`
        }</section>`;
    }).join("");
    if (hits && !hits.size) box.innerHTML = `<p class="muted dir-none">${t("dir.noHits")}</p>`;
    box.querySelectorAll<HTMLElement>("[data-new]").forEach((b) =>
      b.addEventListener("click", () => void createIn(GROUPS.find((g) => g.id === b.dataset.new)!)),
    );
  };

  const createIn = async (g: (typeof GROUPS)[number]) => {
    const pick = await askNewDoc({ type: g.newType, spaces: ctx.isBuilder, space: ctx.isBuilder ? "builder" : "public" });
    if (!pick) return;
    try {
      const nm = /\.md$/i.test(pick.name) ? pick.name : pick.name + ".md";
      const c = await api.createProjectDoc(ctx.id, {
        space: ctx.isBuilder ? pick.space : "public",
        parent_id: null,
        kind: "doc",
        name: nm,
        content: templateContent(pick.type, pick.name.replace(/\.md$/i, "")),
        doc_type: pick.type || undefined,
      });
      location.hash = projectLink(ctx.id, ctx.isBuilder ? pick.space : "public", "doc=" + c.id);
    } catch (e) {
      toastError(e);
    }
  };

  const load = async () => {
    const spaces: ProjectSpace[] = ctx.isBuilder ? ["public", "builder"] : ["public"];
    const all = await Promise.all(spaces.map((s) => api.projectDocs(ctx.id, s)));
    docs = all.flatMap((nodes, k) =>
      nodes.filter((n) => n.kind === "doc").map((n): DirDoc => ({ id: n.id, name: n.name, space: spaces[k], type: n.doc_type ?? "" })),
    );
    paint();
  };

  const search = async () => {
    const q = query.trim();
    const my = ++seq;
    if (q.length < 2) {
      hits = null;
      status.textContent = q ? t("rp.hintMin") : "";
      paint();
      return;
    }
    status.textContent = t("common.loading");
    try {
      const r = await refApi.search(ctx.id, q, { types: ["doc"], limit: 60 });
      if (my !== seq) return;
      order = r.map((x) => x.id);
      hits = new Map(r.map((x) => [x.id, x.snippet || ""]));
      status.textContent = t("dir.hits").replace("{n}", String(r.length));
      paint();
    } catch (e) {
      if (my === seq) status.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  qEl.addEventListener("input", () => {
    query = qEl.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void search(), 300);
  });

  load().catch((e) => {
    box.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
}
