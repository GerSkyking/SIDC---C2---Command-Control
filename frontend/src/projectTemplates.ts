// Datei-Vorlagen und Dokumenttypen des Missionsbaus (doc_type). Inhalte stehen in i18n (tpl.body.<typ>, "{title}" = Dateiname).
import type { ProjectSpace } from "./api";
import { esc } from "./esc";
import { t } from "./i18n";
import { a11yModal } from "./notify";

export const DOC_TYPES = ["mission", "opord", "briefing", "character", "faction", "place", "scene"] as const;
export type DocType = "" | (typeof DOC_TYPES)[number];

/** Icon je Dokumenttyp (Dateibaum, Verzeichnis) */
export const DOC_TYPE_ICON: Record<string, string> = {
  mission: "compass",
  opord: "tactical",
  briefing: "present",
  character: "users",
  faction: "groups",
  place: "marker",
  scene: "camera",
};

export const isDocType = (v: string | null | undefined): v is DocType => v === "" || DOC_TYPES.includes(v as (typeof DOC_TYPES)[number]);
export const docTypeLabel = (ty: string | undefined): string => (ty ? t("dt." + ty) : t("dt.none"));

/** Startinhalt einer Vorlage (leer = nur Überschrift). */
export function templateContent(type: DocType, title: string): string {
  if (!type) return `# ${title}\n\n`;
  return t("tpl.body." + type).replace(/\{title\}/g, title).replace(/\r\n?/g, "\n");
}

export interface NewDocChoice {
  name: string;
  type: DocType;
  space: ProjectSpace;
}

/**
 * Dialog „Neue Datei": Name + Vorlage (+ optional Bereich). Rückgabe null = abgebrochen.
 * `type` = vorgewählte Vorlage; `spaces` zeigt die Bereichsauswahl (nur Missionsbauer).
 */
export function askNewDoc(opts: { type?: DocType; spaces?: boolean; space?: ProjectSpace } = {}): Promise<NewDocChoice | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "edit-modal";
    const sel = opts.type ?? "";
    back.innerHTML = `<div class="card stack" style="width:min(28rem,94vw)">
      <h1 style="margin:0;font-size:1.05rem">${t("tpl.title")}</h1>
      <div class="field"><label class="muted" for="nd-n">${t("tpl.name")}</label>
        <input id="nd-n" maxlength="120" autocomplete="off" placeholder="${esc(t("proj.docs.namePhDoc"))}" /></div>
      <div class="field"><label class="muted" for="nd-t">${t("tpl.template")}</label>
        <select id="nd-t">${["", ...DOC_TYPES]
          .map((ty) => `<option value="${ty}" ${ty === sel ? "selected" : ""}>${ty ? t("dt." + ty) : t("tpl.empty")}</option>`)
          .join("")}</select>
        <small class="muted" id="nd-h" role="note"></small></div>
      ${
        opts.spaces
          ? `<div class="field"><label class="muted" for="nd-s">${t("tpl.space")}</label>
              <select id="nd-s"><option value="public" ${opts.space !== "builder" ? "selected" : ""}>${t("proj.tab.public")}</option>
              <option value="builder" ${opts.space === "builder" ? "selected" : ""}>${t("proj.tab.builder")}</option></select></div>`
          : ""
      }
      <p class="error" id="nd-e" role="alert" hidden></p>
      <div class="row" style="justify-content:flex-end;gap:.5rem">
        <button data-c>${t("common.cancel")}</button>
        <button class="primary" data-ok>${t("tpl.create")}</button>
      </div></div>`;
    document.body.appendChild(back);
    a11yModal(back, t("tpl.title"));
    const nameEl = back.querySelector<HTMLInputElement>("#nd-n")!;
    const typeEl = back.querySelector<HTMLSelectElement>("#nd-t")!;
    const hint = back.querySelector<HTMLElement>("#nd-h")!;
    const paintHint = () => (hint.textContent = typeEl.value ? t("tpl.hint." + typeEl.value) : t("tpl.hint.empty"));
    typeEl.addEventListener("change", paintHint);
    paintHint();
    const done = (v: NewDocChoice | null) => {
      back.remove();
      resolve(v);
    };
    const ok = () => {
      const name = nameEl.value.trim();
      if (!name) {
        nameEl.classList.add("invalid");
        const e = back.querySelector<HTMLElement>("#nd-e")!;
        e.textContent = t("tpl.needName");
        e.hidden = false;
        nameEl.focus();
        return;
      }
      const ty = typeEl.value;
      done({ name, type: isDocType(ty) ? ty : "", space: back.querySelector<HTMLSelectElement>("#nd-s")?.value === "builder" ? "builder" : "public" });
    };
    back.addEventListener("mousedown", (e) => e.target === back && done(null));
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
        e.preventDefault(); // der Fokus-Rückgabe-Knopf soll den Tastendruck nicht noch einmal erhalten
        ok();
      }
    });
    back.querySelector("[data-c]")!.addEventListener("click", () => done(null));
    back.querySelector("[data-ok]")!.addEventListener("click", ok);
    setTimeout(() => nameEl.focus(), 0);
  });
}
