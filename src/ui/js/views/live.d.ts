export interface ToolCallInput {
  name?: string;
  arguments?: string;
}

/** 把一条工具调用渲染成摘要 HTML；仅用于实时输出页。 */
export function toolCallHtml(call: ToolCallInput | null | undefined): string;