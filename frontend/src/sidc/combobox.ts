// Durchsuchbares Dropdown: Trigger-Button + Popup mit Suchfeld ganz oben.
// Für die Marker-Auswahl (Kategorie/Marker/Modifier) im Marker-Baukasten.
import { t } from "../i18n";
import { esc } from "../esc";

export interface ComboItem {
  value: string;
  label: string;
  icon?: string;
  sub?: string;
}

export interface Combobox {
  el: HTMLElement;
  get(): string;
  set(value: string): void;
  setItems(items: ComboItem[]): void;
}

export function combobox(
  items: ComboItem[],
  opts: { value?: string; placeholder?: string },
  onChange: (value: string) => void,
): Combobox {
  let list = items;
  let value = opts.value ?? "";

  const el = document.createElement("div");
  el.className = "cbx";
  el.innerHTML = `
    <button type="button" class="cbx-trigger"></button>
    <div class="cbx-pop" hidden>
      <input class="cbx-search" placeholder="${t("wiz.search")}" />
      <ul class="cbx-list"></ul>
    </div>`;
  const trigger = el.querySelector<HTMLButtonElement>(".cbx-trigger")!;
  const pop = el.querySelector<HTMLDivElement>(".cbx-pop")!;
  const search = el.querySelector<HTMLInputElement>(".cbx-search")!;
  const ul = el.querySelector<HTMLUListElement>(".cbx-list")!;

  const paintTrigger = () => {
    const it = list.find((i) => i.value === value);
    trigger.innerHTML = it
      ? `${it.icon ? `<img src="${esc(it.icon)}" alt="" data-hide-on-error/>` : ""}<span>${esc(it.label)}</span>`
      : `<span class="muted">${esc(opts.placeholder ?? "…")}</span>`;
  };
  const paintList = () => {
    const q = search.value.trim().toLowerCase();
    ul.innerHTML = list
      .filter((i) => !q || i.label.toLowerCase().includes(q) || (i.sub ?? "").toLowerCase().includes(q))
      .slice(0, 300)
      .map(
        (i) => `<li data-v="${encodeURIComponent(i.value)}" class="${i.value === value ? "sel" : ""}">
          ${i.icon ? `<img src="${esc(i.icon)}" alt="" data-hide-on-error/>` : ""}
          <span class="cbx-lbl">${esc(i.label)}</span>${i.sub ? `<span class="cbx-sub">${esc(i.sub)}</span>` : ""}
        </li>`,
      )
      .join("");
  };
  const open = () => {
    pop.hidden = false;
    search.value = "";
    paintList();
    search.focus();
  };
  const closePop = () => {
    pop.hidden = true;
  };

  trigger.addEventListener("click", () => (pop.hidden ? open() : closePop()));
  search.addEventListener("input", paintList);
  ul.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (!li) return;
    value = decodeURIComponent(li.dataset.v!);
    paintTrigger();
    closePop();
    onChange(value);
  });
  document.addEventListener("click", (e) => {
    if (!el.contains(e.target as Node)) closePop();
  });

  paintTrigger();
  return {
    el,
    get: () => value,
    set: (v) => {
      value = v;
      paintTrigger();
    },
    setItems: (next) => {
      list = next;
      if (!list.some((i) => i.value === value)) value = "";
      paintTrigger();
      if (!pop.hidden) paintList();
    },
  };
}
