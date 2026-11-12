import type { JournalEntry } from "./component/schema.js";
import type { EventId, WorkflowId, WorkflowStep } from "./types.js";

export const MAX_JOURNAL_SIZE = 8 << 20;

export function formatErrorWithStack(error: unknown): string {
  if (error instanceof Error) {
    return error.toString() + (error.stack ? "\n" + error.stack : "");
  }
  return String(error);
}

// Convert a journal entry to the public step shape used by listSteps,
// getStatus, and step.journal.consumeNext.
export function publicStep(entry: JournalEntry): WorkflowStep {
  const commonFields = {
    workflowId: entry.workflowId as unknown as WorkflowId,
    name: entry.step.name,
    stepId: entry._id,
    stepNumber: entry.stepNumber,

    args: entry.step.args,
    runResult: entry.step.runResult,

    startedAt: entry.step.startedAt,
    completedAt: entry.step.completedAt,
    version: entry.step.version,
  };
  switch (entry.step.kind) {
    case "event":
      return {
        ...commonFields,
        kind: "event",
        eventId: entry.step.eventId as unknown as EventId,
      };
    case "workflow":
      return {
        ...commonFields,
        kind: "workflow",
        nestedWorkflowId: entry.step.workflowId as unknown as WorkflowId,
      };
    case undefined: // steps recorded before `kind` existed are functions
    case "function":
      return {
        ...commonFields,
        kind: "function",
        workId: entry.step.workId,
      };
    case "sleep":
      return {
        ...commonFields,
        kind: "sleep",
        workId: entry.step.workId!,
      };
    default:
      throw new Error(`Unknown step kind: ${(entry.step as any).kind}`);
  }
}
