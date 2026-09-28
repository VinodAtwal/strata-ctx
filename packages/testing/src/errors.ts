/**
 * Error taxonomy.
 *
 * Distinct classes because the failure modes call for different responses. A
 * version mismatch means "regenerate the fixture"; a match miss means "the
 * harness is wrong"; an ambiguity means "a human has to choose". Collapsing
 * them into one `Error` makes every one of them read as the same shrug.
 */

export class FixtureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class FixtureVersionError extends FixtureError {}

/** Schema failure, with the zod issues rendered so a path is always visible. */
export class FixtureValidationError extends FixtureError {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super(`${message}\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.issues = issues;
  }
}

/** No fixture matched. Carries a diff, because "no match" alone is not debuggable. */
export class FixtureMatchError extends FixtureError {}

/** More than one fixture matched. Replay must not pick; a coin flip is not a test. */
export class FixtureAmbiguityError extends FixtureError {}

/** A redaction could not be performed, so nothing was written. */
export class RedactionError extends FixtureError {}

export class FixtureExistsError extends FixtureError {}
