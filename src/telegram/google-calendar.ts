import { runExec } from "../process/exec.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

type CalendarCreateIntent = {
  summary: string;
  /** RFC3339 */
  from: string;
  /** RFC3339 */
  to: string;
  description?: string;
  timeZone?: string;
};

const log = createSubsystemLogger("telegram/google-calendar");

function includesAny(haystack: string, needles: string[]) {
  return needles.some((n) => haystack.includes(n));
}

function stripFileBlocks(text: string): string {
  // Remove OpenClaw <file ...>...</file> blocks (can include binary/gibberish).
  // In some providers, the payload is truncated and the closing </file> is missing,
  // so we also drop anything from "<file" to the end of the message.
  const withoutClosed = text.replace(/<file\b[\s\S]*?<\/file>/gi, "");
  const withoutOpenEnded = withoutClosed.replace(/<file\b[\s\S]*$/gi, "");
  return withoutOpenEnded.trim();
}

function stripTelegramEnvelope(text: string): string {
  // Remove common envelope lines injected by formatters (they can contain timestamps like "13:03 UTC").
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // Keep transcript lines even if they are prefixed with "[Audio] User text: ..."
      if (/(?:^|\s)(Transcript|Transcri(?:ç|c)ão)\s*:/i.test(trimmed)) return true;
      if (/^\[Telegram\b/i.test(trimmed)) return false;
      if (/^\[Audio\b/i.test(trimmed)) return false;
      if (/^\[message_id:/i.test(trimmed)) return false;
      if (/^User text:/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function stripControlChars(text: string): string {
  // Remove NUL and other control chars that can break CLI arg passing.
  // Keep \t \n \r for readability.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
}

function formatTwo(n: number) {
  return String(n).padStart(2, "0");
}

function extractTranscriptLikeText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  // Common envelope patterns:
  // - "Transcript: ...\n[message_id: ...]"
  // - "Transcrição: ..."
  const m =
    /(?:^|\n)\s*(?:Transcript|Transcri(?:ç|c)ão)\s*:\s*([\s\S]+?)\s*(?:\n\[message_id:|\n\[message_id|\n\[\[|$)/i.exec(
      text,
    );
  if (!m?.[1]) return null;
  return m[1].trim() || null;
}

function addDaysInTimeZone(params: {
  year: number;
  month: number;
  day: number;
  deltaDays: number;
}) {
  // We only need “hoje/amanhã” for now; easiest safe approach is to hop via UTC date math
  // using a Date built from YYYY-MM-DD in UTC, then re-read in target TZ via Intl elsewhere.
  const base = new Date(Date.UTC(params.year, params.month - 1, params.day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + params.deltaDays);
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

function getDatePartsInTimeZone(
  now: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    // Fallback to UTC date parts if Intl fails for any reason
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }
  return { year, month, day };
}

function getTimeZoneOffsetRfc3339(timeZone: string, ref: Date): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(ref);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value;
    if (!tzName) return undefined;
    // Example: "GMT-3", "GMT+1"
    const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(tzName);
    if (!m) return undefined;
    const sign = m[1] === "-" ? "-" : "+";
    const hours = Number(m[2]);
    const minutes = m[3] ? Number(m[3]) : 0;
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
    return `${sign}${formatTwo(hours)}:${formatTwo(minutes)}`;
  } catch {
    return undefined;
  }
}

function buildRfc3339Local(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}) {
  const refUtc = new Date(
    Date.UTC(params.year, params.month - 1, params.day, params.hour, params.minute, 0),
  );
  const offset = getTimeZoneOffsetRfc3339(params.timeZone, refUtc) ?? "-03:00";
  return `${params.year}-${formatTwo(params.month)}-${formatTwo(params.day)}T${formatTwo(params.hour)}:${formatTwo(params.minute)}:00${offset}`;
}

function parseCalendarCreateIntent(rawText: string): CalendarCreateIntent | null {
  const text = rawText.trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  // Gate:
  // - Explicit: mentions Google + (agenda/calendar) + create verb
  // - Implicit (DM-friendly): "crie/criar uma agenda" (very common phrasing for Google Calendar)
  const hasCreateVerb = includesAny(lower, [
    "crie",
    "criar",
    "cria",
    "agende",
    "agendar",
    "marque",
    "marcar",
  ]);
  const mentionsAgendaWord = includesAny(lower, ["agenda", "calendário", "calendario", "calendar"]);
  const mentionsCalendarNoun = includesAny(lower, [
    "evento",
    "compromisso",
    "lembrete",
    "reunião",
    "reuniao",
    "marcar",
    "agendar",
    "agendado",
  ]);
  const explicitGoogle = lower.includes("google") && mentionsAgendaWord && hasCreateVerb;
  const implicitAgenda = hasCreateVerb && (lower.includes("agenda") || mentionsCalendarNoun);
  if (!explicitGoogle && !implicitAgenda) return null;

  // Time zone
  const tzMatch = /\(([A-Za-z_]+\/[A-Za-z_]+)\)/.exec(text);
  const timeZone = tzMatch?.[1] ?? "America/Sao_Paulo";

  // Date: explicit dd/mm/yyyy or hoje/amanhã
  const explicitDate = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  if (explicitDate) {
    day = Number(explicitDate[1]);
    month = Number(explicitDate[2]);
    year = Number(explicitDate[3]);
  } else {
    const base = getDatePartsInTimeZone(new Date(), timeZone);
    if (lower.includes("amanhã") || lower.includes("amanha")) {
      const next = addDaysInTimeZone({ ...base, deltaDays: 1 });
      ({ year, month, day } = next);
    } else if (lower.includes("hoje")) {
      ({ year, month, day } = base);
    } else {
      // Voice-friendly default: if the user didn't specify a date, assume "today" in their timezone.
      ({ year, month, day } = base);
    }
  }
  if (!year || !month || !day) return null;

  // Time
  const resolveTime = (): { hour: number; minute: number } | null => {
    // Common voice tokens
    // Accept multiple hyphen variants coming from STT / rich-text (e.g. U+2011 non-breaking hyphen).
    const HYPHEN_CHARS = "\\-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212";
    // Allow punctuation after "dia/noite" (STT often ends sentences with "." / ",").
    const END_BOUNDARY = "(?:\\s|$|[\\.,;:!\\?\\)\\]\\}”\\\"'])";
    const meioDia = new RegExp(
      `(?:^|\\s)meio(?:\\s*[${HYPHEN_CHARS}]\\s*|\\s+)dia${END_BOUNDARY}`,
      "i",
    );
    const meiaNoite = new RegExp(
      `(?:^|\\s)meia(?:\\s*[${HYPHEN_CHARS}]\\s*|\\s+)noite${END_BOUNDARY}`,
      "i",
    );
    if (meioDia.test(lower)) return { hour: 12, minute: 0 };
    if (meiaNoite.test(lower)) return { hour: 0, minute: 0 };

    // 11:00 / 11h / 11 h 30 / às 11
    // Require an explicit cue word to avoid accidentally matching envelope timestamps (e.g. "13:03 UTC").
    const m1 = /(?:às|as|ao|para|por volta de)\s*(\d{1,2})\s*(?:[:h]\s*(\d{2}))?/i.exec(text);
    if (m1?.[1]) {
      const hour = Number(m1[1]);
      const minute = m1[2] ? Number(m1[2]) : 0;
      if (Number.isFinite(hour) && Number.isFinite(minute)) return { hour, minute };
    }

    // "11 horas" / "11 hora" / "11 horas e meia"
    const m2 = /(?:às|as|ao|para|por volta de)\s*(\d{1,2})\s*(?:horas?|h)\b/i.exec(lower);
    if (m2?.[1]) {
      const hour = Number(m2[1]);
      if (!Number.isFinite(hour)) return null;
      const minute = /\be\s+meia\b/i.test(lower) ? 30 : 0;
      return { hour, minute };
    }
    return null;
  };

  const resolvedTime = resolveTime();
  if (!resolvedTime) return null;
  const { hour, minute } = resolvedTime;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const from = buildRfc3339Local({ year, month, day, hour, minute, timeZone });
  const to = buildRfc3339Local({ year, month, day, hour: hour + 1, minute, timeZone });

  // Summary: prefer “chamado '...'”
  const quoted =
    /chamado\s*[“"']([^”"']+)[”"']/i.exec(text) ?? /named\s*[“"']([^”"']+)[”"']/i.exec(text);
  let summary = quoted?.[1]?.trim();
  if (!summary) {
    // Also accept: "chamado X" (without quotes)
    const called = /(chamado|chamada)\s+(.+?)(?:\s*\(|\s*$)/i.exec(text);
    const candidate = called?.[2]?.trim();
    if (candidate) {
      summary = candidate;
    }
  }
  if (!summary) {
    // Prefer patterns like: "agenda de X"
    const agendaOf = /agenda\s+de\s+(.+?)(?:\s+para|\s+hoje|\s+amanh[ãa]|$)/i.exec(text);
    if (agendaOf?.[1]?.trim()) {
      summary = `Agenda de ${agendaOf[1].trim()}`;
    } else {
      // fallback: take text after "agenda"
      const agendaIdx = lower.indexOf("agenda");
      if (agendaIdx >= 0) {
        summary = text.slice(agendaIdx).trim();
        // strip leading "agenda" / "agenda de"
        summary = summary.replace(/^agenda(\s+de)?\s*/i, "Agenda ").trim();
        // strip trailing date cues
        summary = summary
          .replace(/\s+(para\s+hoje|para\s+amanh[ãa]|hoje|amanh[ãa]).*$/i, "")
          .trim();
      }
    }
  }
  if (!summary) summary = "Agenda";

  const description = `Criado via Clawdbot (Telegram).\n\nPedido: ${text}`;

  return { summary, from, to, description, timeZone };
}

async function resolveOwnerCalendarId(): Promise<string | null> {
  const { stdout } = await runExec(
    "/usr/local/bin/gog",
    ["calendar", "calendars", "--plain", "--no-input"],
    { timeoutMs: 15_000, maxBuffer: 2_000_000 },
  );
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // TSV header: ID\tNAME\tROLE
  const rows = lines.slice(1).map((line) => line.split("\t"));
  const owner = rows.find((cols) => (cols[2] ?? "").trim() === "owner");
  const pick = owner ?? rows[0];
  const id = (pick?.[0] ?? "").trim();
  return id || null;
}

async function createGoogleCalendarEvent(intent: CalendarCreateIntent) {
  const calendarId = await resolveOwnerCalendarId();
  if (!calendarId) {
    return {
      ok: false as const,
      error:
        "Não consegui encontrar um calendário “owner” via `gog calendar calendars`. Verifique se o gog está autenticado nesse gateway.",
    };
  }
  const args = [
    "calendar",
    "create",
    calendarId,
    "--summary",
    intent.summary,
    "--from",
    intent.from,
    "--to",
    intent.to,
    "--description",
    intent.description ?? "",
    "--json",
    "--no-input",
  ];
  const { stdout } = await runExec("/usr/local/bin/gog", args, {
    timeoutMs: 20_000,
    maxBuffer: 5_000_000,
  });
  try {
    const parsed = JSON.parse(stdout) as {
      id?: string;
      htmlLink?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      summary?: string;
    };
    return {
      ok: true as const,
      calendarId,
      eventId: parsed.id ?? null,
      htmlLink: parsed.htmlLink ?? null,
      summary: parsed.summary ?? intent.summary,
      start: parsed.start?.dateTime ?? parsed.start?.date ?? intent.from,
      end: parsed.end?.dateTime ?? parsed.end?.date ?? intent.to,
    };
  } catch {
    // If gog ever prints non-json even with --json, still return stdout for debugging.
    return { ok: false as const, error: `Falha ao parsear JSON do gog.\n\nstdout:\n${stdout}` };
  }
}

export async function tryHandleTelegramGoogleCalendarMessage(rawText: string): Promise<{
  handled: boolean;
  replyText?: string;
}> {
  const cleaned = stripTelegramEnvelope(stripControlChars(stripFileBlocks(rawText)));
  const transcript = extractTranscriptLikeText(cleaned);
  const intent = parseCalendarCreateIntent(transcript ?? cleaned);
  if (!intent) return { handled: false };

  log.info("calendar intent matched", {
    timeZone: intent.timeZone ?? null,
    from: intent.from,
    to: intent.to,
    summaryPreview: intent.summary.slice(0, 140),
  });

  const result = await createGoogleCalendarEvent(intent);
  if (!result.ok) {
    log.warn("calendar create failed", { error: result.error });
    return {
      handled: true,
      replyText: `Não consegui criar o evento no Google Agenda.\n\n${result.error}`,
    };
  }
  log.info("calendar event created", {
    calendarId: result.calendarId,
    eventId: result.eventId,
    start: result.start,
    end: result.end,
  });
  const link = result.htmlLink ? `\nLink: ${result.htmlLink}` : "";
  return {
    handled: true,
    replyText: `Evento criado no seu Google Agenda.\n\n- Título: ${result.summary}\n- Início: ${result.start}\n- Fim: ${result.end}${link}`,
  };
}
