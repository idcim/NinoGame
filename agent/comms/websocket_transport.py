"""WebSocketTransport (P2): Agent ↔ Backend 长连接。

设计:
  - 子线程跑 websocket-client 的 WebSocketApp.run_forever()
  - 断线指数退避重连 (1s/2s/4s/.../60s)
  - send() 队列, 连接前/中可调; 连上后 flush
  - subscribe(type, handler) 注册回调; on_message 派发到对应 handler
  - is_connected() 当前实际状态

只依赖 websocket-client (sync API, 不要 asyncio); 简单。
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
from collections import defaultdict
from typing import Callable

import websocket  # websocket-client

from comms.transport import Transport

_log = logging.getLogger(__name__)


class WebSocketTransport(Transport):
    def __init__(
        self,
        url: str,
        agent_token: str,
        reconnect_min_seconds: int = 1,
        reconnect_max_seconds: int = 60,
        ping_interval: int = 30,
    ) -> None:
        # url 应该是 wss://... 或 ws://...; 我们在末尾加 ?token=<token>
        sep = "&" if ("?" in url) else "?"
        self._url = f"{url}{sep}token={agent_token}"
        self._reconnect_min = reconnect_min_seconds
        self._reconnect_max = reconnect_max_seconds
        self._ping_interval = ping_interval

        self._ws: websocket.WebSocketApp | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._connected = threading.Event()

        # 发送队列 (未连上时缓存; 连上后 flush)
        self._send_queue: "queue.Queue[dict]" = queue.Queue()
        self._send_lock = threading.Lock()

        # type → [handler, ...]
        self._handlers: dict[str, list[Callable[[dict], None]]] = defaultdict(list)
        self._handlers_lock = threading.Lock()

    # ── Transport 接口 ──────────────────────────────────────────
    def send(self, message: dict) -> None:
        if self._ws is not None and self._connected.is_set():
            try:
                self._ws.send(json.dumps(message, ensure_ascii=False, default=str))
                return
            except Exception:
                _log.warning("ws.send 失败, 入队等重连", exc_info=True)
        # 没连上: 入队
        self._send_queue.put(message)

    def subscribe(self, message_type: str, handler: Callable[[dict], None]) -> None:
        with self._handlers_lock:
            self._handlers[message_type].append(handler)

    def is_connected(self) -> bool:
        return self._connected.is_set()

    # ── 启停 ────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run_with_reconnect, name="ws-transport", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:
                pass

    # ── 内部 ────────────────────────────────────────────────────
    def _run_with_reconnect(self) -> None:
        backoff = self._reconnect_min
        while not self._stop.is_set():
            try:
                self._ws = websocket.WebSocketApp(
                    self._url,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_close=self._on_close,
                    on_error=self._on_error,
                )
                _log.info("WS 连接中: %s", self._mask_url())
                # websocket-client 0.x 不支持 ping_interval 关键字, 用兼容写法
                self._ws.run_forever()
            except Exception:
                _log.exception("WebSocketApp.run_forever crashed")
            self._connected.clear()
            if self._stop.is_set():
                return
            _log.info("WS 断开, %ds 后重连", backoff)
            self._stop.wait(backoff)
            backoff = min(backoff * 2, self._reconnect_max)

    def _on_open(self, ws) -> None:
        _log.info("WS 已连接")
        self._connected.set()
        # 重置 backoff (重连成功后下次断开重新从 min 开始)
        # 真要实现需在 _run_with_reconnect 里读取 self._connected, 简化版略
        self._flush_queue()
        # 通知 handlers (主程序在 on_open 时发 hello 等)
        self._dispatch({"type": "_connected"})

    def _on_close(self, ws, *args) -> None:
        # websocket-client 0.x: (ws); 1.x+: (ws, status_code, reason)
        status_code = args[0] if len(args) >= 1 else None
        reason = args[1] if len(args) >= 2 else None
        _log.info("WS 关闭: %s %s", status_code, reason)
        self._connected.clear()
        self._dispatch({"type": "_disconnected"})

    def _on_error(self, ws, error) -> None:
        _log.warning("WS 错误: %s", error)

    def _on_message(self, ws, raw) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            _log.warning("WS 收到非 JSON: %r", raw[:200])
            return
        self._dispatch(msg)

    def _dispatch(self, msg: dict) -> None:
        mtype = msg.get("type", "")
        with self._handlers_lock:
            handlers = list(self._handlers.get(mtype, []))
            handlers.extend(self._handlers.get("*", []))
        for h in handlers:
            try:
                h(msg)
            except Exception:
                _log.exception("ws handler %s 失败", mtype)

    def _flush_queue(self) -> None:
        flushed = 0
        while not self._send_queue.empty():
            try:
                msg = self._send_queue.get_nowait()
                self._ws.send(json.dumps(msg, ensure_ascii=False, default=str))
                flushed += 1
            except queue.Empty:
                break
            except Exception:
                _log.warning("flush 时 send 失败", exc_info=True)
                # 失败的塞回去等下次
                self._send_queue.put(msg)
                break
        if flushed:
            _log.info("flush 了 %d 条 pending 消息", flushed)

    def _mask_url(self) -> str:
        # 不让 token 明文进日志
        if "token=" not in self._url:
            return self._url
        head, _, _ = self._url.partition("token=")
        return head + "token=***"
