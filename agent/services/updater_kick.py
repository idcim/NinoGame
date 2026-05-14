r"""无感更新 — Agent 侧 (CLAUDE.md §17 / v0.3.0).

主流程:
  1. 收到 update_self command → 缓存 pending_update
  2. 主循环每 30s 检查: SafeMoment (mode==lock 持续 ≥30s + 无对话框打开)
  3. 满足 → 下载 zip 到 %ProgramData%\NinoGame\updates\<v>.zip.tmp
  4. 校验 sha256, 解压到 staging
  5. 写 quit.flag → 启动 Updater.exe → sys.exit(0)
  6. Updater 接管文件替换 + 服务重启 + 回滚

防雪崩: 同一 pending_update.version 失败 6h 内不再重试 (写入
last_update_attempt.json 记录).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

_log = logging.getLogger(__name__)

UPDATES_SUBDIR = "updates"
LAST_ATTEMPT_FILENAME = "last_update_attempt.json"
RETRY_COOLDOWN_HOURS = 6


@dataclass
class PendingUpdate:
    version: str
    url: str
    sha256: str
    size_bytes: int
    received_at: str  # ISO8601


def updates_dir(data_dir: Path) -> Path:
    """%ProgramData%\\NinoGame\\data\\updates"""
    p = data_dir / UPDATES_SUBDIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def last_attempt_path(data_dir: Path) -> Path:
    return data_dir / LAST_ATTEMPT_FILENAME


def should_retry(data_dir: Path, version: str) -> tuple[bool, str]:
    """检查同 version 在冷却期内是否已经失败过. 返回 (可重试?, 原因)."""
    p = last_attempt_path(data_dir)
    if not p.exists():
        return True, "no previous attempt"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return True, "last_attempt file corrupted"
    if data.get("version") != version:
        return True, "different version"
    if data.get("status") == "success":
        return False, "already succeeded"
    when = data.get("when", "")
    try:
        last = datetime.fromisoformat(when)
    except Exception:
        return True, "bad timestamp"
    if datetime.utcnow() - last < timedelta(hours=RETRY_COOLDOWN_HOURS):
        return False, f"cooldown {RETRY_COOLDOWN_HOURS}h not elapsed"
    return True, "cooldown elapsed"


def record_attempt(data_dir: Path, version: str, status: str, error: str = "") -> None:
    p = last_attempt_path(data_dir)
    try:
        p.write_text(
            json.dumps({
                "version": version,
                "status": status,
                "error": error,
                "when": datetime.utcnow().isoformat(timespec="seconds"),
            }, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        _log.exception("write last_attempt failed")


def download_and_verify(
    update: PendingUpdate,
    data_dir: Path,
    chunk_size: int = 1024 * 1024,
    progress_cb=None,
) -> Optional[Path]:
    """下载 zip + 校验 sha256. 成功返回 zip 路径, 失败返回 None."""
    target_dir = updates_dir(data_dir)
    tmp_path = target_dir / f"NinoGame-{update.version}.zip.tmp"
    final_path = target_dir / f"NinoGame-{update.version}.zip"

    # 清掉旧 .tmp (上次中断的)
    if tmp_path.exists():
        try: tmp_path.unlink()
        except Exception: pass

    sha = hashlib.sha256()
    bytes_total = 0
    try:
        with urllib.request.urlopen(update.url, timeout=60) as resp:
            with open(tmp_path, "wb") as f:
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk: break
                    f.write(chunk)
                    sha.update(chunk)
                    bytes_total += len(chunk)
                    if progress_cb:
                        try: progress_cb(bytes_total, update.size_bytes)
                        except Exception: pass
    except Exception as e:
        _log.error("下载升级包失败: %s", e)
        try: tmp_path.unlink()
        except Exception: pass
        return None

    actual_sha = sha.hexdigest()
    if actual_sha.lower() != update.sha256.lower():
        _log.error("sha256 校验失败: expected=%s actual=%s", update.sha256, actual_sha)
        try: tmp_path.unlink()
        except Exception: pass
        return None

    # 校验大小 (size_bytes=0 表跳过)
    if update.size_bytes > 0 and bytes_total != update.size_bytes:
        _log.warning("下载字节数与声明不一致: expected=%d actual=%d (允许通过, sha256 是权威)",
                     update.size_bytes, bytes_total)

    # 原子改名
    try:
        if final_path.exists(): final_path.unlink()
        tmp_path.rename(final_path)
    except Exception:
        _log.exception("zip 改名失败")
        return None

    _log.info("升级包下载完成: %s (%d bytes)", final_path, bytes_total)
    return final_path


def extract_to_staging(zip_path: Path, data_dir: Path, version: str) -> Optional[Path]:
    """解压 zip 到 staging 目录, 返回 staging 路径; 失败 None."""
    staging = updates_dir(data_dir) / f"{version}_staged"
    if staging.exists():
        try: shutil.rmtree(staging)
        except Exception:
            _log.exception("清理旧 staging 失败")
            return None
    try:
        staging.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(staging)
    except Exception:
        _log.exception("解压失败")
        return None
    _log.info("升级包已解压到 staging: %s", staging)
    return staging


def install_dir_from_argv() -> Path:
    """当前 Agent 安装目录 (PyInstaller --onefile 下也能拿到).
    开发模式下 sys.argv[0] 是 main.py, 不一定准 — 但开发模式不走升级,
    PyInstaller 模式下 sys.executable 就是 NinoGameAgent.exe 路径."""
    exe = Path(sys.executable).resolve()
    return exe.parent


def find_updater_exe(install_dir: Path) -> Optional[Path]:
    """找 Updater.exe. PyInstaller 打包时与 NinoGameAgent.exe 同目录。"""
    candidate = install_dir / "Updater.exe"
    if candidate.exists():
        return candidate
    # 开发模式 fallback (跑 python main.py 时)
    py_updater = Path(__file__).resolve().parent.parent / "updater.py"
    if py_updater.exists():
        return py_updater
    return None


def write_quit_flags(data_dir: Path) -> None:
    """让 Watchdog 主动退出 + 防止互守自动拉起 (复用 commit e218120 机制)."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    for name in ("agent_quit.flag", "watchdog_quit.flag"):
        try:
            (data_dir / name).write_text(
                f"pid={os.getpid()} ts={now} reason=update_self",
                encoding="utf-8",
            )
        except Exception:
            _log.exception("write %s failed", name)


def spawn_updater(
    updater: Path,
    staging_dir: Path,
    install_dir: Path,
    from_version: str,
    to_version: str,
    log_dir: Path,
) -> bool:
    """启动 Updater 进程 (detached). 返回 True 表 spawn 成功."""
    args = [
        str(updater),
        "--staging", str(staging_dir),
        "--target", str(install_dir),
        "--service-monitor", "NinoGameMonitorSvc",
        "--service-watchdog", "NinoGameWatchdogSvc",
        "--from-version", from_version,
        "--to-version", to_version,
        "--log-dir", str(log_dir),
        "--parent-pid", str(os.getpid()),
    ]
    # 开发模式: updater 是 .py, 用当前 python 跑
    if updater.suffix == ".py":
        args = [sys.executable, *args]

    try:
        flags = 0
        # Windows: DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        if os.name == "nt":
            flags = 0x00000008 | 0x00000200
        subprocess.Popen(
            args,
            close_fds=True,
            cwd=str(install_dir.parent),
            creationflags=flags if os.name == "nt" else 0,
        )
        _log.info("Updater 已 spawn: %s", " ".join(args))
        return True
    except Exception:
        _log.exception("Updater spawn 失败")
        return False


def kick_update(
    update: PendingUpdate,
    data_dir: Path,
    install_dir: Path,
    from_version: str,
) -> tuple[bool, str]:
    """完整流程: 检查冷却 → 下载 → 校验 → 解压 → spawn Updater → 退出标志.

    返回 (success, message). True 时调用方应立即 sys.exit(0).
    """
    can_retry, why = should_retry(data_dir, update.version)
    if not can_retry:
        return False, f"skip (retry guard): {why}"

    _log.info("★ 触发升级: from=%s → to=%s", from_version, update.version)

    zip_path = download_and_verify(update, data_dir)
    if zip_path is None:
        record_attempt(data_dir, update.version, "download_or_sha_fail", "see logs")
        return False, "download / sha256 failed"

    staging = extract_to_staging(zip_path, data_dir, update.version)
    if staging is None:
        record_attempt(data_dir, update.version, "extract_fail", "see logs")
        return False, "extract failed"

    updater = find_updater_exe(install_dir)
    if updater is None:
        record_attempt(data_dir, update.version, "updater_missing", "Updater.exe not found")
        return False, "Updater.exe not found in install dir"

    # 写 quit.flag (复用 e218120 机制让 Watchdog 不互守拉)
    write_quit_flags(data_dir)

    ok = spawn_updater(
        updater, staging, install_dir,
        from_version, update.version,
        data_dir / "updater_logs",
    )
    if not ok:
        record_attempt(data_dir, update.version, "spawn_fail", "see logs")
        return False, "spawn updater failed"

    # 记一笔 "已发起", Updater 成功后会改 status=success
    record_attempt(data_dir, update.version, "kicked", "")
    # 给 Updater 留 2s 让它真起来; Agent 自己马上退出
    time.sleep(2)
    return True, "update kicked"
