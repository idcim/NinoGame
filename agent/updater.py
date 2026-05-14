r"""NinoGame Updater — 独立进程, 接管文件替换 + 服务重启 + 回滚.

调用方: Agent 主进程 (kick_update) 在 SafeMoment (lock 态稳定 30s) 时启动.

流程:
  1. 等 Agent + Watchdog PID 真死 (最多 30s)
  2. nssm stop NinoGameWatchdogSvc → nssm stop NinoGameMonitorSvc
     (watchdog 先停, 否则会一直拉 Agent)
  3. 备份当前 install_dir → backup-<from_version>
  4. 清空 install_dir 内容, 把 staging 内容拷过去
  5. nssm start NinoGameMonitorSvc → start watchdog
  6. 60s 内观察: data/agent.alive mtime 在 5s 内 + data/version_marker.txt == to_version
     → 成功: 删 backup, 写 data/update_log.json
     → 失败: 回滚 (拷 backup 回来, 重启服务)
  7. exit (Updater 本身退出, NSSM 看 Agent 还在跑就没事)

日志: %ProgramData%\NinoGame\updater.log (不依赖 Agent 主程序 logger).
"""
from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# 不依赖 agent 包内任何 module, 独立运行
_log = logging.getLogger("ninogame.updater")


def setup_logging(log_dir: Path) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S",
    )
    fh = logging.handlers.RotatingFileHandler(
        log_dir / "updater.log", maxBytes=2 * 1024 * 1024, backupCount=3,
        encoding="utf-8",
    )
    fh.setFormatter(fmt)
    fh.setLevel(logging.INFO)
    ch = logging.StreamHandler()
    ch.setFormatter(fmt)
    _log.addHandler(fh)
    _log.addHandler(ch)
    _log.setLevel(logging.INFO)


def pid_alive(pid: int) -> bool:
    if pid <= 0: return False
    if os.name != "nt":
        try: os.kill(pid, 0); return True
        except ProcessLookupError: return False
        except PermissionError: return True
    # Windows: 用 ctypes OpenProcess + STILL_ACTIVE
    try:
        import ctypes
        PROCESS_QUERY_LIMITED_INFO = 0x1000
        STILL_ACTIVE = 259
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFO, False, pid)
        if not h: return False
        try:
            code = ctypes.c_ulong()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
            return bool(ok) and code.value == STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(h)
    except Exception:
        return False


def wait_for_dead(pids: list[int], timeout_s: int = 30) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not any(pid_alive(p) for p in pids if p > 0):
            return True
        time.sleep(0.5)
    return False


def nssm_cmd(action: str, svc: str) -> int:
    """nssm.exe 不一定在 PATH; 试 PATH + 安装目录."""
    candidates = ["nssm.exe", r"C:\nssm-2.24\win64\nssm.exe", r"C:\nssm\nssm.exe"]
    for nssm in candidates:
        try:
            r = subprocess.run([nssm, action, svc], capture_output=True, timeout=30)
            _log.info("nssm %s %s -> %d (stderr=%s)",
                      action, svc, r.returncode,
                      r.stderr.decode("utf-8", errors="replace").strip()[:200])
            return r.returncode
        except FileNotFoundError:
            continue
        except Exception as e:
            _log.error("nssm %s %s 异常: %s", action, svc, e)
            return -1
    _log.error("找不到 nssm.exe")
    return -1


def rmtree_force(p: Path) -> None:
    """删目录所有内容, 失败重试 3 次 (windows file lock 有时滞后)."""
    if not p.exists(): return
    for attempt in range(3):
        try:
            shutil.rmtree(p)
            return
        except Exception as e:
            _log.warning("rmtree 第 %d 次失败 (%s), 等 2s 重试", attempt + 1, e)
            time.sleep(2)
    raise OSError(f"无法删除 {p}")


def copytree_force(src: Path, dst: Path) -> None:
    """整目录拷贝, 目标若存在先清。"""
    if dst.exists():
        rmtree_force(dst)
    shutil.copytree(src, dst)


def replace_install_contents(src: Path, install_dir: Path) -> None:
    """把 install_dir 下内容清空, 再把 src 下内容拷过去.
    保留 install_dir 本身 (NSSM 服务指向那条路径)."""
    install_dir.mkdir(parents=True, exist_ok=True)
    # 删 install_dir 下所有项 (但保留目录)
    for child in install_dir.iterdir():
        try:
            if child.is_dir() and not child.is_symlink():
                rmtree_force(child)
            else:
                child.unlink()
        except Exception:
            _log.exception("删 %s 失败", child)
            raise
    # 拷 src 下所有项进来
    for child in src.iterdir():
        target = install_dir / child.name
        try:
            if child.is_dir():
                shutil.copytree(child, target)
            else:
                shutil.copy2(child, target)
        except Exception:
            _log.exception("拷 %s 到 %s 失败", child, target)
            raise


def write_update_log(data_dir: Path, status: str, from_v: str, to_v: str,
                     took_ms: int, error: str = "") -> None:
    """写一笔结构化结果, Agent 启动时读这个上报 events."""
    data_dir.mkdir(parents=True, exist_ok=True)
    p = data_dir / "update_log.json"
    try:
        p.write_text(json.dumps({
            "status": status,
            "from_version": from_v,
            "to_version": to_v,
            "took_ms": took_ms,
            "error": error,
            "when": datetime.utcnow().isoformat(timespec="seconds"),
        }, ensure_ascii=False), encoding="utf-8")
    except Exception:
        _log.exception("写 update_log.json 失败")


def verify_new_version_running(data_dir: Path, expected_version: str,
                               timeout_s: int = 60) -> bool:
    """新服务起来 60s 内 ⇔ data/version_marker.txt == expected_version
    且 data/agent.alive 文件 mtime 在 5s 内更新."""
    marker_path = data_dir / "version_marker.txt"
    alive_path = data_dir / "agent.alive"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if marker_path.exists():
                v = marker_path.read_text(encoding="utf-8").strip()
                if v == expected_version:
                    if alive_path.exists():
                        age = time.time() - alive_path.stat().st_mtime
                        if age <= 10:
                            return True
        except Exception:
            pass
        time.sleep(2)
    return False


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--staging", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--service-monitor", default="NinoGameMonitorSvc")
    ap.add_argument("--service-watchdog", default="NinoGameWatchdogSvc")
    ap.add_argument("--from-version", required=True)
    ap.add_argument("--to-version", required=True)
    ap.add_argument("--log-dir", required=True)
    ap.add_argument("--parent-pid", type=int, default=0)
    args = ap.parse_args(argv)

    log_dir = Path(args.log_dir)
    setup_logging(log_dir)

    staging = Path(args.staging).resolve()
    target = Path(args.target).resolve()
    # data 目录 = target/data (Agent 默认布局), 也是写 update_log 的地方
    data_dir = target / "data"
    # ProgramData 模式: 测试机用户可能配在外面, 试两条路径
    alt_data = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "NinoGame" / "data"

    _log.info("=" * 60)
    _log.info("NinoGame Updater 启动")
    _log.info("  from = %s", args.from_version)
    _log.info("  to   = %s", args.to_version)
    _log.info("  staging = %s", staging)
    _log.info("  target  = %s", target)
    _log.info("  data    = %s (alt=%s)", data_dir, alt_data)

    if not staging.exists():
        _log.error("staging 不存在")
        return 2
    if not target.exists():
        _log.error("target 不存在")
        return 2

    # 1) 等 parent (Agent) 退出
    pids = [args.parent_pid] if args.parent_pid > 0 else []
    if pids:
        _log.info("等 Agent PID %s 退出...", pids)
        if not wait_for_dead(pids, timeout_s=30):
            _log.warning("Agent PID 仍存活, 继续 (NSSM stop 会兜底)")
        else:
            _log.info("Agent PID 已死")

    started_at = time.time()

    # 2) 停服务 (顺序: watchdog 先, 不然它拉 Agent)
    _log.info("停服务...")
    nssm_cmd("stop", args.service_watchdog)
    nssm_cmd("stop", args.service_monitor)
    time.sleep(2)  # 给 NSSM 一点时间释放文件锁

    backup_dir = target.parent / f"backup-{args.from_version}-{int(time.time())}"
    rollback_needed = False
    try:
        # 3) 备份
        _log.info("备份当前安装到 %s", backup_dir)
        if backup_dir.exists():
            rmtree_force(backup_dir)
        shutil.copytree(target, backup_dir)

        # 4) 替换
        _log.info("替换 install_dir 内容")
        replace_install_contents(staging, target)

        # 5) 启服务 (顺序反过来: monitor 先, 它写 agent.alive)
        _log.info("启服务...")
        rc1 = nssm_cmd("start", args.service_monitor)
        time.sleep(2)
        rc2 = nssm_cmd("start", args.service_watchdog)
        if rc1 != 0 or rc2 != 0:
            _log.warning("nssm start 非 0 返回, 继续看心跳判定")

        # 6) 验证新版本起来了
        _log.info("等 ≤60s 看 v%s 心跳 + version_marker...", args.to_version)
        # 优先看 alt_data (ProgramData) 再看 install_dir/data
        if verify_new_version_running(alt_data, args.to_version, timeout_s=60):
            _log.info("✓ 新版本心跳确认 (via ProgramData)")
            ok = True
        elif verify_new_version_running(data_dir, args.to_version, timeout_s=20):
            _log.info("✓ 新版本心跳确认 (via install_dir/data)")
            ok = True
        else:
            _log.error("✗ 新版本 60s 内未上报心跳, 准备回滚")
            ok = False
            rollback_needed = True

        took_ms = int((time.time() - started_at) * 1000)

        if ok:
            # 删 backup, 写成功 log
            try: rmtree_force(backup_dir)
            except Exception: _log.exception("删 backup 失败 (无影响)")
            for d in (alt_data, data_dir):
                try: write_update_log(d, "success", args.from_version, args.to_version, took_ms)
                except Exception: pass
            _log.info("✓ 升级成功, 耗时 %d ms", took_ms)
            return 0

        # 7) 回滚
        if rollback_needed:
            _log.info("开始回滚...")
            nssm_cmd("stop", args.service_watchdog)
            nssm_cmd("stop", args.service_monitor)
            time.sleep(2)
            try:
                replace_install_contents(backup_dir, target)
                nssm_cmd("start", args.service_monitor)
                nssm_cmd("start", args.service_watchdog)
                _log.info("回滚完成, 启服务回 v%s", args.from_version)
                err = "new version did not start within 60s; rolled back"
            except Exception as e:
                _log.exception("回滚也失败了 (孩子电脑可能没 Agent 跑了 — 家长后台会看到离线告警)")
                err = f"rollback failed: {e}"
            for d in (alt_data, data_dir):
                try: write_update_log(d, "failed_rolled_back", args.from_version, args.to_version, took_ms, err)
                except Exception: pass
            return 3

    except Exception as e:
        _log.exception("升级出现未捕获异常")
        # 兜底回滚
        try:
            nssm_cmd("stop", args.service_watchdog)
            nssm_cmd("stop", args.service_monitor)
            time.sleep(2)
            if backup_dir.exists():
                replace_install_contents(backup_dir, target)
            nssm_cmd("start", args.service_monitor)
            nssm_cmd("start", args.service_watchdog)
        except Exception:
            _log.exception("兜底回滚也失败")
        for d in (alt_data, data_dir):
            try:
                write_update_log(
                    d, "failed_rolled_back", args.from_version, args.to_version,
                    int((time.time() - started_at) * 1000), str(e),
                )
            except Exception:
                pass
        return 4

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
