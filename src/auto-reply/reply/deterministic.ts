import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { tryHandleTelegramGoogleCalendarMessage } from "../../telegram/google-calendar.js";

export async function maybeHandleDeterministicReply(
  ctx: MsgContext,
): Promise<ReplyPayload | undefined> {
  // Only for Telegram DMs for now (avoids surprising behavior in groups).
  if (ctx.Provider !== "telegram") return undefined;
  if (ctx.ChatType === "group") return undefined;

  // IMPORTANT:
  // - do NOT concatenate multiple sources (can reintroduce envelope noise).
  // Prefer Transcript, then CommandBody, then RawBody.
  // If Transcript isn't set (some audio flows only embed "Transcript:" inside Body),
  // fall back to Body — the downstream handler sanitizes <file> blocks + control chars.
  const input =
    (typeof ctx.Transcript === "string" && ctx.Transcript.trim()) ||
    (typeof ctx.CommandBody === "string" && ctx.CommandBody.trim()) ||
    (typeof ctx.RawBody === "string" && ctx.RawBody.trim()) ||
    (typeof ctx.Body === "string" && ctx.Body.trim()) ||
    "";
  if (!input) return undefined;

  try {
    const handled = await tryHandleTelegramGoogleCalendarMessage(input);
    if (!handled.handled || !handled.replyText) return undefined;

    return {
      text: handled.replyText,
      replyToId: typeof ctx.MessageSid === "string" ? ctx.MessageSid : undefined,
    };
  } catch (err) {
    // Fail closed: don't crash the whole reply pipeline; fall back to LLM.
    return {
      text: `Não consegui criar o evento no Google Agenda (erro interno).\n\nDetalhe: ${String(err)}`,
      replyToId: typeof ctx.MessageSid === "string" ? ctx.MessageSid : undefined,
    };
  }
}
