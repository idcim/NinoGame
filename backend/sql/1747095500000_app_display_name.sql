-- Up Migration
-- app_categories 加 display_name (友好名), 供家长后台报表展示
-- "Code.exe" → "Visual Studio Code", "plantsvszombies.exe" → "植物大战僵尸"
-- 来源: seed (预置) / llm (LLM 推断) / parent (家长编辑)
--
-- 顺手修一个老坑: UNIQUE(app_identifier, child_id) 在 child_id IS NULL 时
-- 不真正生效 (Postgres NULL ≠ NULL), 现有 onUnknownApps 的 ON CONFLICT DO NOTHING
-- 会静默生成全局重复行。改用 partial unique index 修掉。
SET search_path TO "NinoGame", public;

ALTER TABLE app_categories
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(128);

-- 清理已有全局重复 (按 app_identifier, 保留 created_at 最早一行)
DELETE FROM app_categories a
 USING app_categories b
 WHERE a.child_id IS NULL
   AND b.child_id IS NULL
   AND a.app_identifier = b.app_identifier
   AND (a.created_at > b.created_at
        OR (a.created_at = b.created_at AND a.id > b.id));

-- 全局 (child_id IS NULL) 唯一索引: 让 ON CONFLICT (app_identifier) WHERE child_id IS NULL 生效
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_categories_global_unique
  ON app_categories(app_identifier) WHERE child_id IS NULL;

-- 预置常见 Windows 进程; ON CONFLICT 只补 display_name, 不覆盖既有 category
INSERT INTO app_categories
  (app_identifier, category, sub_type, rate_multiplier, classification_source, child_id, display_name)
VALUES
  -- 游戏 (consumption)
  ('plantsvszombies.exe',  'consumption', 'game',        1.0, 'system', NULL, '植物大战僵尸'),
  ('popcapgame1.exe',      'consumption', 'game',        1.0, 'system', NULL, '植物大战僵尸 (PopCap)'),
  ('minecraft.exe',        'consumption', 'game',        1.0, 'system', NULL, '我的世界 Minecraft'),
  ('javaw.exe',            'consumption', 'game',        1.0, 'system', NULL, 'Java 应用 (常见: Minecraft)'),
  ('roblox.exe',           'consumption', 'game',        1.0, 'system', NULL, 'Roblox'),
  ('robloxplayerbeta.exe', 'consumption', 'game',        1.0, 'system', NULL, 'Roblox Player'),
  ('steam.exe',            'consumption', 'game',        1.0, 'system', NULL, 'Steam 平台'),
  ('genshinimpact.exe',    'consumption', 'game',        1.0, 'system', NULL, '原神'),
  ('yuanshen.exe',         'consumption', 'game',        1.0, 'system', NULL, '原神 (国服)'),
  ('league of legends.exe','consumption', 'game',        1.0, 'system', NULL, '英雄联盟 LOL'),
  ('wegame.exe',           'consumption', 'game',        1.0, 'system', NULL, 'WeGame 游戏平台'),
  ('hearthstone.exe',      'consumption', 'game',        1.0, 'system', NULL, '炉石传说'),
  ('overwatch.exe',        'consumption', 'game',        1.0, 'system', NULL, '守望先锋'),
  ('csgo.exe',             'consumption', 'game',        1.0, 'system', NULL, 'CS:GO'),
  ('cs2.exe',              'consumption', 'game',        1.0, 'system', NULL, 'Counter-Strike 2'),
  ('terraria.exe',         'consumption', 'game',        1.0, 'system', NULL, '泰拉瑞亚'),
  ('factorio.exe',         'consumption', 'game',        1.0, 'system', NULL, '异星工厂'),
  ('starsector.exe',       'consumption', 'game',        1.0, 'system', NULL, 'Starsector'),
  ('dontstarvetogether.exe','consumption','game',        1.0, 'system', NULL, '饥荒联机版'),
  ('among us.exe',         'consumption', 'game',        1.0, 'system', NULL, 'Among Us'),

  -- 视频 / 短视频
  ('bilibili.exe',         'consumption', 'video',       1.0, 'system', NULL, '哔哩哔哩'),
  ('bilibili-rumtime.exe', 'consumption', 'video',       1.0, 'system', NULL, '哔哩哔哩 Runtime'),
  ('iqiyi.exe',            'consumption', 'video',       1.0, 'system', NULL, '爱奇艺'),
  ('youku.exe',            'consumption', 'video',       1.0, 'system', NULL, '优酷'),
  ('qqlive.exe',           'consumption', 'video',       1.0, 'system', NULL, '腾讯视频'),
  ('douyin.exe',           'consumption', 'short_video', 1.0, 'system', NULL, '抖音'),
  ('kuaishou.exe',         'consumption', 'short_video', 1.0, 'system', NULL, '快手'),
  ('tiktok.exe',           'consumption', 'short_video', 1.0, 'system', NULL, 'TikTok'),
  ('netflix.exe',          'consumption', 'video',       1.0, 'system', NULL, 'Netflix'),
  ('vlc.exe',              'consumption', 'video',       1.0, 'system', NULL, 'VLC 媒体播放器'),
  ('potplayermini64.exe',  'consumption', 'video',       1.0, 'system', NULL, 'PotPlayer'),
  ('potplayermini.exe',    'consumption', 'video',       1.0, 'system', NULL, 'PotPlayer'),

  -- 社交
  ('qqnt.exe',             'consumption', 'social',      1.0, 'system', NULL, 'QQ NT'),
  ('weixin.exe',           'consumption', 'social',      1.0, 'system', NULL, '微信'),
  ('wechat.exe',           'consumption', 'social',      1.0, 'system', NULL, '微信 (旧)'),
  ('telegram.exe',         'consumption', 'social',      1.0, 'system', NULL, 'Telegram'),
  ('discord.exe',          'consumption', 'social',      1.0, 'system', NULL, 'Discord'),

  -- 浏览器 / 系统 / 办公 / 音乐 (neutral)
  ('chrome.exe',           'neutral',     'browser',     1.0, 'system', NULL, 'Google Chrome'),
  ('msedge.exe',           'neutral',     'browser',     1.0, 'system', NULL, 'Microsoft Edge'),
  ('firefox.exe',          'neutral',     'browser',     1.0, 'system', NULL, 'Firefox'),
  ('brave.exe',            'neutral',     'browser',     1.0, 'system', NULL, 'Brave 浏览器'),
  ('opera.exe',            'neutral',     'browser',     1.0, 'system', NULL, 'Opera'),
  ('360se.exe',            'neutral',     'browser',     1.0, 'system', NULL, '360 安全浏览器'),
  ('360chrome.exe',        'neutral',     'browser',     1.0, 'system', NULL, '360 极速浏览器'),
  ('qqbrowser.exe',        'neutral',     'browser',     1.0, 'system', NULL, 'QQ 浏览器'),
  ('sogouexplorer.exe',    'neutral',     'browser',     1.0, 'system', NULL, '搜狗浏览器'),
  ('explorer.exe',         'neutral',     'system',      1.0, 'system', NULL, 'Windows 资源管理器'),
  ('searchhost.exe',       'neutral',     'system',      1.0, 'system', NULL, 'Windows 搜索'),
  ('systemsettings.exe',   'neutral',     'system',      1.0, 'system', NULL, 'Windows 设置'),
  ('taskmgr.exe',          'neutral',     'system',      1.0, 'system', NULL, '任务管理器'),
  ('cmd.exe',              'neutral',     'system',      1.0, 'system', NULL, '命令提示符'),
  ('powershell.exe',       'neutral',     'system',      1.0, 'system', NULL, 'PowerShell'),
  ('windowsterminal.exe',  'neutral',     'system',      1.0, 'system', NULL, 'Windows 终端'),
  ('notepad.exe',          'neutral',     'note',        1.0, 'system', NULL, '记事本'),
  ('notepad++.exe',        'neutral',     'note',        1.0, 'system', NULL, 'Notepad++'),
  ('wpsoffice.exe',        'neutral',     'office',      1.0, 'system', NULL, 'WPS Office'),
  ('winword.exe',          'neutral',     'office',      1.0, 'system', NULL, 'Microsoft Word'),
  ('excel.exe',            'neutral',     'office',      1.0, 'system', NULL, 'Microsoft Excel'),
  ('powerpnt.exe',         'neutral',     'office',      1.0, 'system', NULL, 'Microsoft PowerPoint'),
  ('outlook.exe',          'neutral',     'messaging',   1.0, 'system', NULL, 'Microsoft Outlook'),
  ('foxitreader.exe',      'neutral',     'reading',     1.0, 'system', NULL, '福昕 PDF 阅读器'),
  ('acrobat.exe',          'neutral',     'reading',     1.0, 'system', NULL, 'Adobe Acrobat'),
  ('acrord32.exe',         'neutral',     'reading',     1.0, 'system', NULL, 'Adobe Reader'),
  ('sumatrapdf.exe',       'neutral',     'reading',     1.0, 'system', NULL, 'SumatraPDF'),
  ('cloudmusic.exe',       'neutral',     'music',       1.0, 'system', NULL, '网易云音乐'),
  ('qqmusic.exe',          'neutral',     'music',       1.0, 'system', NULL, 'QQ 音乐'),
  ('spotify.exe',          'neutral',     'music',       1.0, 'system', NULL, 'Spotify'),

  -- 学习 / 创作 (productive)
  ('code.exe',             'productive',  'code',        1.0, 'system', NULL, 'Visual Studio Code'),
  ('code - insiders.exe',  'productive',  'code',        1.0, 'system', NULL, 'VS Code Insiders'),
  ('cursor.exe',           'productive',  'code',        1.0, 'system', NULL, 'Cursor'),
  ('pycharm64.exe',        'productive',  'code',        1.0, 'system', NULL, 'PyCharm'),
  ('idea64.exe',           'productive',  'code',        1.0, 'system', NULL, 'IntelliJ IDEA'),
  ('webstorm64.exe',       'productive',  'code',        1.0, 'system', NULL, 'WebStorm'),
  ('clion64.exe',          'productive',  'code',        1.0, 'system', NULL, 'CLion'),
  ('rider64.exe',          'productive',  'code',        1.0, 'system', NULL, 'JetBrains Rider'),
  ('devenv.exe',           'productive',  'code',        1.0, 'system', NULL, 'Visual Studio'),
  ('android studio.exe',   'productive',  'code',        1.0, 'system', NULL, 'Android Studio'),
  ('sublime_text.exe',     'productive',  'code',        1.0, 'system', NULL, 'Sublime Text'),
  ('atom.exe',             'productive',  'code',        1.0, 'system', NULL, 'Atom'),
  ('scratch.exe',          'productive',  'create',      1.0, 'system', NULL, 'Scratch'),
  ('blender.exe',          'productive',  'create',      1.0, 'system', NULL, 'Blender'),
  ('photoshop.exe',        'productive',  'create',      1.0, 'system', NULL, 'Adobe Photoshop'),
  ('illustrator.exe',      'productive',  'create',      1.0, 'system', NULL, 'Adobe Illustrator'),
  ('premiere.exe',         'productive',  'create',      1.0, 'system', NULL, 'Adobe Premiere'),
  ('aftereffects.exe',     'productive',  'create',      1.0, 'system', NULL, 'After Effects'),
  ('figma.exe',            'productive',  'create',      1.0, 'system', NULL, 'Figma'),
  ('krita.exe',            'productive',  'create',      1.0, 'system', NULL, 'Krita'),
  ('obsidian.exe',         'productive',  'note',        1.0, 'system', NULL, 'Obsidian'),
  ('typora.exe',           'productive',  'note',        1.0, 'system', NULL, 'Typora'),
  ('logseq.exe',           'productive',  'note',        1.0, 'system', NULL, 'Logseq'),
  ('anki.exe',             'productive',  'reading',     1.0, 'system', NULL, 'Anki'),
  ('kindle.exe',           'productive',  'reading',     1.0, 'system', NULL, 'Kindle for PC'),
  ('duolingo.exe',         'productive',  'reading',     1.0, 'system', NULL, '多邻国 Duolingo')
ON CONFLICT (app_identifier) WHERE child_id IS NULL
DO UPDATE SET display_name = COALESCE(app_categories.display_name, EXCLUDED.display_name);

-- Down Migration
SET search_path TO "NinoGame", public;
DELETE FROM app_categories WHERE classification_source = 'system';
DROP INDEX IF EXISTS "NinoGame".idx_app_categories_global_unique;
ALTER TABLE app_categories DROP COLUMN IF EXISTS display_name;
