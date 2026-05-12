"""Agent ↔ Backend 传输层接口 (P1: NullTransport / P2: WebSocketTransport)。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Callable


class Transport(ABC):
    @abstractmethod
    def send(self, message: dict) -> None: ...

    @abstractmethod
    def subscribe(self, message_type: str, handler: Callable[[dict], None]) -> None: ...

    @abstractmethod
    def is_connected(self) -> bool: ...
