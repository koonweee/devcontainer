/** Indicates invalid user input before orchestration starts. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Indicates the requested job, box, or resource was not found. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Indicates an operation crossed a privileged ownership boundary. */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/** Indicates config cannot be changed while boxes exist. */
export class ConfigLockedError extends Error {
  readonly boxCount: number;

  constructor(message: string, boxCount: number) {
    super(message);
    this.name = 'ConfigLockedError';
    this.boxCount = boxCount;
  }
}

/** Indicates required setup has not been completed. */
export class SetupRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupRequiredError';
  }
}
