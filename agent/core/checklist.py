"""责任清单 (§8.6)。不挣分，仅记录完成度。

P1 没 UI，只暴露 API；Step 7 的 tray 菜单可以勾选。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from comms.event_bus import EventBus
from comms.message_types import Event, EventType
from store.repository import EventSink, ResponsibilityRepository

_log = logging.getLogger(__name__)


@dataclass
class ChecklistItem:
    id: str
    name: str


class ResponsibilityChecklist:
    def __init__(
        self,
        tasks_json_path: str | Path,
        repo: ResponsibilityRepository,
        events: EventSink,
        bus: EventBus,
    ) -> None:
        self._path = Path(tasks_json_path)
        self._repo = repo
        self._events = events
        self._bus = bus
        self._items: list[ChecklistItem] = []
        self.reload()

    def reload(self) -> None:
        if not self._path.exists():
            self._items = []
            return
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            _log.exception("failed to load tasks.json")
            self._items = []
            return
        self._items = [
            ChecklistItem(id=t["id"], name=t["name"])
            for t in data
            if t.get("category") == "responsibility" and t.get("active", True)
        ]

    def list_today(self) -> list[tuple[ChecklistItem, bool]]:
        today = date.today()
        done_map = self._repo.get_today(today)
        return [(item, done_map.get(item.id, False)) for item in self._items]

    def tick(self, task_id: str, completed: bool) -> None:
        if not any(i.id == task_id for i in self._items):
            _log.warning("unknown responsibility task id: %s", task_id)
            return
        self._repo.tick(task_id, date.today(), completed)
        ev = Event(
            type=EventType.CHECKLIST_TICK.value,
            payload={"task_id": task_id, "completed": completed},
        )
        self._events.emit(ev)
        self._bus.publish(ev)
