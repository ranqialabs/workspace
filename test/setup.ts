// Bun cannot load the Workers runtime, so the one class bob extends from it is
// stood in for here; tests hand each object a state built from memoryDatabase.
import { mock } from "bun:test"

class DurableObject<E> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: E,
  ) {}
}

await mock.module("cloudflare:workers", () => ({ DurableObject }))
