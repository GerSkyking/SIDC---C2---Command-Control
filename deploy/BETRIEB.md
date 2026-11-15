# Betrieb: Releases, Updates, Passwort-Reset

## Release veröffentlichen (Entwickler)
1. `VERSION` hochsetzen (z. B. `1.1.0`), committen, auf `main` pushen.
2. GitHub Actions testet, baut das Image und veröffentlicht es als
   `ghcr.io/gerskyking/sidc---c2---command-control` mit den Tags `1.1.0`, `1.1`, `main`, `sha-…`
   und legt Tag `v1.1.0` plus GitHub Release mit Änderungsliste an.
3. Ohne Änderung an `VERSION` (Tag existiert schon) entsteht kein neues Release; Versions-Tags werden nie überschrieben.
   Ein von Hand gesetzter `v*`-Tag funktioniert weiterhin.

## Erstinstallation / Update (Betreiber)
Erstinstallation: `cp deploy/.env.example .env && cp docker-compose.example.yml docker-compose.yml`, `.env` ausfüllen, `docker compose up -d`.
Die eigene `docker-compose.yml` ist lokal (nicht im Repo); bei Compose-Änderungen im Release die Example-Datei vergleichen.

1. Backup prüfen (Volume `backups`, täglich per `backup`-Container).
2. In der `.env` `SIDC_IMAGE_TAG=1.1.0` setzen.
3. `docker compose pull && docker compose up -d`

Die DB-Migrationen (Alembic) laufen beim Start des Backends automatisch. Rollback: alten
Tag setzen und Schritt 3 wiederholen; nach Migrationen mit Schemaänderung ggf. das Backup einspielen.
Es wird nichts gebaut. Für lokale Entwicklung: `docker-compose.dev.yml` (siehe Kopf der Compose-Datei).

## Automatisch aktuell bleiben?
In der `.env` geht auch `SIDC_IMAGE_TAG=latest` (neuestes Release) oder `1.2` (nur Patch-Releases 1.2.x). Es zieht aber
nichts von selbst: Docker lädt erst bei `docker compose pull && docker compose up -d` (z. B. per Cron) oder mit einem Tool
wie Watchtower nach. Migrationen laufen dabei automatisch. Für Produktion empfiehlt sich ein fester Tag (kontrolliertes
Update, einfacher Rollback); `latest` nur, wenn automatische Sprünge in Kauf genommen werden und Backups laufen.

## Bootstrap-Admin und Passwort-Reset
`BOOTSTRAP_ADMIN_*` in der `.env` wirkt nur beim Anlegen: Existiert das Konto, bleibt sein Passwort
(Hash in der DB) unberührt. Nach dem ersten Start `BOOTSTRAP_ADMIN_PASSWORD` aus der `.env` entfernen.

Passwort zurücksetzen (Konto, Daten und Rechte bleiben erhalten; Sessions und API-Tokens werden widerrufen):

    docker compose exec backend python -m app.cli reset-password admin            # zufälliges Passwort
    docker compose exec -it backend python -m app.cli reset-password admin --prompt  # selbst eintippen

Das Konto aus der DB zu löschen ist dafür nicht nötig (und würde die User-ID ändern).

## Discord-Bot (optional)
`docker compose --profile discord up -d` (Image aus dem Bot-Repo, Version über `BOT_IMAGE_TAG`).
