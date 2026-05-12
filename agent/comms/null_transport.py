"""P1 Transport 实现：完全本地，不连接后端，所有发送丢弃。"""
from __future__ import annotations

from typing import Callable

from comms.transport import Transport


class NullTransport(Transport):
    def send(self, message: dict) -> None:
        return

    def subscribe(self, message_type: str, handler: Callable[[dict], None]) -> None:
        return

    def is_connected(self) -> bool:
        return False
