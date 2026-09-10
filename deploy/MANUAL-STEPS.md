# Manuelle Schritte (Sicherheit) — vom Nutzer auszuführen

Diese Punkte kann/soll Claude nicht blind erledigen (Deploy-Umgebung, `.env`,
Browser-Test nötig). Reihenfolge nach Dringlichkeit.

---

## 1. `.env` in Produktion härten

In `deploy/.env` auf dem Server setzen:

```ini
# Cookies immer mit Secure-Flag (TLS terminiert am Nginx Proxy Manager):
COOKIE_SECURE=true

# Signierschlüssel EINMALIG fest setzen (nicht leer lassen), damit er bei
# Volume-Verlust nicht neu generiert wird und alle Sessions/Reset-Links kippen:
SECRET_KEY=<64+ Zufallszeichen, z. B. `openssl rand -base64 48`>

# Muss die IP/Range des Nginx Proxy Manager sein (schon gesetzt — prüfen):
FORWARDED_ALLOW_IPS=192.168.1.100

# Bootstrap-Passwort auf einen echten Wert ändern und danach im Admin-UI
# ein neues setzen (mind. 12 Zeichen):
BOOTSTRAP_ADMIN_PASSWORD=<stark>
```

Nach Änderung: `docker compose up -d`.

---

## 2. Security-Header am Nginx Proxy Manager (Redundanz + HSTS-Preload)

Die App setzt CSP/HSTS/X-Frame-Options selbst (siehe `backend/app/main.py`).
Zusätzlich im NPM-Proxy-Host unter **Advanced → Custom Nginx Configuration**:

```nginx
# HTTP -> HTTPS erzwingen ist im NPM-Tab "SSL" via "Force SSL" zu aktivieren.
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
proxy_hide_header X-Powered-By;
```

`Force SSL` + `HTTP/2` + `HSTS Enabled` im SSL-Tab anhaken.

---

## 3. maplibre-gl auf v6 aktualisieren — ⚠️ kritische XSS-Lücke in ≤ 6.4.0

`npm audit` meldet **critical**: *MapLibre GL JS — XSS Sanitizer Bypass in
`DOM.sanitize()`* (GHSA-jrc7-96c5-q579). Aktuell im Projekt: `maplibre-gl ^5.6.0`.
Der Fix ist `maplibre-gl@^6.9.0` — **Breaking Change (v5 → v6)**, deshalb nicht
automatisch mit eingespielt.

Vorgehen (lokal, mit Browser-Test):

```bash
cd frontend
npm install maplibre-gl@^6
npm run build
npm run dev   # und im Browser durchklicken:
```

Test-Checkliste nach dem Upgrade:
- [ ] Karte lädt (Sat/Grid/Terrain-Layer)
- [ ] Marker setzen / verschieben / bearbeiten
- [ ] Linien zeichnen + Phase-Lines
- [ ] 2D/3D-Umschalter + Navigations-Würfel
- [ ] Hover-Popup am Marker
- [ ] Öffentliche Ansicht (`#/p/<token>`)
- [ ] Screenshot-Funktion
- [ ] Browser-Konsole ohne CSP-Verstöße (siehe Punkt 4)

Migrations-Hinweise MapLibre v5 → v6:
<https://maplibre.org/maplibre-gl-js/docs/> → „Migration". Häufig betroffen:
`map.on("styleimagemissing")`, `setTerrain`, `getCanvas`-Timing, entfernte
Events. Bei Problemen die Änderung isoliert committen, damit man sie zurückrollen
kann.

> `jspdf`/`dompurify`-Advisory (moderate): betrifft nur `jspdf.html()`. Die
> Briefing-Export-Funktion nutzt nur `doc.text()` → **nicht ausnutzbar**, Upgrade
> auf jspdf 4 (ebenfalls breaking) optional / niedrige Priorität.

---

## 4. CSP im Browser verifizieren

Nach dem nächsten Deploy die App öffnen, DevTools → Konsole. Bei Meldungen wie
`Refused to … because it violates the following Content Security Policy directive`
kurz melden — dann muss die Direktive in `backend/app/main.py` (`_CSP`) gezielt
erweitert werden (z. B. `worker-src`/`img-src`). Die Policy ist bewusst streng
(kein `unsafe-inline` bei Scripts).

---

## 5. Datenschutz / Betrieb (optional, niedrige Priorität)

- **Audit-Log wächst unbegrenzt** und speichert Client-IPs. Bei Bedarf einen
  Cron/SQL-Job ergänzen, der Einträge älter als N Tage löscht.
- **Backups** (`deploy/backup.sh`) liegen unverschlüsselt im Volume `backups`.
  Für Offsite-Kopien verschlüsseln (z. B. `age`/`gpg`).
