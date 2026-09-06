// Phase 0: Platzhalter-Shell. Ab Phase 4 kommen Login-Seite, Karten-/Plan-Picker
// und das portierte sidc-marker-Modul hier rein.

async function boot(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;

  let health = "unreachable";
  try {
    const res = await fetch("/healthz");
    health = res.ok ? (await res.json()).status : `http ${res.status}`;
  } catch {
    /* backend nicht erreichbar */
  }

  app.innerHTML = `
    <main style="font-family: system-ui; padding: 2rem; max-width: 40rem; margin: 0 auto">
      <h1>SIDC – C2 – Command &amp; Control</h1>
      <p>Grundgerüst (Phase 0). Backend-Status: <strong>${health}</strong></p>
    </main>`;
}

void boot();
