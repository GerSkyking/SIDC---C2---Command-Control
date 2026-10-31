// @-Erwähnungen: Autovervollständigung für Textfelder + Darstellung erwähnter Namen.
import { type Mentionable } from "./api";
import { esc } from "./esc";
import { t } from "./i18n";

export interface MentionRef {
  type: "user" | "group" | "project";
  id: string;
  token: string;
}

/**
 * Hängt eine @-Autovervollständigung an ein Textfeld: Tippen von „@“ öffnet eine Liste mit Nutzern,
 * Gruppen und (falls vorhanden) @projekt. ↑/↓ wählen, Enter/Tab übernimmt, Esc schließt nur die Liste.
 */
export function attachMentions(ta: HTMLTextAreaElement, getCandidates: () => Mentionable[]): void {
  const pop = document.createElement("div");
  pop.className = "mention-pop";
  pop.hidden = true;
  pop.setAttribute("role", "listbox");
  ta.insertAdjacentElement("afterend", pop);
  let items: Mentionable[] = [];
  let sel = 0;
  let start = -1;

  const close = () => {
    pop.hidden = true;
    start = -1;
  };
  const paint = () => {
    pop.innerHTML = items
      .map((c, i) => {
        const icon = c.type === "group" ? "👥" : c.type === "project" ? "📁" : "@";
        const lbl = c.type === "project" ? t("mention.project") : c.label;
        return `<button type="button" role="option" class="mention-i${i === sel ? " sel" : ""}" data-i="${i}">
          <span class="mention-ic">${icon}</span><span>${esc(lbl)}</span><span class="muted">@${esc(c.handle)}</span></button>`;
      })
      .join("");
    pop.hidden = items.length === 0;
    pop.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };
  const pick = (c: Mentionable) => {
    if (start < 0) return;
    const end = ta.selectionStart;
    const ins = `@${c.handle} `;
    ta.setRangeText(ins, start, end, "end");
    close();
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const update = () => {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = /(?:^|[\s(])@([^\s@]*)$/.exec(before);
    if (!m) return close();
    start = pos - m[1].length - 1;
    const q = m[1].toLowerCase();
    items = getCandidates()
      .filter((c) => !q || c.handle.includes(q) || c.label.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.handle.startsWith(q)) - Number(!b.handle.startsWith(q)))
      .slice(0, 8);
    sel = 0;
    paint();
  };

  ta.addEventListener("input", update);
  ta.addEventListener("click", update);
  ta.addEventListener("blur", () => setTimeout(close, 150));
  ta.addEventListener("keydown", (e) => {
    if (pop.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      paint();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      pick(items[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // schließt nur die Liste, nicht den Dialog
      close();
    }
  });
  pop.addEventListener("mousedown", (e) => {
    e.preventDefault(); // Fokus im Textfeld behalten
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (b) pick(items[Number(b.dataset.i)]);
  });
}

/** Text sicher darstellen; erkannte Erwähnungen (laut `mentions`) werden hervorgehoben. */
export function renderMentionText(text: string, mentions: MentionRef[]): string {
  const known = new Set(mentions.map((m) => m.token.toLowerCase()));
  return esc(text).replace(/(^|[\s(])@([^\s@,;:!?()[\]<>"']+)/g, (all, pre: string, tok: string) => {
    const bare = tok.replace(/\.+$/, "");
    if (!known.has(bare.toLowerCase())) return all;
    const rest = tok.slice(bare.length);
    return `${pre}<span class="mention">@${bare}</span>${rest}`;
  });
}
