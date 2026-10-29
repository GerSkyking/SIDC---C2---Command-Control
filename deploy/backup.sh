#!/bin/sh
# pg_dump-Backup in einer Schleife. Läuft im 'backup'-Container (postgres:17-alpine).
# Dumps liegen im Named-Volume 'backups' (/backups), rotierend (neueste BACKUP_KEEP behalten).
#
# Restore:
#   gunzip -c /backups/sidc-YYYYmmdd-HHMMSS.sql.gz \
#     | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

set -eu
KEEP="${BACKUP_KEEP:-14}"
INTERVAL="${BACKUP_INTERVAL:-86400}"
mkdir -p /backups

echo "backup: intervall ${INTERVAL}s, behalte ${KEEP} dumps"
while true; do
  ts="$(date -u +%Y%m%d-%H%M%S)"
  out="/backups/sidc-${ts}.sql.gz"
  # Erst in Datei dumpen (Exitcode von pg_dump zaehlt, kein Pipe-Masking), dann komprimieren
  if pg_dump --clean --if-exists > "${out}.sql.tmp" 2>/tmp/err && gzip -c "${out}.sql.tmp" > "${out}.tmp"; then
    rm -f "${out}.sql.tmp"
    mv "${out}.tmp" "${out}"
    ok=1
    echo "$(date -u +%FT%TZ) backup ok: ${out} ($(wc -c < "${out}") bytes)"
  else
    ok=0
    rm -f "${out}.tmp" "${out}.sql.tmp"
    echo "$(date -u +%FT%TZ) backup FEHLGESCHLAGEN: $(cat /tmp/err)" >&2
  fi
  # Rotation nur nach erfolgreichem Backup: neueste KEEP behalten, Rest löschen
  if [ "$ok" = 1 ]; then
    ls -1t /backups/sidc-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r f; do
      rm -f "$f" && echo "  rotiert: $f"
    done
  fi
  sleep "${INTERVAL}"
done
