import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../process/exec.js", () => {
  return {
    runExec: vi.fn(),
  };
});

import { runExec } from "../../process/exec.js";
import { maybeHandleDeterministicReply } from "./deterministic.js";

const runExecMock = vi.mocked(runExec);

function calendarsPlain(ownerId = "owner@example.com") {
  return `ID\tNAME\tROLE
${ownerId}\t${ownerId}\towner
`;
}

describe("maybeHandleDeterministicReply", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });

  it("creates Google Calendar event for Telegram DM transcript without asking questions", async () => {
    runExecMock
      .mockResolvedValueOnce({ stdout: calendarsPlain("crismoraes.work@gmail.com"), stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "evt_1",
          summary: "Sair pra buscar casa nova",
          start: { dateTime: "2026-01-31T12:00:00-03:00" },
          end: { dateTime: "2026-01-31T13:00:00-03:00" },
        }),
        stderr: "",
      });

    const reply = await maybeHandleDeterministicReply({
      Provider: "telegram",
      ChatType: "direct",
      MessageSid: "123",
      Transcript:
        'Agende um compromisso ao meio-dia chamado "Sair pra buscar casa nova" (America/Sao_Paulo)',
    } as any);

    expect(reply?.text).toMatch(/Evento criado no seu Google Agenda/i);
    expect(reply?.replyToId).toBe("123");
  });
});
