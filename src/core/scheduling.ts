/** Let input and paint run between bounded batches of document work. */
export async function yieldToMain(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } })
    .scheduler
  if (scheduler?.yield) await scheduler.yield()
  else await new Promise<void>((resolve) => setTimeout(resolve, 0))
  signal?.throwIfAborted()
}
