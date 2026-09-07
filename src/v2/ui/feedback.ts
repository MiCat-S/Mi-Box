import {bold, code, concat, text, type Html} from "./text";

export type FeedbackState = "working" | "success" | "cancelled" | "error";

export interface FeedbackDiagnostic {
  readonly stage: string;
  readonly code: string;
  readonly label?: string;
}

export interface Feedback {
  readonly state: FeedbackState;
  readonly title: string;
  readonly detail?: string;
  readonly diagnostic?: FeedbackDiagnostic;
  readonly nextStep?: string;
}

const marker: Readonly<Record<FeedbackState, string>> = {
  working: "进行中",
  success: "完成",
  cancelled: "已取消",
  error: "失败",
};

export function renderFeedback(feedback: Feedback): Html {
  const lines: Html[] = [bold(`${marker[feedback.state]} · ${feedback.title}`)];
  if (feedback.detail) lines.push(text(`\n${feedback.detail}`));
  if (feedback.diagnostic) {
    lines.push(text(`\n阶段：${feedback.diagnostic.label ? `${feedback.diagnostic.label} ` : ""}`),
      code(`${feedback.diagnostic.stage} / ${feedback.diagnostic.code}`));
  }
  if (feedback.nextStep) lines.push(text(`\n下一步：${feedback.nextStep}`));
  return concat(...lines);
}
