"""UsageReporter: 周期把 app_segments 推到 server。

设计:
  - 子线程, 每 N 秒醒一次 (默认 5 min, 跟 §10.4 spec 一致)
  - 拉 SessionRepository.pending_segments_for_upload (synced=0)
  - 按 (app_identifier, category, period) 聚合, 单条 usage_report 消息
    打包成 foreground_segments 数组
  - 通过 transport.send 推 (transport 没连上会自动队列, 连上 flush)
  - 推完 mark_segments_synced 标记本地 id 为已上报

如果 transport 是 NullTransport, send 是 no-op + 入队 (实际丢)。
这里检查 is_connected 短路, 避免无意义的本地状态切换。
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime

from comms.transport import Transport
from store.repository import SessionRepository

_log = logging.getLogger(__name__)


class UsageReporter:
    def __init__(
        self,
        transport: Transport,
        sessions: SessionRepository,
        *,
        child_id: str = "",
        device_id: str = "",
        interval_seconds: int = 300,
        batch_limit: int = 200,
    ) -> None:
        self._transport = transport
        self._sessions = sessions
        self._child_id = child_id
        self._device_id = device_id
        self._interval = interval_seconds
        self._batch_limit = batch_limit
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="usage-reporter", daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def update_transport(self, transport: Transport) -> None:
        """配对热换后 main.py 调这个换新 transport (保持闭包引用一致)。"""
        self._transport = transport

    def update_identity(self, child_id: str, device_id: str) -> None:
        """配对完成后, 把 device/child id 更新进来。"""
        self._child_id = child_id
        self._device_id = device_id

    def flush_now(self) -> int:
        """立即推一次; 返回推送的 segment 数。Agent shutdown 时调一下。"""
        try:
            return self._upload_batch()
        except Exception:
            _log.exception("flush_now failed")
            return 0

    def _loop(self) -> None:
        while not self._stop.is_set():
            # 先睡 (启动后第一批等下个周期, 避免压 server)
            self._stop.wait(self._interval)
            if self._stop.is_set():
                return
            try:
                self._upload_batch()
            except Exception:
                _log.exception("usage reporter tick failed")

    def _upload_batch(self) -> int:
        if not self._transport.is_connected():
            return 0
        pending = self._sessions.pending_segments_for_upload(self._batch_limit)
        if not pending:
            return 0

        # 取整个 batch 的时间窗 (period_start / end 范围)
        period_start = min(s.period_start for _, s in pending)
        period_end = max(s.period_end for _, s in pending)

        # 按 (app_identifier, category) 聚合; server 友好
        agg: dict[tuple[str, str, float], dict] = {}
        for _id, s in pending:
            k = (s.app_identifier, s.category, float(s.rate_multiplier))
            if k not in agg:
                agg[k] = {
                    "app": s.app_identifier,
                    "category": s.category,
                    "rate": float(s.rate_multiplier),
                    "active_seconds": 0,
                    "idle_seconds": 0,
                    "tokens_consumed": 0,
                }
            agg[k]["active_seconds"] += int(s.active_seconds)
            agg[k]["idle_seconds"] += int(s.idle_seconds)
            agg[k]["tokens_consumed"] += int(s.tokens_consumed)

        segments = list(agg.values())
        msg = {
            "type": "usage_report",
            "payload": {
                "child_id": self._child_id,
                "device_id": self._device_id,
                "period_start": period_start.isoformat(timespec="seconds"),
                "period_end": period_end.isoformat(timespec="seconds"),
                "foreground_segments": segments,
                "segment_count_raw": len(pending),
            },
        }

        try:
            self._transport.send(msg)
        except Exception:
            _log.exception("usage_report send failed; 保留本地 unsynced")
            return 0

        ids = [i for i, _ in pending]
        try:
            self._sessions.mark_segments_synced(ids)
        except Exception:
            _log.exception("mark_segments_synced 失败 (可能下次重传)")
        _log.info(
            "usage_report 已发: %d 个原始 segments → %d 个聚合行",
            len(pending), len(segments),
        )
        return len(pending)
