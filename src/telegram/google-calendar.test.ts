import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../process/exec.js", () => {
  return {
    runExec: vi.fn(),
  };
});

import { runExec } from "../process/exec.js";
import { tryHandleTelegramGoogleCalendarMessage } from "./google-calendar.js";

const runExecMock = vi.mocked(runExec);

function calendarsPlain(ownerId = "owner@example.com") {
  return `ID\tNAME\tROLE
pt-br.brazilian#holiday@group.v.calendar.google.com\tFeriados no Brasil\treader
${ownerId}\t${ownerId}\towner
`;
}

describe("tryHandleTelegramGoogleCalendarMessage", () => {
  beforeEach(() => {
    runExecMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an event for a plain-text DM request", async () => {
    runExecMock
      // calendars
      .mockResolvedValueOnce({ stdout: calendarsPlain("crismoraes.work@gmail.com"), stderr: "" })
      // create (gog --json)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "evt_123",
          summary: "Chá de casa nova",
          start: { dateTime: "2026-01-31T09:00:00-03:00" },
          end: { dateTime: "2026-01-31T10:00:00-03:00" },
        }),
        stderr: "",
      });

    const res = await tryHandleTelegramGoogleCalendarMessage(
      'Crie uma agenda no google para hoje às 09:00 chamado "Chá de casa nova" (America/Sao_Paulo)',
    );

    expect(res.handled).toBe(true);
    expect(res.replyText).toMatch(/Evento criado no seu Google Agenda/i);
    expect(runExecMock).toHaveBeenCalledTimes(2);
    expect(runExecMock.mock.calls[1]?.[0]).toBe("/usr/local/bin/gog");
    expect(runExecMock.mock.calls[1]?.[1]).toContain("create");
  });

  it("extracts Transcript: content and creates an event", async () => {
    runExecMock
      .mockResolvedValueOnce({ stdout: calendarsPlain("crismoraes.work@gmail.com"), stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "evt_456",
          summary: "Ir buscar casa nova",
          start: { dateTime: "2026-01-31T11:00:00-03:00" },
          end: { dateTime: "2026-01-31T12:00:00-03:00" },
        }),
        stderr: "",
      });

    const text = `[Audio] User text: ... Transcript: Crie uma agenda para hoje às 11:00 chamado "Ir buscar casa nova" (America/Sao_Paulo)
[message_id: 999]`;

    const res = await tryHandleTelegramGoogleCalendarMessage(text);
    expect(res.handled).toBe(true);
    expect(res.replyText).toMatch(/Evento criado no seu Google Agenda/i);
    expect(runExecMock).toHaveBeenCalledTimes(2);
    expect(runExecMock.mock.calls[1]?.[1]).toContain("create");
  });

  it("assumes today when date is omitted (voice-friendly)", async () => {
    runExecMock
      .mockResolvedValueOnce({ stdout: calendarsPlain("crismoraes.work@gmail.com"), stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "evt_789",
          summary: "Sair para buscar casa nova",
          start: { dateTime: "2026-01-31T11:00:00-03:00" },
          end: { dateTime: "2026-01-31T12:00:00-03:00" },
        }),
        stderr: "",
      });

    const res = await tryHandleTelegramGoogleCalendarMessage(
      'Transcript: Agende um compromisso às 11 horas chamado "Sair para buscar casa nova" (America/Sao_Paulo)\n[message_id: 1]',
    );

    expect(res.handled).toBe(true);
    expect(res.replyText).toMatch(/Evento criado no seu Google Agenda/i);
  });

  it("parses meio‑dia with Unicode hyphen (voice STT)", async () => {
    runExecMock
      .mockResolvedValueOnce({ stdout: calendarsPlain("crismoraes.work@gmail.com"), stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "evt_unicode",
          summary: "Teste meio‑dia",
          start: { dateTime: "2026-01-31T12:00:00-03:00" },
          end: { dateTime: "2026-01-31T13:00:00-03:00" },
        }),
        stderr: "",
      });

    const res = await tryHandleTelegramGoogleCalendarMessage(
      'Transcript: Agende um compromisso ao meio\u2011dia. chamado "Teste meio\u2011dia" (America/Sao_Paulo)\n[message_id: 2]',
    );

    expect(res.handled).toBe(true);
    expect(res.replyText).toMatch(/Início:\s*2026-01-31T12:00:00-03:00/);
  });

  it("ignores <file> blocks with null bytes (voice attachments) and still parses the request", async () => {
    runExecMock
      .mockResolvedValueOnce({ stdout: calendarsPlain("crismoraes.work@gmail.com"), stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "evt_999",
          summary: "Teste voz",
          start: { dateTime: "2026-01-31T12:00:00-03:00" },
          end: { dateTime: "2026-01-31T13:00:00-03:00" },
        }),
        stderr: "",
      });

    const res = await tryHandleTelegramGoogleCalendarMessage(
      `Transcript: Agende um compromisso ao meio-dia chamado "Teste voz" (America/Sao_Paulo)

<file name="x.ogg" mime="text/plain">abc\u0000def</file>`,
    );

    expect(res.handled).toBe(true);
    expect(res.replyText).toMatch(/Evento criado no seu Google Agenda/i);
    expect(runExecMock).toHaveBeenCalledTimes(2);
  });

  it("ignores open-ended <file> blocks (missing </file>) and still parses the request", async () => {
    runExecMock
      .mockResolvedValueOnce({ stdout: calendarsPlain("crismoraes.work@gmail.com"), stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "evt_open_ended",
          summary: "Teste voz open-ended",
          start: { dateTime: "2026-01-31T12:00:00-03:00" },
          end: { dateTime: "2026-01-31T13:00:00-03:00" },
        }),
        stderr: "",
      });

    const res = await tryHandleTelegramGoogleCalendarMessage(
      'Transcript: Agende um compromisso ao meio-dia.\n<file name="x.ogg" mime="text/plain">abc\u0000def',
    );

    expect(res.handled).toBe(true);
    expect(res.replyText).toMatch(/Evento criado no seu Google Agenda/i);
    expect(runExecMock).toHaveBeenCalledTimes(2);
  });
});
