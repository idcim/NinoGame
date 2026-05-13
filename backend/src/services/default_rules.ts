/** 创建孩子时自动 seed 一条默认规则 (PvZ 全家桶)。
 *
 * 用途: 家长创建孩子后不用再手动打开 /rules 加规则; 配对的 Agent
 * 第一次 hello_ack 就能拿到这条规则, 默认拦截 PvZ 全变种。
 *
 * 规则内容参考 agent/store/seed_data.py 里 P0 沉淀下来的 PVZ_KEYWORDS;
 * id 用 PG 默认的 gen_random_uuid() (家长后续编辑时按 UUID 引用).
 */
import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";

const PVZ_KEYWORDS = [
  "plantsvszombies",
  "plants vs zombies",
  "plants_vs_zombies",
  "pvz",
  "popcapgame1",
  "植物大战僵尸",
  "pvzhe",
  "pvzrh",
  "pvzcz",
  "zwdzjs",
  "zhiwudazhanjiangshi",
];

const PVZ_EXCLUDE_PROCESSES = [
  "obs64.exe", "obs32.exe", "obs.exe",
  "bandicam.exe", "ocam.exe",
  "chrome.exe", "msedge.exe", "firefox.exe",
  "code.exe", "notepad.exe", "explorer.exe",
];

function buildPvzMatchers() {
  const fields = ["process_name", "exe_path", "window_title"];
  const out: Array<{ field: string; op: string; value: string }> = [];
  for (const kw of PVZ_KEYWORDS) {
    for (const f of fields) {
      out.push({ field: f, op: "icontains", value: kw });
    }
  }
  return out;
}

export function buildPvzRuleSpec() {
  return {
    matchers: buildPvzMatchers(),
    matcher_logic: "OR",
    exclude_processes: PVZ_EXCLUDE_PROCESSES,
    schedule: { mode: "always", windows: [] },
    action: {
      type: "kill_and_warn",
      message: "不要想着玩不在我授权的游戏!",
    },
    category_link: "consumption_game_pvz",
    notify_parent: true,
  };
}

/** 给指定孩子 seed 默认规则。如果已存在同名规则就跳过 (幂等)。 */
export async function seedDefaultRulesForChild(
  client: PoolClient,
  child_id: string,
  log?: FastifyBaseLogger,
): Promise<number> {
  // 幂等: 已经有任何同名规则就不重复 seed
  const existing = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "NinoGame".rules
      WHERE child_id = $1 AND name = $2`,
    [child_id, "PvZ 全家桶"],
  );
  if (Number(existing.rows[0].count) > 0) {
    return 0;
  }

  const spec = buildPvzRuleSpec();
  await client.query(
    `INSERT INTO "NinoGame".rules (child_id, name, enabled, spec)
     VALUES ($1, $2, TRUE, $3::jsonb)`,
    [child_id, "PvZ 全家桶", JSON.stringify(spec)],
  );
  log?.info({ child_id }, "seeded default PvZ rule for new child");
  return 1;
}
