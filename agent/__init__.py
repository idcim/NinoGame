"""NinoGame Agent."""
# 升版时同步改 agent/main.py 顶部的 AGENT_VERSION 常量 + 这里。
# 历史版本:
#   0.1.0 - P1 模块骨架 + P2 远程控制 MVP + P3 LLM/规则
#   0.2.0 - 状态面板/浮层 UX 大改, "余额" 概念统一为 Token, AboutDialog
#   0.3.0 - 无感软件更新 (server 推 update_self → Lock 态 → Updater.exe 接管 + 自动回滚)
#   0.4.0 - 独立管理后台 (admin.{domain}) + 存储驱动抽象 (local/S3/OSS) + 多租户接缝
#   0.4.1 - About 对话框接入 /api/changelog 跨端更新日志 (跟 admin / Android 同源)
#   0.4.2 - OOT 切家长 PIN 安全修: 没设 PIN 时拒绝切 (防孩子绕过锁屏免验证逃逸)
#   0.4.3 - 家长 PIN 主从同步 (server 持 hash+salt, hello_ack/pin_sync 推送; 多设备共享)
__version__ = "0.4.3"
