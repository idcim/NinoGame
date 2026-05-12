"""
进程监控器 - 检测并关闭所有植物大战僵尸变种
（原版、杂交版、融合版、重制版、Q版、弹幕版、神秘版等）

依赖: pip install psutil pywin32
"""
import psutil
import time
import ctypes
import threading
import sys

# pywin32 用于枚举窗口标题，若未安装则降级为只匹配进程名 / 路径
try:
    import win32gui
    import win32process
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False
    print("[警告] 未安装 pywin32，无法按窗口标题匹配。建议 pip install pywin32")

# ========== 关键词配置 ==========
# 命中"进程名 / 可执行路径 / 窗口标题"任一即判定为目标
KEYWORDS = [
    # —— 英文常见名 ——
    "plantsvszombies",
    "plants vs zombies",
    "plants_vs_zombies",
    "pvz",
    "popcapgame1",      # 原版老 exe 名
    # —— 中文（命中窗口标题或中文 exe 名）——
    "植物大战僵尸",
    # —— 拼音 / 缩写（魔改版常见命名）——
    "pvzhe",            # 杂交版
    "pvzrh",            # 融合版
    "pvzcz",            # 重制版
    "zwdzjs",           # 拼音首字母
    "zhiwudazhanjiangshi",
]

# 进程名白名单（避免误杀，如直播 / 录屏软件标题里出现关键词）
# 全小写
WHITELIST_PROCESS_NAMES = {
    "obs64.exe", "obs32.exe", "obs.exe",
    "bandicam.exe", "ocam.exe",
    "chrome.exe", "msedge.exe", "firefox.exe",  # 浏览器不杀
    "code.exe", "notepad.exe", "explorer.exe",
}

WARNING_MESSAGE = "不要想着玩不在我授权的游戏！"
WARNING_TITLE = "警告"
CHECK_INTERVAL = 2  # 秒


# ========== 匹配逻辑 ==========
def matches_any_keyword(text):
    if not text:
        return False
    text_lower = text.lower()
    return any(k in text_lower for k in KEYWORDS)


def get_window_titles_by_pid():
    """枚举所有可见顶层窗口，返回 {pid: [title, ...]}"""
    pid_to_titles = {}
    if not HAS_WIN32:
        return pid_to_titles

    def callback(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        if not title:
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            pid_to_titles.setdefault(pid, []).append(title)
        except Exception:
            return

    try:
        win32gui.EnumWindows(callback, None)
    except Exception as e:
        print(f"[警告] 窗口枚举失败: {e}")
    return pid_to_titles


def find_targets():
    """扫描全系统，返回 [(pid, name, reason), ...]"""
    targets = []
    pid_to_titles = get_window_titles_by_pid()

    for proc in psutil.process_iter(['pid', 'name', 'exe']):
        try:
            pid = proc.info['pid']
            name = (proc.info['name'] or "")

            # 跳过白名单
            if name.lower() in WHITELIST_PROCESS_NAMES:
                continue

            # 1) 进程名匹配
            if matches_any_keyword(name):
                targets.append((pid, name, f"进程名命中: {name}"))
                continue

            # 2) 可执行文件路径匹配
            exe_path = proc.info.get('exe') or ""
            if matches_any_keyword(exe_path):
                targets.append((pid, name, f"路径命中: {exe_path}"))
                continue

            # 3) 窗口标题匹配（针对完全伪装的魔改版）
            for title in pid_to_titles.get(pid, []):
                if matches_any_keyword(title):
                    targets.append((pid, name, f"窗口标题命中: {title}"))
                    break

        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    return targets


# ========== 执行 ==========
def show_warning_async():
    """异步弹警告，不阻塞监控循环"""
    def _popup():
        # MB_ICONWARNING | MB_TOPMOST | MB_SYSTEMMODAL
        ctypes.windll.user32.MessageBoxW(
            0, WARNING_MESSAGE, WARNING_TITLE, 0x30 | 0x40000 | 0x1000
        )
    threading.Thread(target=_popup, daemon=True).start()


def kill_targets(targets):
    killed_any = False
    for pid, name, reason in targets:
        try:
            psutil.Process(pid).kill()
            killed_any = True
            print(f"[{time.strftime('%H:%M:%S')}] 已关闭: {name} (PID={pid}) | {reason}")
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return killed_any


def main():
    print("=" * 64)
    print("植物大战僵尸 全变种监控已启动")
    print(f"  关键词数量: {len(KEYWORDS)}")
    print(f"  匹配维度: 进程名 / 路径 / 窗口标题{' (窗口标题不可用)' if not HAS_WIN32 else ''}")
    print(f"  检查间隔: {CHECK_INTERVAL} 秒")
    print(f"  白名单: {len(WHITELIST_PROCESS_NAMES)} 个进程")
    print("  按 Ctrl+C 停止")
    print("=" * 64)

    while True:
        try:
            targets = find_targets()
            if targets and kill_targets(targets):
                show_warning_async()
            time.sleep(CHECK_INTERVAL)
        except KeyboardInterrupt:
            print("\n监控已停止")
            sys.exit(0)
        except Exception as e:
            print(f"[错误] {e}")
            time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
