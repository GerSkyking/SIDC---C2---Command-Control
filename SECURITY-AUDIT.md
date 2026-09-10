# Sicherheits-Audit — SIDC-C2

Stand: 2026-09-10 · Prüfumfang: Authentifizierung, Session, Freigaben, Transport,
Eingabevalidierung, Fehler-/Datenumgang. Codebasis-Review (kein Live-Pentest).

Legende: ✅ behoben · ⏸️ manuell/akzeptiert (siehe `deploy/MANUAL-STEPS.md`)

---

## 🔴 HIGH

### H1 — Stored XSS (mehrere Sinks) + kein CSP — ✅ (Rest: ⏸️ maplibre-Upgrade)
Dynamische Strings ohne Escaping in `innerHTML`: Plan-/Phasen-/ORBAT-/Channel-Namen,
`value="${m.unit_text}"` (Attribut-Breakout), Username, Favoriten-Label, Audit-Log
(Angreifer-Username aus `login.fail`), öffentliche Ansicht (traf nicht-authentifizierte
Besucher).
**Fix:**
- Zentraler Escaper `frontend/src/esc.ts`, angewendet auf alle betroffenen Sinks in
  `plan.ts`, `publicview.ts`, `main.ts`, `ui.ts`, `planTree.ts`, `admin.ts`,
  `acl.ts`, `sidc/combobox.ts`.
- Strikte **Content-Security-Policy** in `backend/app/main.py` (`script-src 'self'`,
  kein `unsafe-inline` → inline-Event-Handler & `javascript:` werden blockiert,
  `img/connect/form-action` auf `'self'` begrenzt). Inline-`onerror`/`onclick`
  durch delegierte Listener ersetzt (`data-hide-on-error`, `data-select-on-click`).
- ✅ **maplibre-gl** von v5 auf v6.9.0 angehoben (Commit `7670040`), deployt +
  live durchgetestet (2026-09-10) — behebt die eigene kritische XSS-Sanitizer-
  Lücke GHSA-jrc7-96c5-q579. Hover-Popup zusätzlich auf `setDOMContent`
  (versionsunabhängig kein Sanitizer-Pfad).

### H2 — Path Traversal im SPA-Fallback — ✅
`backend/app/main.py`: `(_DIST_ROOT / full_path).resolve()` + `is_relative_to()`.

---

## 🟠 MEDIUM

### M3 — Security-Header — ✅
`main.py`-Middleware: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Cross-Origin-Opener-Policy`, HSTS. Zusätzlich am Proxy: MANUAL-STEPS #2.

### M4 — Login-DoS / `ui_settings` unbegrenzt — ✅
`LoginIn`: `max_length` auf `username` (64) / `password` (256).
`PATCH /me/settings`: Key-Whitelist (`keybinds`/`theme`/`lang`) + 8-KB-Limit.

### M5 — Keine Session-Invalidierung — ✅
`users.session_epoch` (Migration `0015`) im signierten Cookie; `get_current_user`
und WS-`_auth` vergleichen. `PATCH /admin/users` erhöht die Epoch bei Passwortwechsel.

### M6 — `SessionMiddleware` nicht `https_only` — ✅
`https_only` an `COOKIE_SECURE` gekoppelt, `max_age=600`.

### M7 — `COOKIE_SECURE=auto` in Prod — ⏸️
`.env.example` kommentiert; in Prod `COOKIE_SECURE=true` setzen (MANUAL-STEPS #1).

### M8 — Rate-Limit schwach — ✅
`ratelimit.py`: zusätzliche Pro-IP-Schranke (30/60 s) neben (IP, Username) (8/60 s).
In-Process bleibt gültig, solange 1 uvicorn-Worker (aktuell so).

### M9 — CSWSH: WebSocket ohne Origin-Prüfung — ✅
`security.origin_allowed()` in `live.py` und `public.py` vor `accept()`.

---

## 🟡 LOW

| # | Befund | Status |
|---|---|---|
| L1 | User-Enumeration per Timing | ✅ konstanter Dummy-Verify in `login()` |
| L2 | `log.exception` bei Migrationsfehler leakt DB-Passwort | ✅ nur Exception-Typ geloggt |
| L3 | `AuditLog.action.like()` LIKE-Wildcards | ✅ escaped mit `escape="\\"` |
| L4 | Audit-Log ohne Retention | ⏸️ dokumentiert (MANUAL-STEPS #5) |
| L5 | Map-Source `follow_redirects=True` | ⏸️ akzeptiert (admin-only, httpx strippt Auth cross-host) |
| L6 | Public-WS lädt Rechte nur beim Connect | ⏸️ akzeptiert (revoke wirkt beim Reconnect) |

---

## ✅ Bereits solide (vor dem Audit)

- Argon2id (`pwdlib`), `MIN_PASSWORD_LEN=12` konsistent geprüft
- Login-Fehler generisch; Passwörter/Tokens nicht geloggt
- Plan-Authz zentral (`require_plan_level` + `effective_level`/`effective_caps`), kein IDOR
- Public-Share: 192-bit-Token, Revoke + Expiry serverseitig, `include_builder` an Rolle gekoppelt
- `--proxy-headers --forwarded-allow-ips` gesetzt; genau 1 uvicorn-Worker
- `SECRET_KEY` persistent + `chmod 600`
- ORM mit Bind-Parametern → kein SQLi
- `md.ts` escapet zuerst, Link-Schema auf `https?://` begrenzt
- Admin: Selbst-Lockout-Schutz; CORS bewusst aus (same-origin)

---

## Verifikation

- `backend`: `pytest` 15/15 grün · `python -c "from app.main import app"` ok
- `frontend`: `tsc --noEmit` grün · `vite build` grün
- Live deployt + durchgeklickt (2026-09-10): Karte/Marker/Linien/2D-3D/Würfel/
  Popup/Live-Sync/öffentliche Ansicht ok, keine CSP-Verstöße in der Konsole
- Rest offen: nur noch `.env`-Härtung (MANUAL-STEPS #1), Proxy-Header (#2),
  Credential-Rotation (SECRET_KEY + Bootstrap-PW versehentlich im Chat exponiert)
