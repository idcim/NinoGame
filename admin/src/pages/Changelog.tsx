import { useEffect, useMemo, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { api, ApiError } from "../lib/api";

/** Changelog 页 — 拉 backend /api/changelog (CHANGELOG.md 内容) 渲染.
 *
 * v0.4.9+: 让 admin 不用每次发版都改前端代码; CHANGELOG.md 在 repo 根, backend
 * 通过 docker-compose volume 挂进容器, 改 markdown → restart backend (或缓存 60s 自然过期) 即生效。
 *
 * 渲染策略: 轻量自实现 markdown 子集 (## 标题 / 列表 / **粗体** / `code` / 段落),
 * 不引第三方 markdown 库 — 节省 admin bundle.
 */
export default function Changelog() {
  const [content, setContent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.getChangelog();
        setContent(r.content);
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const rendered = useMemo(() => (content ? renderMarkdown(content) : null), [content]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <FileText size={22} className="text-brand" />
          更新日志
        </h1>
        <p className="text-sm text-ink-dim mt-1">
          所有跨端 (Backend / Admin / Frontend / Win Agent / Android Agent) 版本变化。CHANGELOG.md 在 repo 根, backend 缓存 60s。
        </p>
      </div>

      {loading && (
        <div className="card p-8 text-center text-ink-dim">
          <Loader2 size={20} className="animate-spin mx-auto mb-2" />加载中…
        </div>
      )}

      {err && !loading && (
        <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>
      )}

      {rendered && (
        <article className="card p-6 prose-changelog">{rendered}</article>
      )}
    </div>
  );
}

/** 轻量 markdown 子集渲染. 只覆盖 CHANGELOG.md 实际用到的 4 种结构:
 *    # / ## 标题
 *    > blockquote
 *    - / * 列表项 (含子级 inline `code` / **粗体**)
 *    段落
 *  没有图片 / 表格 / 多级嵌套列表 — 真要那些升 react-markdown.  */
function renderMarkdown(md: string): JSX.Element {
  const lines = md.split(/\r?\n/);
  const blocks: JSX.Element[] = [];
  let listItems: JSX.Element[] = [];
  let paraLines: string[] = [];
  let blockIdx = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`list-${blockIdx++}`} className="list-disc pl-6 space-y-1 my-3 text-ink">
        {listItems}
      </ul>,
    );
    listItems = [];
  };
  const flushPara = () => {
    if (paraLines.length === 0) return;
    const text = paraLines.join(" ").trim();
    if (text) {
      blocks.push(
        <p key={`p-${blockIdx++}`} className="my-2 text-sm text-ink-dim leading-relaxed">
          {renderInline(text)}
        </p>,
      );
    }
    paraLines = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      flushPara();
      continue;
    }
    const h1 = line.match(/^# (.+)$/);
    if (h1) {
      flushList();
      flushPara();
      blocks.push(
        <h1 key={`h1-${blockIdx++}`} className="text-xl font-bold text-ink mt-6 mb-2">
          {h1[1]}
        </h1>,
      );
      continue;
    }
    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      flushList();
      flushPara();
      blocks.push(
        <h2 key={`h2-${blockIdx++}`} className="text-base font-bold text-brand-700 mt-5 mb-1.5 border-b border-border/60 pb-1">
          {h2[1]}
        </h2>,
      );
      continue;
    }
    const li = line.match(/^[-*] (.+)$/);
    if (li) {
      flushPara();
      listItems.push(
        <li key={`li-${blockIdx++}`} className="text-sm text-ink">
          {renderInline(li[1])}
        </li>,
      );
      continue;
    }
    const bq = line.match(/^> (.+)$/);
    if (bq) {
      flushList();
      flushPara();
      blocks.push(
        <blockquote key={`bq-${blockIdx++}`} className="border-l-4 border-brand/30 pl-3 my-3 text-xs text-ink-dim italic">
          {renderInline(bq[1])}
        </blockquote>,
      );
      continue;
    }
    paraLines.push(line);
  }
  flushList();
  flushPara();

  return <>{blocks}</>;
}

/** Inline 渲染: `code` 和 **bold** 两种, 顺序不限. 简单状态机, 不上 regex 灾难. */
function renderInline(s: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let i = 0;
  let buf = "";
  let key = 0;
  const flushBuf = () => {
    if (buf) {
      parts.push(buf);
      buf = "";
    }
  };
  while (i < s.length) {
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end === -1) {
        buf += s[i];
        i++;
        continue;
      }
      flushBuf();
      parts.push(
        <code key={`c-${key++}`} className="px-1 py-0.5 rounded bg-bg-soft text-brand-700 font-mono text-[0.85em]">
          {s.slice(i + 1, end)}
        </code>,
      );
      i = end + 1;
      continue;
    }
    if (s[i] === "*" && s[i + 1] === "*") {
      const end = s.indexOf("**", i + 2);
      if (end === -1) {
        buf += s[i];
        i++;
        continue;
      }
      flushBuf();
      parts.push(
        <strong key={`b-${key++}`} className="font-semibold text-ink">
          {s.slice(i + 2, end)}
        </strong>,
      );
      i = end + 2;
      continue;
    }
    buf += s[i];
    i++;
  }
  flushBuf();
  return parts;
}
