# Manuelle Schritte (Sicherheit)

Stand 2026-09-10 nach dem Audit. Fast alles erledigt — Rest unten unter „Offen".

---

## ✅ Erledigt

### 1. `.env` in Produktion gehärtet
- `COOKIE_SECURE=true` gesetzt (Zugang läuft ausschließlich über den Nginx-Proxy / HTTPS)
- `SECRET_KEY` fest gesetzt · `FORWARDED_ALLOW_IPS=192.168.1.100` · `BOOTSTRAP_ADMIN_PASSWORD` rotiert
- `SECRET_KEY` + Bootstrap-PW wurden nach versehentlicher Chat-Exposition rotiert

### 2. Security-Header am Nginx Proxy Manager
Alter funktionaler Block (`client_max_body_size`, `proxy_*_timeout` für WebSockets,
`proxy_request_buffering off`) + Security-Zeilen (HSTS, `proxy_hide_header X-Powered-By`)
in der Custom-Nginx-Config, `Force SSL` + `HTTP/2` + `HSTS` im SSL-Tab.
Die App setzt CSP / `X-Frame-Options` / `nosniff` / HSTS zusätzlich selbst
(`backend/app/main.py`).

### 3. maplibre-gl v5 → v6.9.0
Commit `7670040`, deployt + live durchgetestet (Karte, Marker, Linien, 2D/3D +
Würfel, Hover-Popup, Live-Sync, öffentliche Ansicht — keine CSP-Verstöße).
Behebt GHSA-jrc7-96c5-q579.

### 4. jspdf v2 → v4.2.1
Commit `6225d2f`. `npm audit` jetzt **0 vulnerabilities**. Nur Core-API genutzt
(kein `html()`/AcroForm), in v4 unverändert.

---

## Offen (niedrige Priorität, optional)

### Datenschutz / Betrieb
- **Audit-Log wächst unbegrenzt** und speichert Client-IPs. Bei Bedarf einen
  Cron/SQL-Job ergänzen, der Einträge älter als N Tage löscht.
- **Backups** (`deploy/backup.sh`) liegen unverschlüsselt im Volume `backups`.
  Für Offsite-Kopien verschlüsseln (z. B. `age`/`gpg`).

### Wenn Multi-Worker
Der Login-Rate-Limiter (`backend/app/ratelimit.py`) ist In-Process und nur bei
**einem** uvicorn-Worker korrekt. Vor `--workers > 1` auf Redis umstellen
(INCR + EXPIRE) — Redis ist im Stack schon vorhanden.
