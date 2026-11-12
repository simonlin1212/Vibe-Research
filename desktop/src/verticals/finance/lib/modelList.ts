/**
 * 「接入 AI」页「获取可用模型」的请求状态。从页面组件里拆出来,是为了能直接测
 * "请求还在路上时用户清除了配置 / 换了地址,旧请求随后才回来" 这类时序 —— 组件测试只渲染首屏,测不到。
 *
 * 规则只有一条:**只有当前这一轮的结果能写进状态**。reset() 会取消在途请求并作废它,
 * 旧请求哪怕之后成功返回,也不会把列表或提示重新显示出来。
 */

export interface ModelOption { id: string; name: string }

export interface ModelListState {
  loading: boolean;
  models: ModelOption[] | null;
  msg: string;
  err: string;
  detail: string;
}

export const EMPTY_MODEL_LIST: ModelListState = Object.freeze({ loading: false, models: null, msg: "", err: "", detail: "" }) as ModelListState;

export interface ModelListReply { models: ModelOption[]; hidden?: number; url: string; duration_ms: number }

/**
 * 前端再守一层本次 key(后端已过滤,这里防旧后端 / 代理):id 含 key 的整行丢弃,不改写成另一个 id;名称里的 key 抹掉。
 * ⚠️ 只抹**这一次填的那个 key**,不猜通用形态 —— 通用形态由后端统一处理。
 */
export function guardModelOptions(models: readonly ModelOption[], apiKey: string): { models: ModelOption[]; hidden: number } {
  const key = apiKey.trim();
  if (!key) return { models: [...models], hidden: 0 };
  const forms = [...new Set([key, JSON.stringify(key).slice(1, -1)])];
  const has = (s: string) => forms.some((f) => s.includes(f));
  const kept: ModelOption[] = [];
  let hidden = 0;
  for (const m of models) {
    if (has(m.id)) { hidden += 1; continue; }
    kept.push({ id: m.id, name: has(m.name) ? forms.reduce((s, f) => s.split(f).join("***"), m.name) : m.name });
  }
  return { models: kept, hidden };
}

export interface ModelListFailure { text: string; detail: string }

export class ModelListSession {
  #state: ModelListState = EMPTY_MODEL_LIST;
  #round = 0;
  #abort: AbortController | null = null;
  readonly #onChange: (state: ModelListState) => void;

  constructor(onChange: (state: ModelListState) => void) { this.#onChange = onChange; }

  get state(): ModelListState { return this.#state; }

  #set(next: Partial<ModelListState>): void {
    this.#state = { ...this.#state, ...next };
    this.#onChange(this.#state);
  }

  /** 校验没过之类的本地提示:不发请求,但同样作废在途请求 */
  fail(text: string, detail = ""): void {
    this.#cancel();
    this.#set({ ...EMPTY_MODEL_LIST, err: text, detail });
  }

  /** 清除配置 / 换来源 / 改地址或 key:取消在途请求,清空列表与全部提示 */
  reset(): void {
    this.#cancel();
    this.#state = EMPTY_MODEL_LIST;
    this.#onChange(this.#state);
  }

  #cancel(): void {
    this.#round += 1;
    this.#abort?.abort();
    this.#abort = null;
  }

  /**
   * 发起一轮获取。`request` 收到本轮的 AbortSignal;`describe` 把异常翻成页面文案 + 排查明细。
   * 返回时若本轮已被 reset / 新一轮取代,结果直接丢弃。
   */
  async start(
    apiKey: string,
    request: (signal: AbortSignal) => Promise<ModelListReply>,
    describe: (error: unknown) => ModelListFailure,
  ): Promise<void> {
    this.#cancel();
    const round = this.#round;
    const ac = new AbortController();
    this.#abort = ac;
    const current = () => round === this.#round && !ac.signal.aborted;
    this.#set({ ...EMPTY_MODEL_LIST, loading: true });
    try {
      const reply = await request(ac.signal);
      if (!current()) return;
      const guarded = guardModelOptions(reply.models, apiKey);
      const hidden = guarded.hidden + (reply.hidden ?? 0);
      const note = hidden ? `另有 ${hidden} 个模型的标识里出现了你的 API key，已隐藏。` : "";
      if (guarded.models.length === 0) {
        this.#set({ ...EMPTY_MODEL_LIST, err: "端点返回了空的模型列表，请手动填写模型名", detail: `GET ${reply.url} 成功，但没有可用的模型。${note}` });
        return;
      }
      this.#set({
        ...EMPTY_MODEL_LIST, models: guarded.models,
        msg: `取到 ${guarded.models.length} 个模型（${(reply.duration_ms / 1000).toFixed(1)} 秒）。点一个就填进 Model，也可以继续手动输入。${note}`,
      });
    } catch (e) {
      if (!current()) return;
      const f = describe(e);
      this.#set({ ...EMPTY_MODEL_LIST, err: f.text, detail: f.detail });
    } finally {
      if (round === this.#round) this.#abort = null;
    }
  }
}
