// Vollbild-Bildbetrachter. Wird von der Plan-Bild-Sidebar, den Notiz-Bild-Chips
// und der öffentlichen Ansicht genutzt. Keine Abhängigkeiten.
import { icon } from "./icons";
import { t } from "./i18n";

export interface LightboxItem {
  url: string;
  caption?: string;
}

let open: HTMLElement | null = null;

export function openLightbox(items: LightboxItem[], start = 0): void {
  closeLightbox();
  if (!items.length) return;
  let idx = Math.max(0, Math.min(start, items.length - 1));

  const back = document.createElement("div");
  back.className = "lightbox";
  back.innerHTML = `
    <button class="lb-x" title="${t("lightbox.close")}">${icon("x", 20)}</button>
    ${items.length > 1 ? `<button class="lb-nav lb-prev">${icon("back", 24)}</button>` : ""}
    <figure class="lb-fig">
      <img class="lb-img" alt="" />
      <figcaption class="lb-cap"></figcaption>
    </figure>
    ${items.length > 1 ? `<button class="lb-nav lb-next">${icon("chevron", 24)}</button>` : ""}`;

  const img = back.querySelector<HTMLImageElement>(".lb-img")!;
  const cap = back.querySelector<HTMLElement>(".lb-cap")!;
  const show = () => {
    const it = items[idx];
    img.src = it.url;
    cap.textContent = it.caption || "";
    cap.hidden = !it.caption;
  };
  const step = (d: number) => {
    idx = (idx + d + items.length) % items.length;
    show();
  };

  back.querySelector(".lb-x")!.addEventListener("click", closeLightbox);
  back.querySelector(".lb-prev")?.addEventListener("click", (e) => {
    e.stopPropagation();
    step(-1);
  });
  back.querySelector(".lb-next")?.addEventListener("click", (e) => {
    e.stopPropagation();
    step(1);
  });
  back.addEventListener("click", (e) => {
    // Klick auf Backdrop oder neben das Bild schließt; Klick aufs Bild selbst nicht.
    const el = e.target as HTMLElement;
    if (el === back || el.classList.contains("lb-fig")) closeLightbox();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  };
  document.addEventListener("keydown", onKey, true);
  (back as unknown as { _cleanup: () => void })._cleanup = () =>
    document.removeEventListener("keydown", onKey, true);

  document.body.appendChild(back);
  open = back;
  show();
}

export function closeLightbox(): void {
  if (!open) return;
  (open as unknown as { _cleanup?: () => void })._cleanup?.();
  open.remove();
  open = null;
}
