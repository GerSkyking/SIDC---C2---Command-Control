// Tab „Verzeichnis": Dateien beider Bereiche nach Dokumenttyp gruppiert (Personen, Fraktionen, Orte, Szenen …),
// Suche nach Titel UND Inhalt (search?types=doc). Klick öffnet die Datei, „Neu" legt sie mit passender Vorlage an.
import { api, type ProjectSpace } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { renderMarkdown } from "./md";
import { toastError } from "./notify";
import { type MapNote, projectMapNotes } from "./projectFeedbackApi";
import { copyBtn, projectLink, refApi, wireCopyButtons, wireRefChips } from "./projectRefs";
import { DOC_TYPE_ICON, type DocType, askNewDoc, docTypeLabel, isDocType, templateContent } from "./projectTemplates";
import { type ProjCtx, relTime } from "./projectUtil";

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
      <section class="dir-map" id="dirMap" aria-labelledby="dirMapH" hidden></section>
    </div>`;
  const box = host.querySelector<HTMLElement>("#dirGroups")!;
  const status = host.querySelector<HTMLElement>("#dirStatus")!;
  const qEl = host.querySelector<HTMLInputElement>("#dirQ")!;
  wireCopyButtons(box);

  // ── „Auf der Karte“: Annotationen aus allen Plänen des Projekts (nur Missionsbau) ──
  const mapBox = host.querySelector<HTMLElement>("#dirMap")!;
  let mapNotes: MapNote[] | null = null; // null = nicht verfügbar (z. B. 404 für Nicht-Builder)
  const stripCodes = (x: string) => x.replace(/\{\{[^{}\n]*\}\}/g, "").replace(/^#{1,6}\s+/, "").trim();
  const noteTitle = (n: MapNote): string => {
    const first = stripCodes((n.title || n.text.split("\n").find((l) => l.trim()) || "").trim());
    return first || t("annot.placeholder");
  };
  const noteSnippet = (n: MapNote): string => {
    const lines = n.text.split("\n");
    const i = lines.findIndex((l) => l.trim());
    let body = lines.slice(i + 1).join("\n").trim();
    if (body.length > 240) body = body.slice(0, 240).replace(/\{\{[^{}]*$/, "") + "…"; // keinen halben Verweis-Code abschneiden
    return body;
  };
  const paintMap = () => {
    if (!mapNotes) {
      mapBox.hidden = true;
      return;
    }
    mapBox.hidden = false;
    const q = qEl.value.trim().toLowerCase();
    const list = q ? mapNotes.filter((n) => (noteTitle(n) + " " + n.text).toLowerCase().includes(q)) : mapNotes;
    const byPlan = new Map<string, { name: string; items: MapNote[] }>();
    for (const n of list) (byPlan.get(n.plan_id) ?? byPlan.set(n.plan_id, { name: n.plan_name, items: [] }).get(n.plan_id)!).items.push(n);
    const head = `<h3 id="dirMapH">${icon("map", 15)} ${t("dir.onMap")} <span class="dir-count">${list.length}</span></h3>`;
    if (!list.length) {
      mapBox.innerHTML = `${head}<p class="muted dir-none">${t(q ? "dir.noHits" : "dir.onMapEmpty")}</p>`;
      return;
    }
    mapBox.innerHTML =
      head +
      `<div class="dir-groups">` +
      [...byPlan.entries()]
        .map(
          ([pid, g], k) => `<section class="dir-group" aria-labelledby="dmp-${k}">
          <header class="dir-ghead"><h3 id="dmp-${k}">${esc(g.name)} <span class="dir-count">${g.items.length}</span></h3>
            <a class="dir-plan-open" href="#/plans/${esc(pid)}">${t("dir.openPlan")}</a></header>
          <ul class="dir-list">${g.items
            .map((n) => {
              const snip = noteSnippet(n);
              const who = [n.updated_by_label, n.updated_at ? relTime(n.updated_at) : ""].filter(Boolean).join(" · ");
              return `<li class="dir-item dir-note">
                <a class="dir-link" href="#/plans/${esc(n.plan_id)}?annot=${esc(n.id)}"><span class="dir-name">${esc(noteTitle(n))}</span></a>
                ${n.zeus_released ? `<span class="dir-zeus" title="${t("annot.zeusOn")}">${icon("eye", 13)} Zeus</span>` : ""}
                ${snip ? `<div class="dir-snip note-md">${renderMarkdown(snip)}</div>` : ""}
                ${who ? `<div class="dir-snip dir-who">${esc(who)}</div>` : ""}</li>`;
            })
            .join("")}</ul></section>`,
        )
        .join("") +
      `</div>`;
    void wireRefChips(mapBox, ctx.id);
  };
  if (ctx.isBuilder) {
    projectMapNotes(ctx.id)
      .then((r) => {
        mapNotes = r;
        paintMap();
      })
      .catch(() => {
        mapNotes = null; // 404 (kein Missionsbauer) oder Fehler: Abschnitt einfach weglassen
        paintMap();
      });
  }

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
    paintMap(); // Karten-Notizen filtern clientseitig sofort
    timer = window.setTimeout(() => void search(), 300);
  });

  load().catch((e) => {
    box.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
}
