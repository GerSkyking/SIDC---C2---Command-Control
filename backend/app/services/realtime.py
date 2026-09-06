"""WebSocket-Räume mit optionaler Redis-Pub/Sub-Backplane (mehrere Worker).

Fällt ohne erreichbares Redis auf reine In-Process-Verteilung zurück (Single Worker).
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict

import redis.asyncio as aioredis
from starlette.websockets import WebSocket

from ..config import get_settings

log = logging.getLogger("sidc.realtime")
_CHANNEL_PREFIX = "plan:"


class Hub:
    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)
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

    async def join(self, plan_id: str, ws: WebSocket) -> None:
        self._rooms[plan_id].add(ws)

    def leave(self, plan_id: str, ws: WebSocket) -> None:
        self._rooms[plan_id].discard(ws)
        if not self._rooms[plan_id]:
            self._rooms.pop(plan_id, None)

    def peers(self, plan_id: str) -> int:
        return len(self._rooms.get(plan_id, ()))

    async def broadcast(self, plan_id: str, message: dict) -> None:
        payload = json.dumps(message)
        if self._redis is not None:
            await self._redis.publish(f"{_CHANNEL_PREFIX}{plan_id}", payload)
        else:
            await self._local_send(plan_id, payload)

    async def _local_send(self, plan_id: str, payload: str) -> None:
        dead: list[WebSocket] = []
        for ws in list(self._rooms.get(plan_id, ())):
            try:
                await ws.send_text(payload)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.leave(plan_id, ws)


hub = Hub()
