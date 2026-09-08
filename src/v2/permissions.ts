import type {MessageEnvelope} from "./sdk";

/** Owner identity is explicit and decimal-string based; no unsafe Number coercion. */
export function isOwner(message: MessageEnvelope, ownerId = process.env.TB_OWNER_ID): boolean {
  return typeof ownerId === "string" && /^[0-9]+$/.test(ownerId) && message.senderId === ownerId;
}

export function isOwnerOrGroupSendAs(message: MessageEnvelope, ownerId: string | undefined): boolean {
  if (isOwner(message, ownerId)) return true;
  // Only fresh group send-as messages: edits and broadcast posts do not prove the current operator.
  const raw = message.raw as {className?: string; post?: boolean} | undefined;
  return message.outgoing && !message.forwarded && !message.edited &&
    raw?.className === "Message" && !raw.post && /^-100[1-9][0-9]*$/.test(message.chatId) &&
    /^-100[1-9][0-9]*$/.test(message.senderId ?? "") && /^[1-9][0-9]*$/.test(ownerId ?? "");
}

export function requireOwner(message: MessageEnvelope): void {
  if (!isOwner(message)) throw new Error("OWNER_REQUIRED");
}

export async function isPrivileged(message: MessageEnvelope): Promise<boolean> {
  return isOwner(message);
}
