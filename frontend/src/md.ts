// Minimaler, sicherer Markdown-Renderer (kein innerHTML aus Roh-Eingabe):
// erst HTML-escapen, dann eine Teilmenge von Markdown zu Tags umschreiben.
// Abgedeckt: Überschriften, **fett**, *kursiv*, ~~durchgestrichen~~, ==hervorgehoben==,
// `code`, ``` Codeblöcke, - / 1. Listen (verschachtelt, auch - [ ] Aufgaben), > Zitat,
// > [!note] Hinweise (Callouts), | Tabellen |, $Mathe$ / $$-Blöcke, %%Kommentare%%,
// [text](url), Trennlinie, Absätze.

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  // Code- und Mathe-Spans zuerst herauslösen, damit darin nichts weiter umgeschrieben wird
  const keep: string[] = [];
  const hold = (html: string): string => {
    keep.push(html);
    return `\u0000${keep.length - 1}\u0000`;
  };
  let r = esc(s)
    .replace(/%%[^%]*%%/g, "")
    .replace(/&lt;!--[\s\S]*?--&gt;/g, "")
    .replace(/`([^`]+)`/g, (_m, c: string) => hold(`<code>${c}</code>`))
    .replace(/\$([^$\s](?:[^$]*?[^$\s])?)\$(?!\d)/g, (_m, c: string) => hold(`<span class="md-math">${c}</span>`));
  r = r
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/==([^=]+)==/g, "<mark>$1</mark>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Bild-Verweis auf die Bild-Sidebar: {{img:<32-hex>}} -> klickbarer Chip.
    // Der Text wird nach dem Rendern per wireNoteImageRefs() ergänzt.
    .replace(
      /\{\{img:([0-9a-f]{32})\}\}/g,
      '<a class="note-img-ref" data-img="$1" href="#" role="button">\u{1F5BC}︎</a>',
    );
  return r.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => keep[Number(i)]);
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-") && line.includes("|");

const indentOf = (ws: string): number => ws.replace(/\t/g, "    ").length;

export function renderMarkdown(src: string): string {
  const lines = (src || "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  // Listen-Stapel: je Ebene Typ, Einrückung und ob das aktuelle <li> noch offen ist
  const stack: { type: "ul" | "ol"; indent: number; liOpen: boolean }[] = [];
  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      const top = stack.pop()!;
      if (top.liOpen) out.push("</li>");
      out.push(`</${top.type}>`);
    }
  };
  const closeList = () => closeTo(0);
  let inCode = false;
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        closeList();
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(esc(raw));
      continue;
    }
    // Kommentar-Block: %% … %% über mehrere Zeilen
    if (raw.trim() === "%%") {
      inComment = !inComment;
      continue;
    }
    if (inComment) continue;
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      // Leerzeile = sichtbarer Absatz-Abstand (sonst gingen Absätze verloren)
      if (out.length) out.push('<div class="md-gap"></div>');
      continue;
    }
    // Mathe-Block: $$ … $$ (eigene Zeilen) oder $$formel$$ in einer Zeile
    const mOne = line.trim().match(/^\$\$(.+)\$\$$/);
    if (mOne) {
      closeList();
      out.push(`<div class="md-math md-math-block">${esc(mOne[1].trim())}</div>`);
      continue;
    }
    if (line.trim() === "$$") {
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") body.push(esc(lines[i++]));
      out.push(`<div class="md-math md-math-block">${body.join("<br>")}</div>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line.replace(/\s/g, ""))) {
      closeList();
      out.push("<hr/>");
      continue;
    }
    const li = line.match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/);
    if (li) {
      const want = li[2] ? "ul" : "ol";
      const ind = indentOf(li[1]);
      let body = li[4];
      let cls = "";
      let box = "";
      const task = body.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        cls = ' class="md-task"';
        box = `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}/> `;
        body = task[2];
      }
      // Ebene bestimmen
      while (stack.length && ind < stack[stack.length - 1].indent) closeTo(stack.length - 1);
      const top = stack[stack.length - 1];
      if (!top || ind > top.indent) {
        out.push(`<${want}>`);
        stack.push({ type: want, indent: ind, liOpen: false });
      } else if (top.type !== want) {
        closeTo(stack.length - 1);
        out.push(`<${want}>`);
        stack.push({ type: want, indent: ind, liOpen: false });
      } else if (top.liOpen) {
        out.push("</li>");
      }
      stack[stack.length - 1].liOpen = true;
      out.push(`<li${cls}>${box}${inline(body)}`);
      continue;
    }
    // Tabelle: Kopfzeile + Trennzeile + Zeilen
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "",
      );
      const al = (k: number) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : "");
      const rows: string[] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
        rows.push(
          `<tr>${cells(lines[j])
            .map((c, k) => `<td${al(k)}>${inline(c)}</td>`)
            .join("")}</tr>`,
        );
        j++;
      }
      out.push(
        `<table class="md-table"><thead><tr>${head.map((c, k) => `<th${al(k)}>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
      );
      i = j - 1;
      continue;
    }
    // Zitat / Hinweis: aufeinanderfolgende ">"-Zeilen zu einem Block
    if (/^>\s?/.test(line)) {
      closeList();
      const body: string[] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j].trimEnd())) {
        body.push(lines[j].trimEnd().replace(/^>\s?/, ""));
        j++;
      }
      i = j - 1;
      const co = body[0].match(/^\[!([A-Za-z]+)\][+-]?\s*(.*)$/);
      if (co) {
        const kind = co[1].toLowerCase();
        const title = co[2] || kind.charAt(0).toUpperCase() + kind.slice(1);
        const rest = body.slice(1).map((b) => inline(b)).join("<br>");
        out.push(
          `<div class="md-callout md-callout-${kind.replace(/[^a-z]/g, "")}"><div class="md-callout-title">${inline(title)}</div>${rest ? `<div>${rest}</div>` : ""}</div>`,
        );
      } else {
        out.push(`<blockquote>${body.map((b) => inline(b)).join("<br>")}</blockquote>`);
      }
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push("</code></pre>");
  closeList();
  while (out.length && out[out.length - 1] === '<div class="md-gap"></div>') out.pop();
  return out.join("\n");
}
