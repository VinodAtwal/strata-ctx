/**
 * Branded identifiers.
 *
 * `runId` and `turnId` get confused constantly, and a gist id that leaks into a
 * message id is a silent data-integrity bug that surfaces three commits later.
 * Branding costs nothing at runtime and turns those into compile errors.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Brand<string, 'RunId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type BlockId = Brand<string, 'BlockId'>;
export type GistId = Brand<string, 'GistId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type ProbeId = Brand<string, 'ProbeId'>;
export type ConstraintId = Brand<string, 'ConstraintId'>;

export const runId = (v: string): RunId => v as RunId;
export const turnId = (v: string): TurnId => v as TurnId;
export const taskId = (v: string): TaskId => v as TaskId;
export const blockId = (v: string): BlockId => v as BlockId;
export const gistId = (v: string): GistId => v as GistId;
export const artifactId = (v: string): ArtifactId => v as ArtifactId;
export const probeId = (v: string): ProbeId => v as ProbeId;
export const constraintId = (v: string): ConstraintId => v as ConstraintId;

/** Rejects empty/blank ids at the boundary so they never reach the store. */
export const nonEmpty = <T>(make: (v: string) => T) => (v: string): T => {
  if (v.trim() === '') throw new Error('identifier must not be empty');
  return make(v);
};
