import { useEffect, useState } from "react";
import {
  Check,
  Eye,
  EyeOff,
  Loader2,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { api, ApiError, type LlmConfigMasked } from "../lib/api";

/** 预设: 选中后自动填 base_url + model. 用户可自由覆盖. */
interface ProviderPreset {
  key: string;
  label: string;
  provider: "openai_compatible" | "anthropic";
  base_url: string;
  default_model: string;
  hint?: string;
}

const PRESETS: ProviderPreset[] = [
  {
    key: "openai",
    label: "OpenAI",
    provider: "openai_compatible",
    base_url: "https://api.openai.com/v1",
    default_model: "gpt-4o-mini",
    hint: "key 形如 sk-...",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    provider: "openai_compatible",
    base_url: "https://api.deepseek.com/v1",
    default_model: "deepseek-chat",
    hint: "国内可直连; key 在 platform.deepseek.com 申请",
  },
  {
    key: "qwen",
    label: "Qwen (阿里 DashScope)",
    provider: "openai_compatible",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model: "qwen-turbo",
    hint: "DashScope OpenAI 兼容模式",
  },
  {
    key: "moonshot",
    label: "Moonshot (Kimi)",
    provider: "openai_compatible",
    base_url: "https://api.moonshot.cn/v1",
    default_model: "moonshot-v1-8k",
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    provider: "openai_compatible",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    default_model: "glm-4-flash",
  },
  {
    key: "anthropic",
    label: "Anthropic Claude",
    provider: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-haiku-4-5-20251001",
    hint: "走 /v1/messages, 内置专门 adapter",
  },
  {
    key: "custom",
    label: "自定义 (OpenAI 兼容)",
    provider: "openai_compatible",
    base_url: "",
    default_model: "",
    hint: "自建 LLM Gateway / Ollama / vLLM 等",
  },
];

export default function Llm() {
  const [cfg, setCfg] = useState<LlmConfigMasked | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 表单
  const [selectedPreset, setSelectedPreset] = useState<string>("deepseek");
  const [providerKind, setProviderKind] = useState<"openai_compatible" | "anthropic">("openai_compatible");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("");
  const [showKey, setShowKey] = useState<boolean>(false);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);

  // 测试
  const [testing, setTesting] = useState(false);
  const [testPrompt, setTestPrompt] = useState<string>("你好, 一句话介绍你自己。");
  const [testResult, setTestResult] = useState<{ ok: boolean; reply: string; ms: number; error?: string } | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.getLlm();
      setCfg(r.config);
      if (r.config) {
        setProviderKind(r.config.provider as "openai_compatible" | "anthropic");
        setBaseUrl(r.config.base_url);
        setModel(r.config.model);
        setEnabled(r.config.enabled);
        // api_key 不回填, 用户重新输入 (或留空保留旧 key — 但后端会覆盖, 所以必填)
        // 匹配预设
        const matched = PRESETS.find(
          (p) => p.base_url === r.config!.base_url && p.provider === r.config!.provider,
        );
        if (matched) setSelectedPreset(matched.key);
        else setSelectedPreset("custom");
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function applyPreset(key: string) {
    setSelectedPreset(key);
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    setProviderKind(p.provider);
    if (p.base_url) setBaseUrl(p.base_url);
    if (p.default_model) setModel(p.default_model);
  }

  async function save() {
    setErr(null);
    setMsg(null);
    if (!apiKey || apiKey.length < 8) {
      setErr("api_key 至少 8 字符");
      return;
    }
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      setErr("base_url 必须是 http(s):// 开头");
      return;
    }
    if (!model) {
      setErr("model 必填");
      return;
    }
    setSaving(true);
    try {
      const r = await api.saveLlm({
        provider: providerKind,
        api_key: apiKey,
        base_url: baseUrl,
        model,
        enabled,
      });
      setCfg(r.config);
      setApiKey(""); // 保存成功后清空表单 key, 避免明文留在 DOM
      setMsg("✓ 已保存");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testLlm(testPrompt);
      setTestResult(r);
    } catch (e) {
      setTestResult({
        ok: false,
        reply: "",
        ms: 0,
        error: e instanceof ApiError ? e.message : "未知错误",
      });
    } finally {
      setTesting(false);
    }
  }

  async function del() {
    if (!confirm("删除当前 LLM 配置? 删了后所有依赖 LLM 的功能会自动降级。")) return;
    try {
      await api.deleteLlm();
      setCfg(null);
      setApiKey("");
      setMsg("已删除");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "删除失败");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <Sparkles size={22} className="text-brand" />
          LLM 配置
        </h1>
        <p className="text-sm text-ink-dim mt-1">
          配置任意 OpenAI 兼容平台 (OpenAI / DeepSeek / Qwen / Moonshot / 智谱 / 自建),
          或 Anthropic Claude。用于申请翻译、应用分类等 P3 智能助手功能。
        </p>
      </div>

      {err && (
        <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>
      )}
      {msg && (
        <div className="card p-4 text-accent-600 bg-accent/5 border-accent/30">{msg}</div>
      )}

      {/* 当前状态 */}
      <section>
        <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
          当前配置
        </h2>
        <div className="card p-5">
          {loading ? (
            <div className="text-sm text-ink-dim flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> 加载...
            </div>
          ) : !cfg ? (
            <div className="text-sm text-ink-dim">
              还没配置 LLM。下面填写并保存即可启用 (依赖 LLM 的功能在未配置时会自动降级)。
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <Row label="Provider" value={cfg.provider} />
              <Row label="Base URL" value={<span className="font-mono">{cfg.base_url}</span>} />
              <Row label="Model" value={<span className="font-mono">{cfg.model}</span>} />
              <Row label="API Key" value={<span className="font-mono text-ink-dim">{cfg.api_key_masked}</span>} />
              <Row
                label="状态"
                value={
                  cfg.enabled ? (
                    <span className="badge badge-success">已启用</span>
                  ) : (
                    <span className="badge badge-muted">已禁用</span>
                  )
                }
              />
              <Row label="最近更新" value={cfg.updated_at ? new Date(cfg.updated_at).toLocaleString() : "—"} />
              <div className="pt-3 flex gap-2">
                <button onClick={del} className="btn-ghost text-warn">
                  <Trash2 size={14} />
                  删除配置
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 配置表单 */}
      <section>
        <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
          {cfg ? "修改配置" : "添加配置"}
        </h2>
        <div className="card p-5 space-y-4">
          <div>
            <label className="label">服务商预设</label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p.key)}
                  className={
                    "px-3 py-1.5 rounded-md text-sm border transition-colors " +
                    (p.key === selectedPreset
                      ? "bg-brand text-white border-brand"
                      : "bg-bg-card border-border text-ink-dim hover:text-ink")
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-light mt-2">
              {PRESETS.find((p) => p.key === selectedPreset)?.hint ?? ""}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Provider 类型</label>
              <select
                className="input"
                value={providerKind}
                onChange={(e) => setProviderKind(e.target.value as "openai_compatible" | "anthropic")}
              >
                <option value="openai_compatible">OpenAI 兼容 (大多数)</option>
                <option value="anthropic">Anthropic Claude</option>
              </select>
            </div>
            <div>
              <label className="label">Model</label>
              <input
                className="input font-mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="如 gpt-4o-mini / deepseek-chat / qwen-turbo"
              />
            </div>
          </div>

          <div>
            <label className="label">Base URL</label>
            <input
              className="input font-mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="如 https://api.openai.com/v1"
            />
            <p className="text-xs text-ink-light mt-1">
              通常以 <code>/v1</code> 结尾。OpenAI 兼容 API 会自动拼 <code>/chat/completions</code>。
            </p>
          </div>

          <div>
            <label className="label">API Key</label>
            <div className="flex items-center gap-2">
              <input
                type={showKey ? "text" : "password"}
                className="input font-mono flex-1"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={cfg ? "留空保留当前 (其实会被覆盖, 必填新 key)" : "sk-... 或平台 token"}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="btn-ghost"
                title={showKey ? "隐藏" : "显示"}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-xs text-ink-light mt-1">
              保存后 key 仅显示前 4 + 后 4; 完整 key 不会再返回前端。
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <label htmlFor="enabled" className="text-sm text-ink">
              启用 (取消则配置保留但所有 LLM 功能降级)
            </label>
          </div>

          <div className="flex gap-2 justify-end">
            <button onClick={save} disabled={saving} className="btn-primary">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </section>

      {/* 连通测试 */}
      <section>
        <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
          连通测试
        </h2>
        <div className="card p-5 space-y-3">
          {!cfg ? (
            <p className="text-sm text-ink-dim">先保存配置再测试。</p>
          ) : (
            <>
              <div>
                <label className="label">测试 prompt</label>
                <input
                  className="input"
                  value={testPrompt}
                  onChange={(e) => setTestPrompt(e.target.value)}
                  placeholder="测试用一句话"
                />
              </div>
              <div className="flex justify-end">
                <button onClick={test} disabled={testing} className="btn-primary">
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                  {testing ? "测试中..." : "测试一下"}
                </button>
              </div>
              {testResult && (
                <div
                  className={
                    "rounded px-3 py-2 text-sm border " +
                    (testResult.ok
                      ? "bg-accent/10 border-accent/30 text-ink"
                      : "bg-warn/10 border-warn/30 text-warn")
                  }
                >
                  {testResult.ok ? (
                    <>
                      <div className="font-semibold mb-1">
                        ✓ 成功 · 耗时 {testResult.ms} ms
                      </div>
                      <div className="whitespace-pre-wrap text-ink-dim">{testResult.reply}</div>
                    </>
                  ) : (
                    <>
                      <div className="font-semibold mb-1">× 失败 · 耗时 {testResult.ms} ms</div>
                      <div className="text-warn">{testResult.error || "未知错误"}</div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-ink-light w-24 shrink-0">{label}</span>
      <span className="text-ink flex-1">{value}</span>
    </div>
  );
}
