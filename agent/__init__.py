"""NinoGame Agent."""
# 升版时同步改 agent/main.py 顶部的 AGENT_VERSION 常量 + 这里。
# 历史版本:
#   0.1.0 - P1 模块骨架 + P2 远程控制 MVP + P3 LLM/规则
#   0.2.0 - 状态面板/浮层 UX 大改, "余额" 概念统一为 Token, AboutDialog
#   0.3.0 - 无感软件更新 (server 推 update_self → Lock 态 → Updater.exe 接管 + 自动回滚)
#   0.4.0 - 独立管理后台 (admin.{domain}) + 存储驱动抽象 (local/S3/OSS) + 多租户接缝
__version__ = "0.4.0"
