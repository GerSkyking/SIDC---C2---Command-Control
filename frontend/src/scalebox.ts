// Einklappbare "UI Scale"-Box (Marker-/Textgröße): Kopfzeile klappt den Inhalt ein/aus, Zustand wird gemerkt.
const KEY = "sidc_scalebox_collapsed";

export function wireScaleBox(root: HTMLElement): void {
  const box = root.querySelector<HTMLElement>("#mkScale");
  const head = box?.querySelector<HTMLButtonElement>(".mk-scale-head");
  if (!box || !head) return;
  const apply = (collapsed: boolean): void => {
    box.classList.toggle("collapsed", collapsed);
    head.setAttribute("aria-expanded", String(!collapsed));
    head.querySelector(".chev")!.textContent = collapsed ? "▸" : "▾";
  };
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(KEY) === "1";
  } catch {
    /* ignore */
  }
  apply(collapsed);
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    apply(collapsed);
    try {
      localStorage.setItem(KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  });
}
