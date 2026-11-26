/** Use the committed admission mutation's timestamp, never response arrival. */
export async function admit<T extends { startedAt: number }>(
  start: () => Promise<T>,
) {
  const result = await start();
  return { ...result, admittedAt: result.startedAt };
}

export function executionDuration(admittedAt: number, completedAt: number) {
  const elapsed = completedAt - admittedAt;
  if (elapsed <= 0)
    throw new Error("Trial duration is below timestamp resolution");
  return elapsed;
}
