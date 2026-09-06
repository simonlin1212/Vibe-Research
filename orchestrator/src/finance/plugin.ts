/**
 * **金融插件**:Core 需要知道的、随垂类而变的全部东西都在这里。
 *
 * 这些常量原先散在 `config.ts`(阶段、脚本、计算函数、报告章节)与 `schemas.ts`
 * (证据枚举、标准列、议题)里 —— 换个垂类它们**每一条都要重写**,所以属于包不属于 Core。
 *
 * 🔴 改这里之前先想清楚:新增 / 改名一个阶段,要**同时**改 `stages`、`stageScripts`、
 * `stageCalcs`、`extraTopics` 四处。漏改哪一处,`registerPlugin` 会在注册时当场报出来
 * (键集必须与 stages 完全一致)—— 这是故意的,别去放宽那个校验。
 */
import type { Plugin } from "../plugin.ts";
import { FINANCE_GATE } from "./gate_rules.ts";
import { FINANCE_ENUM_LABELS, FINANCE_FIELD_LABELS, FINANCE_LEDGER_KINDS } from "./ledger_kinds.ts";
import { FINANCE_PAGE_CONTEXT, FINANCE_PAGE_QUERIES } from "./page_queries.ts";
import { FINANCE_LEXICON } from "./lexicon.ts";
import { financeQuoteDecision } from "./quote_freshness.ts";
import { financeBaselinePeriod } from "./fiscal_year.ts";
import { FINANCE_ROLES, FINANCE_SLOTS } from "./semantic_slots.ts";
import { FINANCE_STAGE_VALIDATORS } from "./stage_validators.ts";
import { CHOKE_FILE_REL, loadChokeTable, scanChokepoints, writeChokeFile } from "./chokepoint.ts";
import { buildGateRewritePrompt, buildStagePrompt } from "./stages.ts";
import { INDUSTRY_FILE_REL, applyIndustryGate, detectIndustryTags, loadIndustryTags, writeIndustryFile } from "./industry.ts";
import { appendThermoLedger, applyThermometerHistory, readThermoLedger, thermoDir, thermoLedgerOverview, thermoLedgerPath } from "./thermo_history.ts";

/** 阶段顺序:摸清公司 → 财务 → 一致预期 → 估值 → 风险 → 成文 */
export const FINANCE_STAGES = ["profile", "financials", "estimates", "valuation", "risk", "report"] as const;
export type FinanceStage = (typeof FINANCE_STAGES)[number];

export const FINANCE_PLUGIN: Plugin = {
  id: "finance",
  stages: FINANCE_STAGES,

  /** 每阶段必需 / 可选的取数脚本(由编排器执行;fetch/<script>.json 必须存在且有账本记录) */
  stageScripts: {
    profile: { required: ["fetch_profile", "fetch_quote", "fetch_trade_calendar"], optional: [] },
    financials: { required: ["fetch_financials"], optional: [] },
    estimates: { required: ["fetch_estimates"], optional: [] },
    valuation: { required: [], optional: ["fetch_pe_history"] },
    risk: { required: [], optional: ["fetch_announcements", "fetch_kline"] },
    report: { required: [], optional: [] },
  },

  /** 关键脚本全部失败 → 运行 failed(无法产出可用研究) */
  criticalScripts: ["fetch_quote", "fetch_financials", "fetch_estimates"],

  /** 每阶段必须出现的 calc 函数(calc 记录的 id 必须列在该阶段 calculation_ids;或 gaps 以 operation 精确说明) */
  stageCalcs: {
    profile: [],
    financials: ["quarterize", "latest_quarter", "ttm_sum", "ttm_yoy", "qoq"],
    estimates: ["forward_cagr", "consensus_dispersion"],
    valuation: ["pe_deducted_annualized", "forward_pe", "pe_ttm_from_parts", "percentile_rank", "peg",
      "pe_digestion_scenarios", "forward_vs_ttm_judgement"],
    risk: [],
    report: [],
  },

  /** 各阶段 extra_findings 允许的 topic(与 stages.ts 的 EXT_GUIDE / SOP §6 一致;schema 与 validator 双重约束) */
  extraTopics: {
    profile: ["行业归属", "股本与市值", "上市状态", "板块归属", "其他交叉核对"],
    financials: ["三表交叉", "资产负债要点", "现金流要点", "其他交叉核对"],
    estimates: ["逐篇预测", "评级分布", "其他线索"],
    valuation: ["估值历史", "分红", "其他交叉核对"],
    risk: ["资金行为", "解禁", "股东结构", "公告线索", "互动易", "新闻线索", "市场声音", "产业温度计",
      "卡口事件", "管制与准入", "数据日历", "海外头条", "招聘信号", "宏观概率", "其他线索"],
    report: ["汇总"],
  },

  /** report.md 必须出现的章节标题(SOP §5 骨架) */
  reportSections: ["结论摘要", "事实", "推断", "估值", "风险与反证", "裁决点", "数据缺口"],
  fidelityExcludedSections: ["数据缺口"],

  evidence: {
    /** 证券市场代码 */
    markets: ["SH", "SZ", "BJ", "CN", "US", "HK", "TW"],
    /** 复权口径:前复权 / 后复权 / 不复权 / 不适用 */
    adjustments: ["none", "qfq", "hfq", "not_applicable"],
    /** 这些区域码**可以**带全市场读数(大宗、DRAM 现货这类) */
    marketWideCodes: ["CN", "US", "HK"],
    /** CN **只**用于全市场读数:A 股个股用 SH / SZ / BJ,美股港股则是个股与全市场共用同一代码 */
    marketWideOnlyCodes: ["CN"],
  },

  /** 批量摘要的标准列 */
  standardColumns: ["pe_deducted_x4", "forward_pe", "pe_ttm_percentile", "peg", "forward_cagr", "ttm_yoy", "qoq"],

  /** 口径角色:营收 / 归母 / 扣非 */
  roles: FINANCE_ROLES,
  /** 语义槽位表(每阶段每个计算函数"输入该怎么选") */
  semanticSlots: FINANCE_SLOTS,
  /** "报价是否陈旧"的判定:交易日历 / 盘前 / 停牌 */
  quoteDecision: financeQuoteDecision as Plugin["quoteDecision"],
  /** 阶段显示名(也是允许拼进文件路径的白名单) */
  stageLabels: {
    profile: "公司画像", financials: "财务", estimates: "一致预期",
    valuation: "估值", risk: "风险与线索", report: "成稿",
  },

  /** 议题 → 报告章节:没列进来的议题不进专属章节,只作全文要求 */
  topicSections: {
    资金行为: "资金与市场行为", 解禁: "资金与市场行为", 股东结构: "资金与市场行为",
    公告线索: "公告 · 互动易 · 新闻线索", 互动易: "公告 · 互动易 · 新闻线索", 新闻线索: "公告 · 互动易 · 新闻线索",
    市场声音: "市场声音", 产业温度计: "产业温度计", 卡口事件: "卡口事件",
    管制与准入: "管制与准入", 海外头条: "海外头条", 招聘信号: "招聘信号", 宏观概率: "宏观概率",
  },

  /**
   * 有议题、但不给它单开一章的两个 —— 单开会逼出一个无处安放的空章节。
   * 仍然要求证据在报告全文里被引用(校验器按这张表出错误措辞)。
   */
  /** 扩展章节插在「风险与反证」之后(下一章骨架是「裁决点」) */
  /**
   * 多空辩论的资料包与角色。
   * 🔴 资料包**只放确定性数字类端点** —— 市场声音那种第三方文本进来,
   *    就等于让双方引用别人的观点当证据,而对方无法核实。
   */
  debate: {
    dossierEndpoints: ["tx_quote", "fetch_profile", "fetch_financials", "indicators_cn"],
    stages: [
      {
        id: "bull",
        label: "多方陈述",
        sees: [],
        prompt: "你是多方。**只用资料包里的数字**,列出支持这家公司的三到五条论据,每条注明依据哪条证据 id。不许引入资料包以外的数字;拿不准就说拿不准。不要给任何操作建议。自己算出来的数(同比 / 差额 / 单季拆解)必须**把算式写出来**并注明两个数各自的资料期(如「2026H1 444.64 亿 [ev-x] ÷ 2025H1 453.90 亿 [ev-y] − 1 = −2.04%」);算式与结论对不上时以算式为准。跨期比较必须用**同一口径的相邻期**,别拿隔年的数当去年。",
      },
      {
        id: "bear",
        label: "空方陈述",
        sees: [],
        prompt: "你是空方。**只用资料包里的数字**,列出看空这家公司的三到五条论据,每条注明依据哪条证据 id。不许引入资料包以外的数字;拿不准就说拿不准。不要给任何操作建议。自己算出来的数(同比 / 差额 / 单季拆解)必须**把算式写出来**并注明两个数各自的资料期(如「2026H1 444.64 亿 [ev-x] ÷ 2025H1 453.90 亿 [ev-y] − 1 = −2.04%」);算式与结论对不上时以算式为准。跨期比较必须用**同一口径的相邻期**,别拿隔年的数当去年。",
      },
      {
        id: "bull_rebut",
        label: "多方反驳",
        sees: ["bear"],
        prompt: "你是多方,现在反驳空方。逐条指出空方哪里用错了数、哪里把假设当成了事实。**只能用资料包里的数字**。反驳不了的就承认反驳不了 —— 承认比硬圆更有价值。自己算出来的数(同比 / 差额 / 单季拆解)必须**把算式写出来**并注明两个数各自的资料期(如「2026H1 444.64 亿 [ev-x] ÷ 2025H1 453.90 亿 [ev-y] − 1 = −2.04%」);算式与结论对不上时以算式为准。跨期比较必须用**同一口径的相邻期**,别拿隔年的数当去年。",
      },
      {
        id: "bear_rebut",
        label: "空方反驳",
        sees: ["bull"],
        prompt: "你是空方,现在反驳多方。逐条指出多方哪里用错了数、哪里把假设当成了事实。**只能用资料包里的数字**。反驳不了的就承认反驳不了。自己算出来的数(同比 / 差额 / 单季拆解)必须**把算式写出来**并注明两个数各自的资料期(如「2026H1 444.64 亿 [ev-x] ÷ 2025H1 453.90 亿 [ev-y] − 1 = −2.04%」);算式与结论对不上时以算式为准。跨期比较必须用**同一口径的相邻期**,别拿隔年的数当去年。",
      },
      {
        id: "referee",
        label: "裁判",
        sees: ["bull", "bear", "bull_rebut", "bear_rebut"],
        prompt: "你是裁判,不站队。做三件事:① 列出双方**都认的事实**;② 列出**争议点**,并说明分歧根源是数据不足还是口径不同;③ 把每个争议点写成一条**可裁决的判据**——需要看到什么数据、什么时候能看到。**不要给结论说谁赢,更不要给任何操作建议。**自己算出来的数(同比 / 差额 / 单季拆解)必须**把算式写出来**并注明两个数各自的资料期(如「2026H1 444.64 亿 [ev-x] ÷ 2025H1 453.90 亿 [ev-y] − 1 = −2.04%」);算式与结论对不上时以算式为准。跨期比较必须用**同一口径的相邻期**,别拿隔年的数当去年。",
      },
    ],
    // 一轮 = 各自陈述 + 主持；两轮 = 再加交叉反驳。
    // ⚠️ 与界面上那个下拉框的选项一一对应；两边对不上就又是"控件说一套、系统做一套"。
    depths: {
      "1": ["bull", "bear", "referee"],
      "2": ["bull", "bear", "bull_rebut", "bear_rebut", "referee"],
    },
  },

  /** 产出红线:词表 / 正则 / 免责声明全在 gate_rules.ts */
  gate: FINANCE_GATE,

  extraSectionsAfter: "风险与反证",

  topicMerge: {
    // 裁决点每行都带"下一个数据点是哪天",日历内容天然属于那一章
    数据日历: "裁决点",
    // 兜底议题:并到哪一章由内容决定,不指定
    其他线索: "",
  },

  /** 变化提醒默认盯的证据字段 */
  alertObservationFields: ["price", "total_market_cap", "pe_ttm", "pb", "pe_ttm_latest"],
  alertFields: ["price", "total_market_cap", "pe_ttm", "pb", "eps_consensus_mean", "eps_analyst_count",
    "revenue_cum", "net_profit_parent_cum", "net_profit_deducted_cum", "margin_financing_balance_latest",
    "shareholder_count", "lockup_upcoming_count", "dragon_tiger_count", "block_trade_count",
    "research_report_count_1y", "pe_ttm_latest", "announcement_title"],

  /** 标准列的表头显示名 */
  standardColumnLabels: {
    pe_deducted_x4: "扣非×4 PE", forward_pe: "前瞻 PE", pe_ttm_percentile: "PE 分位", peg: "PEG",
    forward_cagr: "前瞻 CAGR", ttm_yoy: "TTM 同比", qoq: "QoQ",
  },

  /** 标准列住在估值阶段的产物里 */
  standardColumnsStage: "valuation",
  /**
   * 阶段专属字段(Core 只做合并,见 Plugin.stageSchemas)。
   * 这些原本写死在 Core 的 `schemas.ts` 里 —— 报价判定 / 不可替代性标签 / 反证 / 裁决点 /
   * 数据源冲突全是金融概念,换个垂类既拿不到自己的约束、又被强塞这些(全审 r4-P1)。
   */
  // 卡口事件分类(确定性,不拉新数据):在这两个阶段取数后扫公司自己的公告 / 新闻信封。
  // 原本这段连同"哪些阶段"一起写死在 Core 的主循环里(全审 r4-P1)。
  /** 沪深北与空串都按 CN 取数;未知取值抛错,绝不猜(原本写死在 Core 的 registry.ts) */
  buildStagePrompt: (stage, cfg, opts) => buildStagePrompt(stage as never, cfg as never, opts as never),
  buildRewritePrompt: (cfg, hits) => buildGateRewritePrompt(cfg as never, hits as never),
  /** 产业标签门控:按公司命中的标签决定这一阶段实际跑哪些端点(原本 Core 直接 import 这段) */
  transformFetch: (cfg, stage, ledger, log) => applyThermometerHistory(cfg as never, stage as never, ledger as never, log),
  afterRun: (ctx) => {
    const t = appendThermoLedger(ctx.cfg as never, ctx.ledger as never, ctx.log);
    ctx.record("thermo_archived", { endpoints: t.endpoints, appended: t.appended, skipped: t.skipped.length, corrupt_moved: t.corrupt_moved.length });
  },
  // 产业温度计的历史序列。⚠️ 序列只在**完整研究运行**时追加,手动点看板不写 —— 稀疏是正常的
  seriesFor: (dataRoot, endpoint) => {
    const r = readThermoLedger(thermoLedgerPath({ dataRoot }, endpoint));
    return { observations: r.obs, exists: r.exists, unreadable: r.unreadable, dropped: r.dropped };
  },
  doctorChecks: ({ dataRoot }) => {
    const rows = thermoLedgerOverview({ dataRoot });
    const bad = rows.filter((r) => r.unreadable || r.dropped > 0);
    return [{
      id: "thermo_history", title: "温度计历史序列", status: bad.length ? "warn" : "ok",
      detail: rows.length
        ? rows.map((r) => `${r.endpoint}:${r.observations} 条 ${r.first ?? "-"}→${r.last ?? "-"}${r.unreadable ? " 🔴不可读" : ""}${r.dropped ? ` ⚠️无效 ${r.dropped}` : ""}`).join(";")
        : `${thermoDir({ dataRoot })} 尚无序列(首次完整运行归档后生成;或 node orchestrator/src/finance/thermo_history.ts backfill)`,
      fix: bad.length ? "不可读的文件会在下次归档时移到 .corrupt 旁路重建;无效条目已被忽略——若是手工编辑过序列文件,按 schema 修回或删掉该条" : undefined,
    }];
  },
  beforeFetch: (ctx) => {
    const planned = [...ctx.planned];
    // 只有存在带产业标签的端点时才走门控 —— 否则每次取数都白读一次标签表
    if (!planned.some((id) => ((ctx.endpoints[id] as { industry_tags?: string[] } | undefined)?.industry_tags ?? []).length)) return planned;
    const table = loadIndustryTags(ctx.repoRoot);   // 缺失 / 损坏直接抛 → 运行失败出声,不当"零标签"
    const det = detectIndustryTags(ctx.runDir, table);
    const gate = applyIndustryGate(planned, ctx.endpoints as never, det.tags);
    const f = writeIndustryFile(ctx.runDir, table, det, gate);
    ctx.protect(INDUSTRY_FILE_REL);
    ctx.record("industry_tags", { tags: f.tags, matched: f.matched, skipped: f.skipped, signals: f.signals });
    ctx.log("industry.gate", { tags: f.tags, matched: f.matched, skipped: f.skipped, signals: f.signals });
    return gate.included;
  },
  marketRegion: (market: string): string => {
    const m = (market || "").toUpperCase();
    if (m === "US") return "US";
    if (m === "HK") return "HK";
    if (m === "" || m === "SH" || m === "SZ" || m === "BJ" || m === "CN") return "CN";
    throw new Error(`未知市场 ${market}(只接受 SH/SZ/BJ/CN/US/HK 或空)`);
  },
  afterFetch: (ctx) => {
    if (ctx.stage !== "risk" && ctx.stage !== "report") return;
    const cp = scanChokepoints(ctx.runDir, loadChokeTable(ctx.repoRoot));
    writeChokeFile(ctx.runDir, cp);
    ctx.protect(CHOKE_FILE_REL);
    ctx.record("chokepoints", { scanned: cp.scanned, hits: cp.hits.length, by_category: cp.by_category });
    ctx.log("chokepoint.scan", { scanned: cp.scanned, hits: cp.hits.length, by_category: cp.by_category, scripts: cp.scripts });
  },
  stageValidators: FINANCE_STAGE_VALIDATORS,
  stageSchemas: {
    profile: {
      properties: {
        quote_decision: { type: "string", enum: ["normal", "pre_open", "stale", "unknown_unverified"] },
        quote_decision_reason: { type: "string", minLength: 1 },
        moat_tag: { type: "string", enum: ["tech_moat", "capacity_moat", "both", "待补"] },
      },
      required: ["quote_decision", "quote_decision_reason", "moat_tag"],
    },
    risk: {
      properties: {
        counter_evidence: {
          type: "array", minItems: 1,
          items: { type: "object", additionalProperties: false, required: ["claim", "counter"],
            properties: { claim: { type: "string", minLength: 1 }, counter: { type: "string", minLength: 1 },
              evidence_ids: { type: "array", items: { type: "string", pattern: "^(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})$" } } } },
        },
        decision_points: {
          type: "array", minItems: 3,
          items: { type: "object", additionalProperties: false, required: ["what_would_change", "next_data_point"],
            properties: { what_would_change: { type: "string", minLength: 1 }, next_data_point: { type: "string", minLength: 1 } } },
        },
        source_conflicts: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["field", "kind", "values"],
            properties: { field: { type: "string", minLength: 1 }, period: { type: "string" },
              kind: { type: "string", enum: ["source", "cross_check"] }, note: { type: "string" },
              values: { type: "array", minItems: 2,
                items: { type: "object", additionalProperties: false, required: ["source", "value", "ref_id"],
                  properties: { source: { type: "string", minLength: 1 }, value: {}, unit: { type: "string" },
                    ref_id: { type: "string", pattern: "^(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})$" }, note: { type: "string" } } } } } },
        },
      },
      required: ["counter_evidence", "decision_points", "source_conflicts"],
    },
  },
  reportStage: "report",
  topicsSourceStage: "risk",

  /** doctor 的 calc 自检:前瞻 PE = 100 / 5 = 20 */
  selfTestCalc: { fn: "forward_pe", args: { price: 100, eps_forecast: 5 }, expect: 20 },

  /** 基准期 = 当前财年 T */
  baselinePeriod: financeBaselinePeriod as Plugin["baselinePeriod"],

  /**
   * 研究档案模板。章节顺序与编号写在标题里;`tail: true` 的几节在召回截断时优先保留
   * (裁决点 / 缺口 / 对旧档案的裁决 —— 这三样被截掉,档案就没用了)。
   */
  archive: {
    validDays: 90,
    maxFacts: 40,                 // 关键数据表 ≤ 40 行,保证裁决点 / 缺口不被截掉
    sections: [
      { title: "1. 业务与上下游位置", blocks: [
        { kind: "stageSummary", stage: "profile", extras: [
          { label: "不可替代性标签", field: "moat_tag", fallback: "待补" },
          { label: "报价判定", field: "quote_decision", fallback: "?" },
        ] },
      ] },
      { title: "2. 关键数据", blocks: [
        // ⚠️ 不含 report:它引用的 id 多且多为重复,放进来会把 40 条上限挤满(沿用重构前的行为)
        { kind: "evidenceTable", stages: ["profile", "financials", "estimates", "valuation", "risk"] },
        { kind: "stageSummaries", stages: ["financials", "estimates", "valuation"], caption: "阶段摘要(数值以证据 / 计算 id 为准):" },
        { kind: "standardColumnsTable" },
      ] },
      { title: "3. 历史结论(本次阶段判读;与实时数据冲突时以实时为准)", blocks: [
        { kind: "conclusions", stage: "risk" },
        { kind: "conflictCount", stage: "risk" },
      ] },
      { title: "4. 裁决点(什么数据出来会改变判断)", tail: true, blocks: [{ kind: "decisionPoints", stage: "risk" }] },
      { title: "5. 待验证 / 数据缺口", tail: true, blocks: [{ kind: "gaps" }] },
      { title: "6. 对上次档案的裁决(knowledge_conflicts)", tail: true, omitIfEmpty: true, blocks: [{ kind: "knowledgeConflicts" }] },
    ],
  },

  /** 界面查询:每一屏要哪些数据(前端只认查询名,不认端点 id) */
  pageQueries: FINANCE_PAGE_QUERIES,
  /** 页面业务上下文:交易时段 → 这一页该看哪一天 */
  pageContext: FINANCE_PAGE_CONTEXT,
  /** 用户自有台账的记录种类(Core 只管存储与校验,种类在 ledger_kinds.ts) */
  ledger: { kinds: FINANCE_LEDGER_KINDS, fieldLabels: FINANCE_FIELD_LABELS, enumLabels: FINANCE_ENUM_LABELS },
  /**
   * 本垂类自带的工具。Core 只知道"起进程、喂 stdin、读 stdout 的 JSON",
   * 这些工具各自是干什么的**只有这里知道**。
   * ⚠️ 回测要先取数(三个市场、几年日线)再逐 bar 撮合,比单次取数慢得多 ⇒ 单独给 5 分钟。
   */
  tools: {
    backtest: { label: "回测", module: "backtest.cli", requiresAgent: true, timeoutMs: 300_000 },
    // 🔴 让**界面也能调到确定性计算库**，而不是自己再抄一份公式。
    //    此前 desktop 的 api.ts 手写了 PE / CAGR / PEG / 消化年数 ——
    //    于是 `calc/` 里改对了口径，桌面端不会跟着变（"两套事实与计算链路"）。
    //    最典型的后果：calc 的正式口径是**四情景**消化年数（30/25/22/18 倍锚），
    //    界面却写死 30 倍出一个数，把最乐观那一档当成了既定事实。
    //    ⚠️ 纯计算、不联网、不落盘，所以超时给得短 —— 它要是跑几秒，说明调错了东西。
    calc: { label: "确定性计算", module: "calc.tool", requiresAgent: false, timeoutMs: 20_000 },
  },

  /** 普通对话的资料召回:金融文档常见的类型词不算文件名主体;「研报」是明确指向资料库的说法(#39) */
  reportRecall: {
    // 「研报」本身就是明确指向资料库的说法;年报 / 财报 / 季报要带明确指称(这份 / 里 / 中)才算,「年报季到了」不算(Codex r16 P2)
    intent: /研报|(?:这份|那份|这个|那个|上面的|我的|上传的)\s*(?:年报|财报|季报|中报|半年报|一季报|三季报)|(?:年报|财报|季报|中报|半年报|一季报|三季报)[里中内]/,
    titleStopwords: ["年报", "中报", "季报", "半年报", "一季报", "三季报", "财报", "研报", "个股", "行业", "板块", "投资", "投资者", "电话会", "路演", "业绩说明会", "earnings", "call"],
    // 「总结所有研报」「比较这六份财报」:这些名词也指"一份资料",参与全库 / 数量判定(Codex r26 P1)
    documentNouns: ["研报", "年报", "财报", "季报", "中报", "半年报", "公告", "纪要", "点评"],
  },
  lexicon: FINANCE_LEXICON,
};
