/**
 * @loxep/jobs — durable background work on Graphile Worker (ADR-0003,
 * ADR-0013, ADR-0018).
 *
 * Task conventions (`defineTask`, job keys, retry policy) live in
 * `conventions.ts`; the embedded runner and enqueue helpers in `runtime.ts`;
 * queue health visibility in `stats.ts`.
 */
export {
  DEFAULT_MAX_ATTEMPTS,
  createTaskRegistry,
  defineTask,
  jobKeyFor,
} from "./conventions.ts";
export type {
  AnyLoxepTask,
  DefineTaskOptions,
  EnqueueOptions,
  JobsLogger,
  LoxepTask,
  TaskContext,
  TaskHandler,
  TaskRegistry,
} from "./conventions.ts";
export {
  addJob,
  defaultCronItems,
  defaultTaskRegistry,
  startWorkerRuntime,
} from "./runtime.ts";
export type {
  AddJob,
  StartWorkerRuntimeOptions,
  WorkerRuntime,
} from "./runtime.ts";
export { getJobStats } from "./stats.ts";
export type { JobStats, Queryable } from "./stats.ts";
export {
  HEARTBEAT_SETTINGS_KEY,
  heartbeatCronItem,
  heartbeatTask,
} from "./tasks/heartbeat.ts";
