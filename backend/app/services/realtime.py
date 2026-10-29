"""WebSocket-Räume mit optionaler Redis-Pub/Sub-Backplane (mehrere Worker).

Fällt ohne erreichbares Redis auf reine In-Process-Verteilung zurück (Single Worker).
"""
from __future__ import annotations

import asyncio
import functools
import json
import logging
from collections import defaultdict
from collections.abc import Callable

import anyio.from_thread
import redis.asyncio as aioredis
from starlette.websockets import WebSocket

from ..config import get_settings

log = logging.getLogger("sidc.realtime")
_CHANNEL_PREFIX = "plan:"
_SEND_TIMEOUT = 5.0  # Sekunden je Client


class Hub:
    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)
        self._builders: set[WebSocket] = set()  # Sockets mit Missionsbau-Rolle
        self._zeus: set[WebSocket] = set()      # Sockets mit Zeus-Rolle
        # Pro-Socket-Filter (z. B. öffentliche Share-Links): bekommt die Nachricht als dict und
        # liefert die auszuliefernde (ggf. bereinigte) Fassung oder None = nicht senden.
        self._filters: dict[WebSocket, Callable[[dict], dict | None]] = {}
        self._redis: aioredis.Redis | None = None
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        try:
            self._redis = aioredis.from_url(get_settings().redis_url, decode_responses=True)
            await self._redis.ping()
            self._task = asyncio.create_task(self._pump())
            log.info("Redis-Backplane aktiv")
        except Exception as exc:  # noqa: BLE001
            self._redis = None
            log.warning("Kein Redis (%s) — In-Process-Verteilung", exc)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        if self._redis:
            await self._redis.aclose()

    async def _pump(self) -> None:
        """Redis -> lokale Sockets; bei Fehlern mit Backoff neu verbinden (statt still zu enden)."""
        assert self._redis is not None
        delay = 1.0
        while True:
            try:
                pubsub = self._redis.pubsub()
                await pubsub.psubscribe(f"{_CHANNEL_PREFIX}*")
                delay = 1.0
                async for msg in pubsub.listen():
                    if msg["type"] != "pmessage":
                        continue
                    plan_id = msg["channel"].removeprefix(_CHANNEL_PREFIX)
                    try:
                        await self._local_send(plan_id, msg["data"])
                    except Exception:  # noqa: BLE001  eine kaputte Nachricht darf die Pumpe nicht beenden
                        log.exception("Zustellung fehlgeschlagen (plan=%s)", plan_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("Redis-Pump unterbrochen (%s) - neuer Versuch in %.0fs", exc, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    async def join(
        self, plan_id: str, ws: WebSocket, is_builder: bool = False, is_zeus: bool = False,
        visible: Callable[[dict], dict | None] | None = None,
    ) -> None:
        self._rooms[plan_id].add(ws)
        if visible is not None:
            self._filters[ws] = visible
        if is_builder:
            self._builders.add(ws)
        if is_zeus:
            self._zeus.add(ws)

    def set_roles(self, ws: WebSocket, *, is_builder: bool, is_zeus: bool) -> None:
        """Builder-/Zeus-Zugehörigkeit eines bereits verbundenen Sockets ändern."""
        (self._builders.add if is_builder else self._builders.discard)(ws)
        (self._zeus.add if is_zeus else self._zeus.discard)(ws)

    def leave(self, plan_id: str, ws: WebSocket) -> None:
        self._rooms[plan_id].discard(ws)
        self._builders.discard(ws)
        self._zeus.discard(ws)
        self._filters.pop(ws, None)
        if not self._rooms[plan_id]:
            self._rooms.pop(plan_id, None)

    def peers(self, plan_id: str) -> int:
        return len(self._rooms.get(plan_id, ()))

    async def broadcast(
        self, plan_id: str, message: dict, *, builder_only: bool = False, zeus_ok: bool = False
    ) -> None:
        if builder_only:
            message = {**message, "_bo": True}
            if zeus_ok:  # auch an Zeus-Sockets (Phase ist für Zeus freigegeben)
                message["_zo"] = True
        payload = json.dumps(message)
        if self._redis is not None:
            try:
                await self._redis.publish(f"{_CHANNEL_PREFIX}{plan_id}", payload)
                return
            except Exception as exc:  # noqa: BLE001  Redis weg -> wenigstens lokal zustellen
                log.warning("Redis-Publish fehlgeschlagen (%s) - lokale Zustellung", exc)
        await self._local_send(plan_id, payload)

    async def _local_send(self, plan_id: str, payload: str) -> None:
        builder_only = '"_bo": true' in payload or '"_bo":true' in payload
        zeus_ok = '"_zo": true' in payload or '"_zo":true' in payload
        send_payload = payload
        if builder_only:
            # das interne Flag nicht an den Client durchreichen
            try:
                obj = json.loads(payload)
                obj.pop("_bo", None)
                obj.pop("_zo", None)
                send_payload = json.dumps(obj)
            except ValueError:
                pass
        parsed: dict | None = None
        targets: list[tuple[WebSocket, str]] = []
        for ws in list(self._rooms.get(plan_id, ())):
            if builder_only and ws not in self._builders and not (zeus_ok and ws in self._zeus):
                continue
            out = send_payload
            flt = self._filters.get(ws)
            if flt is not None:
                if parsed is None:
                    try:
                        parsed = json.loads(send_payload)
                    except ValueError:
                        parsed = {}
                shown = flt(parsed) if isinstance(parsed, dict) else None
                if shown is None:
                    continue
                out = json.dumps(shown)
            targets.append((ws, out))

        async def _send(ws: WebSocket, out: str) -> bool:
            try:
                await asyncio.wait_for(ws.send_text(out), _SEND_TIMEOUT)
                return True
            except Exception:  # noqa: BLE001  Fehler/Timeout -> Client gilt als tot
                return False

        # parallel + mit Timeout: ein hängender Client blockiert den Raum nicht
        results = await asyncio.gather(*(_send(ws, out) for ws, out in targets))
        for (ws, _out), ok in zip(targets, results):
            if not ok:
                self.leave(plan_id, ws)


hub = Hub()


def broadcast_from_thread(plan_id: str, payload: dict, **kw) -> None:
    """Broadcast aus einem Sync-Endpunkt (Threadpool-Worker): läuft auf dem Event-Loop.
    Fehler kippen die HTTP-Antwort nicht."""
    try:
        anyio.from_thread.run(functools.partial(hub.broadcast, plan_id, payload, **kw))
    except Exception:  # noqa: BLE001
        log.exception("Broadcast aus Thread fehlgeschlagen (plan=%s)", plan_id)
