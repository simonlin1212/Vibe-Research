/**
 * 把 Core 的 AI 入口接到这个垂类上 —— **只提供"行业知道、Core 不知道"的那部分**：
 * 怎么连后端、免责声明怎么说、回答下面挂什么按钮、没配模型时往哪儿引导。
 *
 * 🔴 Core 那边一个行业词都不许有（前端边界棘轮会红），所以文案在这儿而不是那儿。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Settings, Sparkles, Trash2 } from "lucide-react";

import { AiConsole } from "../../../../core/ai/AiConsole";
import { AiDock } from "../../../../core/ai/AiDock";
import { AiComposer, AiMessages } from "../../../../core/ai/AiMessages";
import { useAiChat } from "../../../../core/ai/useAiChat";
import { backend } from "@/lib/backend";
import { useAiRuntime } from "@/hooks/useAiRuntime";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { HOME_TASKS } from "@/lib/homeTasks";

/** 发一轮对话 —— 两个入口共用同一条通道 */
async function sendTurn({ message, session, signal }: { message: string; session: string; signal: AbortSignal }) {
  const r = await backend.chat(message, session, signal);
  // 触发产出红线被删掉的行要**说出来**：不说的话，用户看到的是一段被悄悄剪过的回答
  return r.redacted
    ? `${r.reply}\n\n⚠️ 有 ${r.redacted} 行触发产出红线被移除（不给操作建议）。`
    : r.reply;
}

const setupLink = () => (
  <Link
    to="/settings"
    className="flex items-center justify-center gap-2 rounded-lg bg-primary/15 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/25"
  >
    <Settings className="h-4 w-4" /> 为 Agent 选择模型
  </Link>
);

const replyActions = (reply: string, question: string) => (
  <div className="mt-1.5">
    <SaveNoteButton kind="问 Agent" title={`问 Agent · ${question.slice(0, 24) || "对话"}`} content={reply} />
  </div>
);

const HOME_AGENT_SUGGESTIONS = [
  "解释一下六阶段研究流程",
  "解释一下这套 Agent",
];

/** 首页里的主对话区：打开产品就能聊，不需要先找侧栏或浮动按钮。 */
export function FinanceHomeAgent() {
  const runtime = useAiRuntime();
  const configured = runtime.status === "ok";
  const agentEnabled = runtime.config?.executionMode !== "direct";
  const chat = useAiChat("home-agent", sendTurn);
  const [draft, setDraft] = useState("");

  return (
    <section
      id="home-agent"
      data-home-agent
      className="glass flex min-h-[420px] flex-col overflow-hidden sm:h-[460px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="font-bold">{agentEnabled ? "Agent" : "AI 直连"}</h2>
            <p className="truncate text-[11px] text-muted-foreground">{agentEnabled ? "Vibe Research Agent · 本地运行" : "单轮模型调用 · 不使用 Agent"}</p>
          </div>
        </div>
        {chat.msgs.length > 0 && (
          <button
            onClick={chat.clear}
            title="新对话"
            aria-label="新对话"
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" /> 清空
          </button>
        )}
      </div>

      <nav aria-label="研究任务入口" className="shrink-0 border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="grid gap-2 sm:grid-cols-3">
          {HOME_TASKS.map((task) => (
            <Link key={task.to} to={task.to} className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:border-primary/60 focus-visible:outline focus-visible:outline-primary">
              <span className="block font-medium">{task.label} →</span>
              <span className="block text-[11px] text-muted-foreground">{task.detail}</span>
            </Link>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">任务请从上方进入；下方仅为交流，不会自动取数或收集全网研报。</p>
      </nav>

      {!configured ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div>
            <p className="font-semibold">先接入一个 AI 模型</p>
            <p className="mt-1 text-xs text-muted-foreground">配置一次，以后打开首页就能直接交流。</p>
          </div>
          {setupLink()}
        </div>
      ) : (
        <>
          <AiMessages
            msgs={chat.msgs}
            loading={chat.loading}
            err={chat.err}
            suggestions={HOME_AGENT_SUGGESTIONS}
            suggestionStyle="tasks"
            onPick={setDraft}
            renderReplyActions={replyActions}
            className="px-5 py-4"
          />
          <AiComposer
            placeholder="交流已有资料或研究方法…（Shift+Enter 换行）"
            disabled={chat.loading}
            onSend={(text) => void chat.submit(text)}
            value={draft}
            onValueChange={setDraft}
            highlighted
          />
        </>
      )}
    </section>
  );
}

/** 底部控制台：一条长期对话，跟着你翻页一起走 */
export function FinanceAiConsole({ open, onClose }: { open: boolean; onClose: () => void }) {
  const runtime = useAiRuntime();
  const agentEnabled = runtime.config?.executionMode !== "direct";
  return (
    <AiConsole
      open={open}
      onClose={onClose}
      configured={runtime.status === "ok"}
      copy={{
        title: agentEnabled ? "Vibe Research Agent" : "模型直连",
        runtime: agentEnabled ? "Agent · 本地运行" : "单轮模型调用 · 无 Agent 记忆",
        placeholder: "问点什么…（Shift+Enter 换行）",
        notice:
          agentEnabled
            ? "这是一条由 Vibe Research Agent 管理的长期对话，翻页也不会断。Agent 可读取本机研究产物与台账，但不能修改——不构成投资建议。"
            : "当前直接调用所选模型，不运行 Agent、不调用工具，也不保留 Agent 任务记忆——不构成投资建议。",
        suggestions: ["帮我理一下最近在关注什么", "我该补哪些功课", "解释一下这个产品能干什么"],
      }}
      send={sendTurn}
      renderReplyActions={replyActions}
      renderSetup={setupLink}
    />
  );
}

export function FinanceAiDock() {
  const runtime = useAiRuntime();
  const agentEnabled = runtime.config?.executionMode !== "direct";
  return (
    <AiDock
      configured={runtime.status === "ok"}
      copy={{
        trigger: agentEnabled ? "问 Agent" : "问模型",
        panel: agentEnabled ? "Vibe Research Agent" : "模型直连",
        runtime: agentEnabled ? "Agent · 本地运行" : "单轮模型调用 · 无 Agent 记忆",
        placeholder: "就这一页的内容问点什么…",
        notice:
          agentEnabled
            ? "本地 Agent 基于这一页已显示的数据交流，不自动取数、不调用工具——本产品不背书、不构成投资建议。"
            : "当前页面内容会随本轮问题发送给所选模型；不运行 Agent、不调用工具——本产品不背书、不构成投资建议。",
      }}
      send={sendTurn}
      renderReplyActions={replyActions}
      renderSetup={setupLink}
    />
  );
}
