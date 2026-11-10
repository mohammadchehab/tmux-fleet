/**
 * `@fleet/evals-adapter` (§17): promptfoo's JSON report in, `eval.*` events out.
 *
 * `readReport` decodes the file, `appendReport` writes the three event types
 * through an `EventSink`. Nothing here imports promptfoo — the report is decoded
 * as JSON — and nothing outside `evals` imports this package (§1.1).
 */

export {
  ReportError,
  decodeReport,
  readReport,
  targetOf,
  type Report,
  type ReportResult,
} from './report.ts'
export {
  appendReport,
  eventsFromReport,
  type AppendedRun,
  type ReportContext,
  type ReportEvents,
} from './events.ts'
