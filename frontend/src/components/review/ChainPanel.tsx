import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { QuoteStockRow } from "@/components/cockpit/QuoteStockRow";
import { ChainEditorDialog, type ChainEditorState, type ChainParseState } from "@/components/review/ChainEditorDialog";
import { CHAINS, matchRelatedBoards, type Chain, type ChainStock } from "@/config/chains";
import { Chip, ChipGroup } from "@/components/ui/SectionHeader";
import { pctColor } from "@/components/review/format";
import { useElementSize } from "@/hooks/useElementSize";
import { usePolling } from "@/hooks/usePolling";
import { api, type ClsTelegraphItem, type SectorBoard } from "@/lib/api";
import {
  buildChainFromParse,
  isCustomChain,
  loadCustomChains,
  parseChainText,
  saveCustomChains,
  updateChainSegments,
} from "@/lib/chainParse";
import { sparkFromKline } from "@/lib/lightKline";
import { useMinutes } from "@/lib/minuteHub";
import { useQuotes } from "@/lib/quoteHub";
import { useTelegraph } from "@/lib/telegraphHub";
import { cn } from "@/lib/utils";
import { storageGet, storageSet } from "@/lib/storage";

const CHAIN_KEY = "ashare.review.chain";
const OVERRIDE_KEY = "ashare.review.chain.override";

type OverrideMap = Record<string, { segments: Array<{ stocks: ChainStock[] }> }>;

function loadOverrides(): OverrideMap {
  const raw = storageGet(OVERRIDE_KEY);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as OverrideMap;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function newsTime(t: string): string {
  return t.slice(11, 16) || t.slice(-8, -3) || "—";
}

function ChainSide({
  tech,
  news,
  loading,
}: {
  tech: string[];
  news: ClsTelegraphItem[];
  loading: boolean;
}) {
  return (
    <div className="flex w-[240px] shrink-0 flex-col border-l border-slate-700/40">
      {tech.length > 0 && (
        <div className="border-b border-slate-700/40 p-2">
          <div className="mb-1 text-[10px] font-semibold text-slate-300">行业关键技术</div>
          <div className="flex flex-wrap gap-1">
            {tech.map((t) => (
              <span
                key={t}
                className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-px text-[9px] text-emerald-300"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <div className="mb-1 px-0.5 text-[10px] font-semibold text-slate-300">
          行业热点新闻
          <span className="ml-1 text-[9px] font-normal text-slate-500">关键词 · {news.length}条</span>
        </div>
        {loading && news.length === 0 && (
          <p className="p-3 text-center text-[10px] text-slate-600">加载中…</p>
        )}
        {!loading && news.length === 0 && (
          <p className="p-3 text-center text-[10px] text-slate-600">当前快讯流中暂无该产业链相关新闻</p>
        )}
        <div className="space-y-0.5">
          {news.map((n, i) => (
            <div key={String(n.id ?? `${n.time}-${i}`)} className="rounded px-1.5 py-1">
              <div className="font-mono text-[9px] tabular-nums text-slate-500">{newsTime(n.time || "")}</div>
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-[1.5] text-slate-300">
                {n.title ? <span className="font-semibold text-slate-200">{n.title} </span> : null}
                {n.content && n.content !== n.title ? n.content : n.summary}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Upstream / mid / downstream chain with live quotes, related boards, iwencai refresh. */
export function ChainPanel() {
  const [customChains, setCustomChains] = useState<Chain[]>(loadCustomChains);
  const allChains = useMemo(() => [...CHAINS, ...customChains], [customChains]);
  const [id, setId] = useState(() => {
    const s = storageGet(CHAIN_KEY);
    const all = [...CHAINS, ...loadCustomChains()];
    return s && all.some((c) => c.id === s) ? s : CHAINS[0].id;
  });
  const [overrides, setOverrides] = useState<OverrideMap>(loadOverrides);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [iwencaiReady, setIwencaiReady] = useState(false);
  const [editor, setEditor] = useState<ChainEditorState | null>(null);
  const [parseState, setParseState] = useState<ChainParseState>({ loading: false, error: "", warnings: [] });
  const base = allChains.find((c) => c.id === id) ?? CHAINS[0];
  const ov = overrides[id];
  const chain = useMemo(() => {
    if (!ov?.segments?.length) return base;
    return {
      ...base,
      segments: base.segments.map((seg, i) => ({
        ...seg,
        stocks: ov.segments[i]?.stocks?.length ? ov.segments[i].stocks : seg.stocks,
      })),
    };
  }, [base, ov]);
  const codes = useMemo(
    () => chain.segments.flatMap((s) => s.stocks.map((x) => x.code)),
    [chain],
  );
  const quotes = useQuotes(codes);
  const minutes = useMinutes(codes);
  const { ref: boxRef, size } = useElementSize();
  const showSide = size.w >= 920;
  const wide = (showSide ? size.w - 240 : size.w) >= 720;
  const snap = useTelegraph();
  const newsItems = snap.cls?.items ?? [];
  const chainNews = useMemo(() => {
    const keys = chain.keywords.filter(Boolean);
    if (!keys.length) return [];
    return newsItems
      .filter((n) => {
        const t = `${n.title}${n.content || n.summary || ""}`;
        return keys.some((k) => t.includes(k));
      })
      .slice(0, 10);
  }, [newsItems, chain]);
  const { data: boards } = usePolling(async () => {
    const [ind, con] = await Promise.all([
      api.sectorBoards("01", "0", 40),
      api.sectorBoards("02", "0", 40),
    ]);
    const seen = new Set<string>();
    const out: SectorBoard[] = [];
    for (const b of [...(ind || []), ...(con || [])]) {
      const k = b.name || b.code;
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(b);
    }
    return out;
  }, 60_000, [id]);
  const related = useMemo(
    () => matchRelatedBoards(boards || [], chain.keywords, 8),
    [boards, chain],
  );

  useEffect(() => {
    storageSet(CHAIN_KEY, id);
  }, [id]);

  useEffect(() => {
    void api.iwencaiStatus().then((s) => setIwencaiReady(!!s.configured)).catch(() => setIwencaiReady(false));
  }, []);

  const refresh = async () => {
    if (busy) return;
    if (!iwencaiReady) {
      setErr("未配置问财 key");
      return;
    }
    if (!base.segments.some((s) => s.query)) {
      setErr("该产业链未配置问财查询语");
      return;
    }
    setBusy(true);
    setErr("");
    const segs: Array<{ stocks: ChainStock[] }> = [];
    let first = "";
    let got = 0;
    for (const seg of base.segments) {
      if (!seg.query) {
        segs.push({ stocks: seg.stocks });
        continue;
      }
      try {
        const r = await api.iwencaiSelect(seg.query, 8);
        const stocks = (r.rows || [])
          .map((row) => ({ code: row.code, name: row.name, tag: seg.desc.split("·")[0]?.trim() }))
          .filter((s) => /^\d{6}$/.test(s.code))
          .slice(0, 8);
        if (stocks.length) {
          segs.push({ stocks });
          got += stocks.length;
        } else {
          segs.push({ stocks: seg.stocks });
        }
      } catch (e) {
        if (!first) first = e instanceof Error ? e.message : String(e);
        segs.push({ stocks: seg.stocks });
      }
    }
    if (got === 0) {
      setErr(first || "问财未返回名单");
      setBusy(false);
      return;
    }
    const next = { ...overrides, [id]: { segments: segs } };
    setOverrides(next);
    storageSet(OVERRIDE_KEY, JSON.stringify(next));
    setBusy(false);
  };

  const openEditor = (mode: "add" | "update") => {
    setParseState({ loading: false, error: "", warnings: [] });
    setEditor({ mode, name: mode === "update" ? chain.name : "", content: "" });
  };

  const persistCustom = (next: Chain[]) => {
    setCustomChains(next);
    saveCustomChains(next);
  };

  const deleteCustom = (cid: string) => {
    const next = customChains.filter((c) => c.id !== cid);
    persistCustom(next);
    const ovNext = { ...overrides };
    delete ovNext[cid];
    setOverrides(ovNext);
    storageSet(OVERRIDE_KEY, JSON.stringify(ovNext));
    if (id === cid) setId(CHAINS[0].id);
  };

  const submitEditor = () => {
    if (!editor || parseState.loading) return;
    const name = editor.name.trim();
    const content = editor.content.trim();
    if (!name || !content) {
      setParseState({ loading: false, error: "请填写名称并粘贴问财内容", warnings: [] });
      return;
    }
    const parsed = parseChainText(name, content);
    const n = parsed.segments.reduce((s, seg) => s + seg.stocks.length, 0);
    if (n === 0) {
      setParseState({ loading: false, error: parsed.warnings[0] || "未解析出股票", warnings: parsed.warnings });
      return;
    }
    if (editor.mode === "add") {
      const created = buildChainFromParse(name, parsed);
      persistCustom([...customChains, created]);
      setId(created.id);
    } else if (isCustomChain(id)) {
      persistCustom(customChains.map((c) => (
        c.id === id ? { ...c, segments: updateChainSegments(c.segments, parsed) } : c
      )));
      const ovNext = { ...overrides };
      delete ovNext[id];
      setOverrides(ovNext);
      storageSet(OVERRIDE_KEY, JSON.stringify(ovNext));
    } else {
      const next = { ...overrides, [id]: { segments: updateChainSegments(base.segments, parsed) } };
      setOverrides(next);
      storageSet(OVERRIDE_KEY, JSON.stringify(next));
    }
    setParseState({ loading: false, error: "", warnings: parsed.warnings });
    setEditor(null);
  };

  const autoFetch = async () => {
    if (!editor || parseState.loading) return;
    if (!iwencaiReady) {
      setParseState({ loading: false, error: "未配置问财 key", warnings: [] });
      return;
    }
    if (editor.mode === "add") {
      const q = editor.name.trim().replace(/产业链\s*$/, "");
      if (!q) {
        setParseState({ loading: false, error: "请先填写产业链名称", warnings: [] });
        return;
      }
      setParseState({ loading: true, error: "", warnings: [] });
      try {
        const r = await api.iwencaiSelect(q, 30);
        const rows = r.rows || [];
        if (!rows.length) throw new Error("问财未返回匹配股票");
        const stockText = rows.slice(0, 30).map((x) => `${x.name}（${x.code}）`).join("、");
        setEditor((cur) => cur && {
          ...cur,
          content: `${q}产业链\n\n${stockText}\n\n核心逻辑: ${q}产业链\n数据来源: 同花顺问财`,
        });
        setParseState({
          loading: false,
          error: "",
          warnings: [`已获取 ${Math.min(rows.length, 30)} 只候选股, 请按上游/中游/下游分段后再保存`],
        });
      } catch (e) {
        setParseState({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          warnings: [],
        });
      }
      return;
    }
    setParseState({ loading: true, error: "", warnings: [] });
    const lines = [`${chain.name}产业链\n`];
    let total = 0;
    let first = "";
    for (const seg of chain.segments) {
      const q = seg.query || seg.name.replace(/[·.].*$/, "").trim();
      if (!q) {
        lines.push(`\n${seg.name}:\n(未配置查询语)\n`);
        continue;
      }
      try {
        const r = await api.iwencaiSelect(q, 12);
        const rows = r.rows || [];
        if (!rows.length) {
          lines.push(`\n${seg.name}:\n(问财未返回)\n`);
          continue;
        }
        lines.push(`\n${seg.name}:\n${rows.slice(0, 10).map((x) => `${x.name}（${x.code}）`).join("、")}\n`);
        total += Math.min(rows.length, 10);
      } catch (e) {
        if (!first) first = e instanceof Error ? e.message : String(e);
        lines.push(`\n${seg.name}:\n(查询失败)\n`);
      }
    }
    if (total === 0) {
      setParseState({ loading: false, error: first || "问财未返回名单", warnings: [] });
      return;
    }
    lines.push(`\n核心逻辑: ${chain.name}产业链\n数据来源: 同花顺问财`);
    setEditor((cur) => cur && { ...cur, content: lines.join("\n") });
    setParseState({ loading: false, error: "", warnings: [`已从问财获取 ${total} 只, 核验后保存`] });
  };

  return (
    <div ref={boxRef} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 px-1 py-1">
        <ChipGroup>
          {allChains.map((c) => (
            <span key={c.id} className="group relative inline-flex">
              <Chip
                active={id === c.id}
                accent={isCustomChain(c.id) ? "violet" : "cyan"}
                onClick={() => setId(c.id)}
              >
                {c.name}
              </Chip>
              {isCustomChain(c.id) && (
                <button
                  type="button"
                  title="删除此自定义链"
                  onClick={() => deleteCustom(c.id)}
                  className="absolute -right-0.5 -top-1 hidden h-3 w-3 items-center justify-center rounded-full bg-rose-500/80 text-[8px] leading-none text-white group-hover:flex"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </ChipGroup>
        <button
          type="button"
          onClick={() => openEditor("add")}
          className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/20"
        >
          +添加
        </button>
        <button
          type="button"
          onClick={() => openEditor("update")}
          className="rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/20"
        >
          更新
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 disabled:opacity-50"
          title={iwencaiReady ? "用问财按环节查询语刷新名单" : "需配置 IWENCAI_API_KEY"}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          问财刷新
        </button>
      </div>
      {err && <p className="px-1.5 text-[10px] text-rose-400">{err}</p>}
      {related.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1.5 pb-1">
          <span className="self-center text-[9px] text-slate-600">相关板块</span>
          {related.map((b) => (
            <span key={b.code || b.name} className="rounded bg-slate-800/60 px-1.5 py-0.5 text-[10px] text-slate-300">
              {b.name}
              <span className={cn("ml-1 font-mono tabular-nums", pctColor(b.pct))}>
                {b.pct > 0 ? "+" : ""}{b.pct.toFixed(2)}%
              </span>
            </span>
          ))}
        </div>
      )}
      {!showSide && chain.tech.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1.5 pb-1">
          <span className="self-center text-[9px] text-slate-600">关键技术</span>
          {chain.tech.map((t) => (
            <span
              key={t}
              className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-px text-[9px] text-emerald-300"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <div className={cn("grid gap-2 p-1", wide && "grid-cols-3")}>
            {chain.segments.map((seg, si) => (
              <div key={seg.name} className="min-w-0 rounded-md border border-border/60 bg-card/80 p-1">
                <p className="px-1 pt-1 text-[11px] font-semibold text-slate-200">
                  {seg.name}
                  {ov?.segments[si]?.stocks?.length ? (
                    <span className="ml-1 text-[9px] font-normal text-emerald-400/80">问财</span>
                  ) : null}
                </p>
                <p className="mb-1 px-1 text-[10px] text-slate-500">{seg.desc}</p>
                <div>
                  {seg.stocks.map((st) => {
                    const q = quotes[st.code];
                    const sp = sparkFromKline(minutes[st.code]);
                    return (
                      <QuoteStockRow
                        key={st.code}
                        code={st.code}
                        name={st.name}
                        price={q?.price}
                        pct={q?.pct}
                        amount={q?.amount}
                        turnover={q?.turnover}
                        tag={st.tag}
                        spark={sp ?? { closes: [] }}
                        flow
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        {showSide && (
          <ChainSide tech={chain.tech} news={chainNews} loading={!!snap.loading.cls && !snap.cls} />
        )}
      </div>
      {editor && (
        <ChainEditorDialog
          editor={editor}
          parseState={parseState}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onAutoFetch={() => void autoFetch()}
          onSubmit={submitEditor}
        />
      )}
    </div>
  );
}
