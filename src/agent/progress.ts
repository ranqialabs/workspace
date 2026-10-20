// The tool calls and the words of one run, in order, as the run reports them.
// It only keeps state; `ui/progress` decides how it reads on the message.

export type StepState = "running" | "done" | "failed"

export interface Step {
  id: string
  tool: string
  input: unknown
  state: StepState
  /** Why a failed call failed, as the tool said it. */
  error?: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export class Progress {
  private readonly log: Step[] = []
  private thought = ""
  private said = ""

  started(id: string, tool: string, input: unknown): void {
    this.log.push({ id, tool, input, state: "running" })
  }

  finished(id: string, error?: unknown): void {
    const step = this.log.find((candidate) => candidate.id === id)
    if (step === undefined) return
    step.state = error === undefined ? "done" : "failed"
    if (error !== undefined) step.error = messageOf(error)
  }

  /** What the model is thinking now; a new thought replaces the last one's. */
  reasoned(text: string): void {
    this.thought = text
  }

  /** The answer so far, whole rather than appended. */
  wrote(text: string): void {
    this.said = text
  }

  get steps(): readonly Step[] {
    return this.log
  }

  get thinking(): string {
    return this.thought
  }

  get answer(): string {
    return this.said
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return JSON.stringify(error) ?? "unknown error"
}
