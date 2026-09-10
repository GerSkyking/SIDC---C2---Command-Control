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

## 3. maplibre-gl v6 — Code-Upgrade erledigt, nur noch Browser-Test + Deploy

**Status:** Commit `7670040` — `maplibre-gl` ist auf `^6.9.0` (behebt die kritische
XSS-Lücke GHSA-jrc7-96c5-q579). Import auf ESM-Namespace umgestellt, Hover-Popup
auf `setDOMContent` (kein Sanitizer-Pfad mehr). `tsc` + `vite build` grün.
**Noch NICHT deployed** — erst nach deinem lokalen Durchklick-Test.

Lokal testen:

```bash
cd frontend
npm install          # holt maplibre-gl 6.9.0
npm run dev          # http://localhost:5173 — im Browser durchklicken:
```

Wenn alles passt: Claude Bescheid geben → Deploy auf 192.168.1.115.
Falls etwas kaputt ist: sagen was → Fix oder `git revert 7670040`.

Test-Checkliste:
- [ ] Karte lädt (Sat/Grid/Terrain-Layer)
- [ ] Marker setzen / verschieben / bearbeiten
- [ ] Linien zeichnen + Phase-Lines
- [ ] 2D/3D-Umschalter + Navigations-Würfel
- [ ] Hover-Popup am Marker
- [ ] Öffentliche Ansicht (`#/p/<token>`)
- [ ] Screenshot-Funktion
- [ ] Browser-Konsole ohne CSP-Verstöße (siehe Punkt 4)

Worauf besonders achten (v6-Änderungen): `GeoJSONSource.setData` gibt jetzt ein
Promise zurück statt `this` — wir verketten nirgends, sollte passen. Terrain/3D
und der Würfel nutzen `setTerrain`/`easeTo` — dort genau hinsehen.

> `jspdf`/`dompurify`-Advisory (jetzt als critical eingestuft, ReDoS/DoS):
> betrifft `jspdf.html()` / AcroForm / Bild-Decoder — nichts davon wird genutzt
> (Briefing-Export macht nur `doc.text()`/`doc.save()`). Kein Fremd-Impact, nur
> theoretischer lokaler DoS beim Exportierenden. Upgrade auf jspdf 4 (breaking)
> als eigener Schritt bei Gelegenheit — nicht dringend.

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
