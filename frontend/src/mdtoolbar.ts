// Markdown-Toolbar für Textareas: ein Tastatur-Icon blendet eine Leiste mit allen
// Formatierungen ein/aus, damit man keine Syntax auswendig kennen muss.
// attachMdToolbar(ta) setzt die Leiste direkt über das Textfeld.

import { icon } from "./icons";
import { t } from "./i18n";

const KEY = "sidc_mdtb";

const loadOpen = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const saveOpen = (v: boolean): void => {
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* ignorieren */
  }
};

// Text im Feld ersetzen und dabei den Undo-Verlauf des Browsers erhalten
function replaceRange(ta: HTMLTextAreaElement, start: number, end: number, text: string, selStart: number, selEnd: number): void {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    ta.setRangeText(text, start, end, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  ta.setSelectionRange(selStart, selEnd);
}

// Auswahl mit Zeichen umschließen (bzw. wieder entfernen, wenn schon umschlossen)
function wrap(ta: HTMLTextAreaElement, before: string, after = before): void {
  const v = ta.value;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = v.slice(s, e);
  if (sel && v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    replaceRange(ta, s - before.length, e + after.length, sel, s - before.length, s - before.length + sel.length);
    return;
  }
  const body = sel || t("md.ph");
  replaceRange(ta, s, e, before + body + after, s + before.length, s + before.length + body.length);
}

// Zeilen der Auswahl: [Anfang, Ende) der betroffenen Zeilen
function lineSpan(ta: HTMLTextAreaElement): [number, number] {
  const v = ta.value;
  const a = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
  let b = v.indexOf("\n", ta.selectionEnd);
  if (b < 0) b = v.length;
  return [a, b];
}

// Präfix pro Zeile setzen/entfernen; strip entfernt vorhandene andere Präfixe der gleichen Art
function linePrefix(ta: HTMLTextAreaElement, make: (n: number) => string, strip: RegExp): void {
  const [a, b] = lineSpan(ta);
  const lines = ta.value.slice(a, b).split("\n");
  const own = (l: string, n: number): boolean => l.startsWith(make(n));
  const allOwn = make(1) !== "" && lines.every((l, k) => own(l, k + 1));
  const out = lines.map((l, k) => (allOwn ? l.slice(make(k + 1).length) : make(k + 1) + l.replace(strip, "")));
  const text = out.join("\n");
  replaceRange(ta, a, b, text, a, a + text.length);
}

// Block (eigene Zeilen) an der Cursor-Position einfügen
function insertBlock(ta: HTMLTextAreaElement, text: string, selFrom = 0, selLen = 0): void {
  const v = ta.value;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const pre = s > 0 && v[s - 1] !== "\n" ? "\n" : "";
  const post = e < v.length && v[e] !== "\n" ? "\n" : "";
  const base = s + pre.length;
  replaceRange(ta, s, e, pre + text + post, base + selFrom, base + selFrom + selLen);
}

const BULLET = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/;
const QUOTE = /^>\s?/;

type Btn = { id?: string; label: string; title: string; run: (ta: HTMLTextAreaElement) => void; cls?: string };

// Tabelle mit gewählter Spalten-/Zeilenzahl (Zeilen ohne Kopfzeile) einfügen
function insertTable(ta: HTMLTextAreaElement, cols: number, rows: number): void {
  const c = t("md.col");
  const row = (f: (k: number) => string) => "| " + Array.from({ length: cols }, (_, k) => f(k)).join(" | ") + " |";
  const lines = [row((k) => `${c} ${k + 1}`), row(() => "---"), ...Array.from({ length: rows }, () => row(() => " "))];
  insertBlock(ta, lines.join("\n"), 2, c.length + 2);
}

function buttons(): Btn[] {
  return [
    { label: "B", cls: "tb-b", title: t("md.bold"), run: (ta) => wrap(ta, "**") },
    { label: "I", cls: "tb-i", title: t("md.italic"), run: (ta) => wrap(ta, "*") },
    { label: "S", cls: "tb-s", title: t("md.strike"), run: (ta) => wrap(ta, "~~") },
    { label: "H", cls: "tb-h", title: t("md.mark"), run: (ta) => wrap(ta, "==") },
    { label: "&lt;/&gt;", title: t("md.code"), run: (ta) => wrap(ta, "`") },
    {
      label: "{ }",
      title: t("md.codeblock"),
      run: (ta) => {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        const body = sel || t("md.ph");
        insertBlock(ta, "```\n" + body + "\n```", 4, body.length);
      },
    },
    { label: "&#8721;", title: t("md.math"), run: (ta) => wrap(ta, "$") },
    {
      label: "$$",
      title: t("md.mathblock"),
      run: (ta) => {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        const body = sel || "x^2";
        insertBlock(ta, "$$\n" + body + "\n$$", 3, body.length);
      },
    },
    { label: "%%", title: t("md.comment"), run: (ta) => wrap(ta, "%%") },
    { label: "&bull;", title: t("md.ul"), run: (ta) => linePrefix(ta, () => "- ", BULLET) },
    { label: "1.", title: t("md.ol"), run: (ta) => linePrefix(ta, (n) => `${n}. `, BULLET) },
    { label: "&#9745;", title: t("md.task"), run: (ta) => linePrefix(ta, () => "- [ ] ", BULLET) },
    { label: "&rdquo;", title: t("md.quote"), run: (ta) => linePrefix(ta, () => "> ", QUOTE) },
    { label: "&mdash;", title: t("md.hr"), run: (ta) => insertBlock(ta, "---") },
    { label: "&#9638;", id: "table", title: t("md.table"), run: () => {} },
    {
      label: "&#10064;",
      title: t("md.dupRow"),
      run: (ta) => {
        const [a, b] = lineSpan(ta);
        const line = ta.value.slice(a, b);
        replaceRange(ta, b, b, "\n" + line, b + 1 + line.length, b + 1 + line.length);
      },
    },
    {
      label: "&#128279;",
      title: t("md.link"),
      run: (ta) => {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        const text = sel || t("md.ph");
        const s = ta.selectionStart;
        const url = "https://";
        replaceRange(ta, s, ta.selectionEnd, `[${text}](${url})`, s + text.length + 3, s + text.length + 3 + url.length);
      },
    },
  ];
}

const HEADINGS = [1, 2, 3, 4];
const CALLOUTS = ["note", "info", "tip", "success", "question", "warning", "danger", "quote"];

export function attachMdToolbar(ta: HTMLTextAreaElement): void {
  if (ta.readOnly || ta.dataset.mdtb) return;
  ta.dataset.mdtb = "1";
  const wrapEl = document.createElement("div");
  wrapEl.className = "mdtb";
  const bar = document.createElement("div");
  bar.className = "mdtb-bar";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "icon-btn mdtb-toggle";
  toggle.title = t("md.toggle");
  toggle.innerHTML = icon("keyboard", 14);

  const heads = document.createElement("select");
  heads.title = t("md.heading");
  heads.innerHTML =
    `<option value="">${t("md.heading")}</option>` +
    HEADINGS.map((n) => `<option value="${n}">${"#".repeat(n)} ${t("md.h")} ${n}</option>`).join("") +
    `<option value="0">${t("md.noHeading")}</option>`;
  heads.addEventListener("change", () => {
    const n = Number(heads.value);
    if (heads.value === "") return;
    linePrefix(ta, () => (n ? "#".repeat(n) + " " : ""), /^#{1,6}\s+/);
    heads.value = "";
  });
  const cos = document.createElement("select");
  cos.title = t("md.callout");
  cos.innerHTML =
    `<option value="">${t("md.callout")}</option>` +
    CALLOUTS.map((c) => `<option value="${c}">${t("md.co." + c)}</option>`).join("");
  cos.addEventListener("change", () => {
    if (!cos.value) return;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const head = `> [!${cos.value}] ${t("md.co." + cos.value)}\n> `;
    const body = sel ? sel.split("\n").join("\n> ") : t("md.ph");
    insertBlock(ta, head + body, head.length, body.length);
    cos.value = "";
  });

  // Buttons nehmen dem Textfeld den Fokus nicht weg
  bar.addEventListener("mousedown", (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag !== "SELECT" && tag !== "INPUT") e.preventDefault();
  });
  bar.append(heads);
  for (const b of buttons()) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "mdtb-btn" + (b.cls ? " " + b.cls : "");
    el.title = b.title;
    el.innerHTML = b.label;
    if (b.id === "table") {
      const pop = document.createElement("span");
      pop.className = "mdtb-pop";
      pop.hidden = true;
      pop.innerHTML =
        `<label>${t("md.cols")} <input type="number" min="1" max="12" value="3" data-c/></label>` +
        `<label>${t("md.rows")} <input type="number" min="1" max="50" value="2" data-r/></label>` +
        `<button type="button" class="mdtb-btn" data-ok>${t("md.insert")}</button>`;
      el.addEventListener("click", () => (pop.hidden = !pop.hidden));
      pop.querySelector("[data-ok]")!.addEventListener("click", () => {
        const n = (sel: string, max: number) =>
          Math.min(max, Math.max(1, Math.floor(Number(pop.querySelector<HTMLInputElement>(sel)!.value)) || 1));
        insertTable(ta, n("[data-c]", 12), n("[data-r]", 50));
        pop.hidden = true;
      });
      bar.append(el, pop);
      continue;
    }
    el.addEventListener("click", () => b.run(ta));
    bar.append(el);
  }
  bar.append(cos);

  const apply = (open: boolean): void => {
    bar.hidden = !open;
    toggle.classList.toggle("on", open);
  };
  apply(loadOpen());
  toggle.addEventListener("click", () => {
    const open = bar.hidden;
    saveOpen(open);
    document.querySelectorAll<HTMLElement>(".mdtb").forEach((w) => {
      w.querySelector<HTMLElement>(".mdtb-bar")!.hidden = !open;
      w.querySelector(".mdtb-toggle")!.classList.toggle("on", open);
    });
  });

  const head = document.createElement("div");
  head.className = "mdtb-head";
  head.append(toggle, bar);
  ta.before(wrapEl);
  wrapEl.append(head, ta);
}
