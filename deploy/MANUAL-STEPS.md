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

## 3. maplibre-gl v6 — ✅ ERLEDIGT (2026-09-10)

Commit `7670040`, deployt auf `192.168.1.115` und live durchgetestet
(Karte, Marker, Linien, 2D/3D + Würfel, Hover-Popup, Live-Sync, öffentliche
Ansicht — alles ok, keine CSP-Verstöße). Behebt GHSA-jrc7-96c5-q579.

> Verbleibendes `jspdf`/`dompurify`-Advisory (als critical eingestuft, ReDoS/DoS):
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
