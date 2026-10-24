"""WebSocket-Räume mit optionaler Redis-Pub/Sub-Backplane (mehrere Worker).

Fällt ohne erreichbares Redis auf reine In-Process-Verteilung zurück (Single Worker).
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from collections.abc import Callable

import redis.asyncio as aioredis
from starlette.websockets import WebSocket

from ..config import get_settings

log = logging.getLogger("sidc.realtime")
_CHANNEL_PREFIX = "plan:"


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
        assert self._redis is not None
        pubsub = self._redis.pubsub()
        await pubsub.psubscribe(f"{_CHANNEL_PREFIX}*")
        async for msg in pubsub.listen():
            if msg["type"] != "pmessage":
                continue
            plan_id = msg["channel"].removeprefix(_CHANNEL_PREFIX)
            await self._local_send(plan_id, msg["data"])

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
            await self._redis.publish(f"{_CHANNEL_PREFIX}{plan_id}", payload)
        else:
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
        dead: list[WebSocket] = []
        parsed: dict | None = None
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
            try:
                await ws.send_text(out)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.leave(plan_id, ws)


hub = Hub()
