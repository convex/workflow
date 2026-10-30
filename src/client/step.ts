import type { RetryBehavior, WorkpoolOptions } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionReference_future,
  type FunctionType,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { convexToJson, getConvexSize, type Value } from "convex/values";
import { type JournalEntry, type Step } from "../component/schema.js";
import type {
  IdsToStrings,
  RunResult,
  TransactionLimits,
  WorkflowComponent,
} from "./types.js";
import { MAX_JOURNAL_SIZE, formatErrorWithStack } from "../shared.js";
import type { EventId, SchedulerOptions } from "../types.js";
import { pick } from "convex-helpers";

export type WorkerResult =
  { type: "handlerDone"; runResult: RunResult } | { type: "executorBlocked" };

export type StepRequest = {
  name: string;
  target:
    | {
        kind: "function";
        functionType: FunctionType;
        function:
          | FunctionReference<FunctionType, FunctionVisibility>
          | FunctionReference_future<FunctionType, FunctionVisibility>;
        args: Record<string, unknown>;
      }
    | {
        kind: "event";
        args: { eventId?: EventId };
      }
    | {
        kind: "workflow";
        function: FunctionReference<"mutation", "internal">;
        args: Record<string, unknown>;
      }
    | {
        kind: "sleep";
        args: Record<string, never>;
      };
  retry: RetryBehavior | boolean | undefined;
  inline: boolean;
  unstableArgs: boolean;
  transactionLimits: TransactionLimits | undefined;
  schedulerOptions: SchedulerOptions;

  resolve: (result: RunResult) => void;
};

export class StepExecutor {
  private journalEntrySize: number;

  constructor(
    private workflowId: string,
    private generationNumber: number,
    private ctx: GenericMutationCtx<GenericDataModel>,
    private component: WorkflowComponent,
    private journalEntries: Array<JournalEntry>,
    private receiver: BaseChannel<StepRequest>,
    private now: number,
    private workpoolOptions: WorkpoolOptions | undefined,
  ) {
    this.journalEntrySize = journalEntries.reduce(
      (size, entry) => size + getConvexSize(entry),
      0,
    );

    if (this.journalEntrySize > MAX_JOURNAL_SIZE) {
      // This should never happen, but we'll throw an error just in case.
      throw new Error(journalSizeError(this.journalEntrySize, this.workflowId));
    }
  }
  async run(): Promise<WorkerResult> {
    while (true) {
      const message = await this.receiver.get();
      // In the future we can correlate the calls to entries by handle, args,
      // etc. instead of just ordering. As is, the fn order can't change.
      const entry = this.journalEntries.shift();
      if (entry) {
        this.completeMessage(message, entry);
        continue;
      }
      const messages = [message];
      const size = this.receiver.bufferSize;
      for (let i = 0; i < size; i++) {
        const message = await this.receiver.get();
        messages.push(message);
      }
      const entries = await this.startSteps(messages);
      if (entries.every((entry) => entry.step.runResult)) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          this.completeMessage(messages[i], entry);
        }
        continue;
      }
      return {
        type: "executorBlocked",
      };
    }
  }

  getGenerationState() {
    if (this.journalEntries.length <= this.receiver.bufferSize) {
      return { now: this.now, latest: true };
    }
    return {
      // We use the next entry's startedAt, since we're in code just before that
      // step is invoked. We use the bufferSize, since multiple steps may be
      // currently enqueued in one generation, but the code after it has already
      // started executing.
      now: this.journalEntries[this.receiver.bufferSize].step.startedAt,
      latest: false,
    };
  }

  completeMessage(message: StepRequest, entry: JournalEntry) {
    if (entry.step.inProgress) {
      throw new Error(
        `Assertion failed: not blocked but have in-progress journal entry`,
      );
    }
    const stepFields = pick(
      entry.step,
      message.unstableArgs ? ["name", "kind"] : ["name", "kind", "args"],
    );
    const messageFields = message.unstableArgs
      ? { name: message.name, kind: message.target.kind }
      : {
          name: message.name,
          kind: message.target.kind,
          args: message.target.args as Value,
        };
    const stepJson = JSON.stringify(convexToJson(stepFields));
    const messageJson = JSON.stringify(convexToJson(messageFields));
    if (stepJson !== messageJson) {
      throw new Error(
        `Journal entry mismatch:\n\n${stepJson}\n\n!==\n\n${messageJson}`,
      );
    }
    if (entry.step.runResult === undefined) {
      throw new Error(
        `Assertion failed: no outcome for completed function call`,
      );
    }
    message.resolve(entry.step.runResult);
  }

  async startSteps(messages: StepRequest[]): Promise<JournalEntry[]> {
    const steps = await Promise.all(
      messages.map(async (message) => {
        const args = message.target.args ?? {};
        const target = message.target;

        let runResult: RunResult | undefined;
        if (message.inline) {
          if (target.kind !== "function" || target.functionType === "action") {
            throw new Error(
              "Inline execution is only supported for queries and mutations.",
            );
          }
          try {
            const result =
              target.functionType === "query"
                ? // cast until transactionLimits is shipped / peer dep
                  await (this.ctx.runQuery as any)(
                    target.function as FunctionReference<
                      typeof target.functionType
                    >,
                    target.args,
                    { transactionLimits: message.transactionLimits },
                  )
                : // cast until transactionLimits is shipped / peer dep
                  await (this.ctx.runMutation as any)(
                    target.function as FunctionReference<
                      typeof target.functionType
                    >,
                    target.args,
                    { transactionLimits: message.transactionLimits },
                  );
            runResult = { kind: "success", returnValue: result ?? null };
          } catch (error: unknown) {
            runResult = { kind: "failed", error: formatErrorWithStack(error) };
          }
        }

        const commonFields = {
          inProgress: !runResult,
          name: message.name,
          args,
          argsSize: getConvexSize(args as Value),
          runResult,
          startedAt: this.now,
          completedAt: runResult ? this.now : undefined,
        } satisfies Omit<Step, "kind">;
        let step: IdsToStrings<Step>;
        switch (target.kind) {
          case "function":
            step = {
              kind: "function" as const,
              functionType: target.functionType,
              handle: await createFunctionHandle(target.function),
              ...commonFields,
            };
            break;
          case "workflow":
            step = {
              kind: "workflow" as const,
              handle: await createFunctionHandle(target.function),
              ...commonFields,
            };
            break;
          case "event":
            step = {
              kind: "event" as const,
              eventId: target.args.eventId,
              ...commonFields,
              args: target.args,
            };
            break;
          case "sleep":
            step = {
              kind: "sleep" as const,
              ...commonFields,
            };
            break;
          default:
            throw new Error(`Unknown step kind: ${(target as any).kind}`);
        }
        return {
          retry: message.retry,
          schedulerOptions: message.schedulerOptions,
          step,
        };
      }),
    );
    const entries = (await this.ctx.runMutation(
      this.component.journal.startSteps,
      {
        workflowId: this.workflowId,
        generationNumber: this.generationNumber,
        steps,
        workpoolOptions: this.workpoolOptions,
      },
    )) as JournalEntry[];
    for (const entry of entries) {
      this.journalEntrySize += getConvexSize(entry);
      if (this.journalEntrySize > MAX_JOURNAL_SIZE) {
        throw new Error(
          journalSizeError(this.journalEntrySize, this.workflowId) +
            ` The failing step was ${entry.step.name} (${entry._id})`,
        );
      }
    }
    return entries;
  }
}

function journalSizeError(size: number, workflowId: string): string {
  const lines = [
    `Workflow ${workflowId} journal size limit exceeded (${size} bytes > ${MAX_JOURNAL_SIZE} bytes).`,
    "Consider breaking up the workflow into multiple runs, using smaller step \
    arguments or return values, or using fewer steps.",
  ];
  return lines.join("\n");
}
