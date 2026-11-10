/**
 * What the Judge needs from a model (architecture §5.3): one structured
 * completion, nothing else. `apps/daemon` implements it over a Provider that
 * declares `capabilities.structuredOutput`, in a one-shot session, so the model,
 * environment and budget go through the same path as a peer's (§4). The Judge
 * never holds a provider: a group does not import another sideways (§1.1).
 */

export interface JudgeRequest {
  /** Instructions: fixed per question kind, never containing peer-written text. */
  readonly system: string
  /** The question, with peer-written text only inside a labelled data block. */
  readonly prompt: string
  /** The JSON Schema the answer must satisfy; a provider with structured output enforces it. */
  readonly schema: Readonly<Record<string, unknown>>
  readonly model: string
  /** Aborted when the call exceeds its time budget; the transport must stop work. */
  readonly signal: AbortSignal
}

export interface JudgeResponse {
  /** The model's raw answer text; the Judge parses and validates it, the transport does not. */
  readonly text: string
  /** The model that actually answered, as the provider reports it (§4 `model()`), recorded on the event. */
  readonly model: string
}

export interface JudgeTransport {
  complete(request: JudgeRequest): Promise<JudgeResponse>
}
