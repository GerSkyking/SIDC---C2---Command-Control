// Einfügen-Fenster für Verknüpfungs-Codes und zugleich Projektsuche.
//   openRefPicker({ projectId, mode: "insert" })  -> Code-String ({{doc:…}} usw.) oder null
//   openRefPicker({ projectId, mode: "search" })  -> navigiert zum Treffer (Rückgabe immer null)
// Suchfeld (Debounce) + Typ-Filter; „Orte" öffnet ein Untermenü Karte → Ortsliste (aus locations.json der Karte).
// Bedienung per Tastatur: Pfeile wählen, Enter übernimmt, Esc geht zurück bzw. schließt.
import { api } from "./api";
import { esc } from "./esc";
import { getLang, t } from "./i18n";
import { icon } from "./icons";
import { REF_ICON } from "./md";
import { a11yModal } from "./notify";
import { cleanPlaceName, codeOf, openHref, refApi, safeHref } from "./projectRefs";

export interface PickerOpts {
  projectId: string;
  mode: "insert" | "search";
  /** darf den Bereich „Missionsbau" sehen (für die Durchsuchen-Liste) */
  isBuilder?: boolean;
}

interface Item {
  type: string;
  id: string;
  label: string;
  sub?: string;
  snippet?: string;
  href?: string;
  /** fertiger Code (Orte); sonst codeOf(type, id) */
  code?: string;
}

const TYPES = ["doc", "task", "plan", "note", "img"] as const;
const MAX_SHOWN = 100;

interface LocData {
  langs: string[];
  groups: { key: string; label: string; items: { names: Record<string, string> }[] }[];
}
const locCache = new Map<string, Item[]>();

async function loadPlaces(mapId: string): Promise<Item[]> {
  const hit = locCache.get(mapId);
  if (hit) return hit;
  const r = await fetch(`/api/maps/${mapId}/locations.json`, { credentials: "include" });
  if (!r.ok) throw new Error(t("rp.placesFail"));
  const d = (await r.json()) as LocData;
  const lang = d.langs.find((l) => l.startsWith(getLang())) ?? (d.langs.includes("en_us") ? "en_us" : d.langs[0]);
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const g of d.groups ?? []) {
    for (const it of g.items ?? []) {
      const name = cleanPlaceName(it.names?.[lang] || it.names?.en_us || Object.values(it.names ?? {})[0] || "");
      const k = `${g.key}|${name}`;
      if (!name || seen.has(k)) continue;
      seen.add(k);
      out.push({ type: "place", id: `${mapId}:${name}`, label: name, sub: g.label || g.key, code: `{{place:${mapId}:${name}}}` });
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  locCache.set(mapId, out);
  return out;
}

export function openRefPicker(o: PickerOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const insert = o.mode === "insert";
    const pid = o.projectId;
    type View = "main" | "maps" | "places";
    let view: View = "main";
    let mapName = "";
    let mapId = "";
    const active = new Set<string>();
    let items: Item[] = [];
    let sel = 0;
    let seq = 0;
    let timer = 0;
    const browseCache = new Map<string, Item[]>();
    let maps: Item[] = [];

    const back = document.createElement("div");
    back.className = "edit-modal rp-back";
    back.innerHTML = `<div class="card rp-card">
      <div class="rp-head">
        <h1 class="rp-title" id="rp-title"></h1>
        <button type="button" class="icon-btn" data-close title="${t("common.close")}" aria-label="${t("common.close")}">${icon("x", 16)}</button>
      </div>
      <div class="rp-crumb" hidden><button type="button" data-back>${icon("back", 14)} ${t("rp.back")}</button></div>
      <input class="rp-q" type="search" role="combobox" aria-expanded="true" aria-controls="rp-list" aria-autocomplete="list"
        autocomplete="off" spellcheck="false" aria-label="${t("rp.search")}" />
      <div class="rp-filters" role="group" aria-label="${t("rp.filters")}">${TYPES.map(
        (ty) => `<button type="button" class="rp-f" data-type="${ty}" aria-pressed="false">${icon(REF_ICON[ty], 13)} ${t("rp.f." + ty)}</button>`,
      ).join("")}${
        insert ? `<button type="button" class="rp-f rp-f-place" data-places aria-haspopup="true">${icon("marker", 13)} ${t("rp.f.place")} ${icon("chevron", 12)}</button>` : ""
      }</div>
      <ul class="rp-list" id="rp-list" role="listbox" aria-labelledby="rp-title"></ul>
      <p class="rp-status muted" role="status" aria-live="polite"></p>
      <p class="rp-foot muted">${t("rp.keys")}</p>
    </div>`;
    document.body.appendChild(back);
    a11yModal(back, insert ? t("rp.title") : t("rp.titleSearch"));
    const $ = <T extends HTMLElement>(s: string) => back.querySelector<T>(s)!;
    const input = $<HTMLInputElement>(".rp-q");
    const list = $<HTMLElement>(".rp-list");
    const status = $<HTMLElement>(".rp-status");
    const titleEl = $<HTMLElement>(".rp-title");
    const crumb = $<HTMLElement>(".rp-crumb");
    const filters = $<HTMLElement>(".rp-filters");

    const done = (v: string | null) => {
      window.clearTimeout(timer);
      seq++;
      back.remove();
      resolve(v);
    };
    const choose = (it: Item | undefined) => {
      if (!it) return;
      if (view === "maps") {
        void goPlaces(it);
        return;
      }
      if (insert) return done(it.code ?? codeOf(it.type, it.id));
      const href = safeHref(it.href);
      done(null);
      if (href) openHref(href, pid);
    };

    const paintTitle = () => {
      titleEl.textContent = view === "places" ? `${t("rp.places")}: ${mapName}` : view === "maps" ? t("rp.maps") : insert ? t("rp.title") : t("rp.titleSearch");
      crumb.hidden = view === "main";
      filters.hidden = view !== "main";
      input.setAttribute("aria-label", view === "main" ? t("rp.search") : view === "maps" ? t("rp.searchMap") : t("rp.searchPlace"));
      input.placeholder = view === "main" ? t("rp.searchPh") : view === "maps" ? t("rp.searchMapPh") : t("rp.searchPlacePh");
    };

    const paintList = () => {
      sel = Math.min(sel, Math.max(0, items.length - 1));
      list.innerHTML = items
        .map(
          (it, i) => `<li role="option" id="rp-o-${i}" class="rp-item ${i === sel ? "sel" : ""}" aria-selected="${i === sel}" data-i="${i}">
            ${icon(it.type === "map" ? "map" : REF_ICON[it.type] ?? "help", 16)}
            <span class="rp-main"><span class="rp-label">${esc(it.label)}</span>${it.sub ? `<span class="rp-sub muted">${esc(it.sub)}</span>` : ""}${
              it.snippet ? `<span class="rp-snip">${esc(it.snippet)}</span>` : ""
            }</span>
            <span class="rp-kind muted">${it.type === "map" ? "" : esc(t("ref.type." + it.type))}</span></li>`,
        )
        .join("");
      input.setAttribute("aria-activedescendant", items.length ? `rp-o-${sel}` : "");
    };
    const select = (i: number, scroll = true) => {
      if (!items.length) return;
      sel = (i + items.length) % items.length;
      list.querySelectorAll<HTMLElement>(".rp-item").forEach((li, k) => {
        li.classList.toggle("sel", k === sel);
        li.setAttribute("aria-selected", String(k === sel));
      });
      input.setAttribute("aria-activedescendant", `rp-o-${sel}`);
      if (scroll) list.querySelector<HTMLElement>(".rp-item.sel")?.scrollIntoView({ block: "nearest" });
    };
    const show = (next: Item[], msg = "") => {
      items = next;
      sel = 0;
      paintList();
      status.textContent = msg || (next.length ? "" : t("rp.none"));
    };

    // Durchsuchen ohne Suchbegriff (genau ein Typ gewählt): Liste aus den vorhandenen Endpunkten
    const browse = async (ty: string): Promise<Item[]> => {
      const hit = browseCache.get(ty);
      if (hit) return hit;
      let out: Item[] = [];
      if (ty === "doc") {
        const spaces: ("public" | "builder")[] = o.isBuilder ? ["public", "builder"] : ["public"];
        const all = await Promise.all(spaces.map((s) => api.projectDocs(pid, s).catch(() => [])));
        out = all.flatMap((ds, k) =>
          ds.filter((d) => d.kind === "doc").map((d) => ({ type: "doc", id: d.id, label: d.name, sub: t("proj.tab." + (spaces[k] === "builder" ? "builder" : "public")) })),
        );
      } else if (ty === "task") {
        out = (await api.projectTasks(pid)).map((x) => ({ type: "task", id: x.id, label: x.title, sub: t("proj.col." + x.status) }));
      } else if (ty === "plan") {
        out = (await api.projectPlans(pid)).map((p) => ({ type: "plan", id: p.id, label: p.name }));
      } else if (ty === "note") {
        out = (await api.projectNotes(pid)).map((n) => ({ type: "note", id: n.id, label: (n.text.trim().split("\n")[0] || t("rp.emptyNote")).slice(0, 80) }));
      } else if (ty === "img") {
        const spaces: ("public" | "builder")[] = o.isBuilder ? ["public", "builder"] : ["public"];
        const all = await Promise.all(spaces.map((s) => api.projectImages(pid, s).catch(() => [])));
        out = all.flat().map((i) => ({ type: "img", id: i.id, label: i.caption || i.filename, sub: i.plan_name }));
      }
      out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      browseCache.set(ty, out);
      return out;
    };

    const run = async () => {
      const q = input.value.trim();
      const my = ++seq;
      if (view !== "main") {
        const src = view === "maps" ? maps : placeItems;
        const ql = q.toLowerCase();
        const hits = src.filter((x) => !ql || x.label.toLowerCase().includes(ql));
        show(hits.slice(0, MAX_SHOWN), hits.length > MAX_SHOWN ? t("rp.more").replace("{n}", String(hits.length)) : "");
        return;
      }
      try {
        if (q.length < 2) {
          if (insert && active.size === 1) {
            status.textContent = t("common.loading");
            const r = await browse([...active][0]);
            if (my !== seq) return;
            show(r.slice(0, MAX_SHOWN), r.length > MAX_SHOWN ? t("rp.more").replace("{n}", String(r.length)) : "");
          } else show([], t("rp.hintMin"));
          return;
        }
        status.textContent = t("common.loading");
        const r = await refApi.search(pid, q, { types: active.size ? [...active] : undefined, limit: 30 });
        if (my !== seq) return;
        show(r.filter((x) => x.ok !== false).map((x) => ({ type: x.type, id: x.id, label: x.label, sub: x.sub, snippet: x.snippet, href: x.href })));
      } catch (e) {
        if (my === seq) show([], e instanceof Error ? e.message : String(e));
      }
    };
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), view === "main" ? 250 : 0);
    };

    // Untermenü Karten → Orte
    let placeItems: Item[] = [];
    const goMaps = async () => {
      view = "maps";
      input.value = "";
      paintTitle();
      status.textContent = t("common.loading");
      try {
        const ms = await api.maps();
        maps = ms.filter((m) => m.status === "ready").map((m) => ({ type: "map", id: m.id, label: m.name }));
        if (!maps.length) show([], t("rp.noMaps"));
        else await run();
      } catch (e) {
        show([], e instanceof Error ? e.message : String(e));
      }
      input.focus();
    };
    const goPlaces = async (m: Item) => {
      view = "places";
      mapId = m.id;
      mapName = m.label;
      input.value = "";
      paintTitle();
      status.textContent = t("common.loading");
      try {
        placeItems = await loadPlaces(mapId);
        await run();
        if (!placeItems.length) show([], t("rp.noPlaces"));
      } catch (e) {
        placeItems = [];
        show([], e instanceof Error ? e.message : String(e));
      }
      input.focus();
    };
    const goBack = () => {
      if (view === "places") return void goMaps();
      view = "main";
      input.value = "";
      paintTitle();
      void run();
      input.focus();
    };

    // Ereignisse
    input.addEventListener("input", later);
    filters.querySelectorAll<HTMLElement>("[data-type]").forEach((b) =>
      b.addEventListener("click", () => {
        const ty = b.dataset.type!;
        // Einzelauswahl: ein Typ schließt die anderen aus; erneut klicken = kein Filter (Suche über alles im Projekt)
        const was = active.has(ty);
        active.clear();
        if (!was) active.add(ty);
        filters.querySelectorAll<HTMLElement>("[data-type]").forEach((x) => {
          const on = active.has(x.dataset.type!);
          x.setAttribute("aria-pressed", String(on));
          x.classList.toggle("on", on);
        });
        void run();
      }),
    );
    filters.querySelector("[data-places]")?.addEventListener("click", () => void goMaps());
    crumb.querySelector("[data-back]")!.addEventListener("click", goBack);
    $("[data-close]").addEventListener("click", () => done(null));
    back.addEventListener("mousedown", (e) => e.target === back && done(null));
    list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>(".rp-item");
      if (li) choose(items[Number(li.dataset.i)]);
    });
    list.addEventListener("mousemove", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>(".rp-item");
      if (li && Number(li.dataset.i) !== sel) select(Number(li.dataset.i), false);
    });
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (view === "main") done(null);
        else goBack();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        select(sel + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter" && e.target === input) {
        e.preventDefault(); // der Fokus-Rückgabe-Knopf soll den Tastendruck nicht noch einmal erhalten
        window.clearTimeout(timer);
        choose(items[sel]);
      } else if ((e.key === "PageDown" || e.key === "PageUp") && items.length) {
        e.preventDefault();
        select(Math.max(0, Math.min(items.length - 1, sel + (e.key === "PageDown" ? 8 : -8))));
      }
    });

    paintTitle();
    void run();
    setTimeout(() => input.focus(), 0);
  });
}
