/**
 * ParallelRunner — counter / slot allocator for `/并行` agents.
 *
 * The actual run is delegated to MessageBridge.runParallelAgent which reuses
 * the standard reply pipeline (executeAndReply). This class only tracks how
 * many fork agents are alive per parent session so we can cap concurrency.
 *
 * Why so thin? Earlier this file spawned its own `claude -p` child and
 * captured stdout, which produced a degraded UX: no typing indicator, no
 * streaming card, no reply quote, plain text only. We now route fork agents
 * through the same pipeline as normal messages — they look identical to the
 * user (no `[/并行 #N]` prefix, no startup banner). This file is left as the
 * allocator because the bookkeeping itself is still useful.
 */
export class ParallelRunner {
  // parentSessionKey → set of in-flight forkN slot numbers
  private slots = new Map<string, Set<number>>();
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
  }

  activeCount(parentSessionKey: string): number {
    return this.slots.get(parentSessionKey)?.size || 0;
  }

  canSpawn(parentSessionKey: string): boolean {
    return this.activeCount(parentSessionKey) < this.maxConcurrent;
  }

  /** Reserve the next slot number; returns 1..maxConcurrent. */
  allocate(parentSessionKey: string): number {
    let set = this.slots.get(parentSessionKey);
    if (!set) {
      set = new Set();
      this.slots.set(parentSessionKey, set);
    }
    for (let n = 1; n <= this.maxConcurrent; n++) {
      if (!set.has(n)) {
        set.add(n);
        return n;
      }
    }
    // Caller is expected to canSpawn() first; throw is a programmer error.
    throw new Error(`Parallel slots exhausted for ${parentSessionKey}`);
  }

  release(parentSessionKey: string, forkN: number): void {
    const set = this.slots.get(parentSessionKey);
    if (!set) return;
    set.delete(forkN);
    if (set.size === 0) this.slots.delete(parentSessionKey);
  }

  getMax(): number {
    return this.maxConcurrent;
  }
}
