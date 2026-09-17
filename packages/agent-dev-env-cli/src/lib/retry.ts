// retry.ts — bounded retry with exponential backoff for the CLI's
// network-bound transfers (chunk fetches, image pushes, tart pulls): a
// transient failure (expired signed URL, registry 429/5xx, dropped
// connection) is retried instead of failing the whole transfer.
// Interrupted commands are never retried — Ctrl+C must stop the
// transfer, not restart it.

import { runChecked, sleep, type RunOptions, type RunResult, CommandFailedError } from './exec.js';
import { logger } from './logger.js';

/** Default total attempts (first try + two retries). */
const RETRY_ATTEMPTS = 3;

/** Default base backoff in ms; doubles after every failed attempt. */
const RETRY_DELAY_MS = 1_000;

/** Default cap for the exponential backoff. */
const RETRY_MAX_DELAY_MS = 30_000;

/** The retry knobs shared by withRetries and runCheckedWithRetries. */
export interface RetryOptions {
  /** Total attempts, first try included (default RETRY_ATTEMPTS). */
  attempts?: number;
  /** Base backoff in ms, doubled after every failure (default
   *  RETRY_DELAY_MS). */
  delayMs?: number;
  /** Backoff cap in ms (default RETRY_MAX_DELAY_MS). */
  maxDelayMs?: number;
  /** What is being retried; used in the warning lines. */
  label?: string;
  /** Sleep override (tests pass zero-delay timers to keep the suite
   *  fast). */
  sleep?: (ms: number) => Promise<void>;
}

/** Runs an operation with bounded exponential-backoff retries.
 *
 * @param fn - The operation; called once per attempt.
 * @param options - Attempt/delay/label overrides.
 * @returns The first successful result.
 * @throws The last error when every attempt fails; a CommandFailedError
 *   the user interrupted (SIGINT/SIGTERM) is rethrown at once.
 */
export async function withRetries<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? RETRY_ATTEMPTS);
  const baseDelay = Math.max(0, options.delayMs ?? RETRY_DELAY_MS);
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? RETRY_MAX_DELAY_MS);
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || isInterrupt(err)) {
        throw err;
      }
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      logger.warn(
        `${options.label ?? 'operation'} failed (attempt ${attempt}/${attempts}): ` +
          `${errorDetail(err)} — retrying in ${formatDelay(delay)}`,
      );
      await wait(delay);
    }
  }
}

/** runChecked() with bounded retries: a failed `tart pull` / `tart push`
 *  / `oras push` is retried with backoff (content-addressed blobs make
 *  the retry resume instead of restarting the transfer).
 *
 * @param cmd - The command to run.
 * @param args - Command-line arguments.
 * @param options - cwd/env/input/timeout overrides.
 * @param retry - Attempt/delay/label overrides.
 * @returns The result of the first successful attempt.
 * @throws CommandFailedError when every attempt fails.
 */
export async function runCheckedWithRetries(
  cmd: string,
  args: string[] = [],
  options: RunOptions = {},
  retry: RetryOptions = {},
): Promise<RunResult> {
  return withRetries(() => runChecked(cmd, args, options), retry);
}

/** The last line of an error's message — command errors carry their
 *  stderr detail on extra lines, which would flood a one-line log/error
 *  context.
 *
 * @param err - The thrown value.
 * @returns The last non-empty message line, or `unknown error`.
 */
export function errorDetail(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).trim();
  const lines = text.split('\n');
  return lines[lines.length - 1]?.trim() || 'unknown error';
}

/** Whether a failed command was interrupted by the user (never retried). */
function isInterrupt(err: unknown): boolean {
  return err instanceof CommandFailedError && err.interrupted;
}

/** A compact backoff for log lines. */
function formatDelay(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}
