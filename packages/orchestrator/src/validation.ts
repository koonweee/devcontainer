import { ValidationError } from './errors.js';
import type { CreateBoxInput } from './types.js';

const BOX_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const IMAGE_RE = /^[a-z0-9]+([._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]+)?$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

export function validateCreateBoxInput(input: CreateBoxInput): void {
  if (!BOX_NAME_RE.test(input.name)) {
    throw new ValidationError(
      'Invalid box name. Use 3-63 chars: lowercase letters, numbers, and hyphens.'
    );
  }

  if (!IMAGE_RE.test(input.image)) {
    throw new ValidationError('Invalid image format. Example: debian:trixie-slim');
  }

  if (input.command && input.command.some((part) => part.length === 0)) {
    throw new ValidationError('Command elements must be non-empty strings.');
  }

  if (input.env) {
    for (const [key, value] of Object.entries(input.env)) {
      if (!ENV_KEY_RE.test(key)) {
        throw new ValidationError(`Invalid env key: ${key}`);
      }
      if (value.length > 4096) {
        throw new ValidationError(`Env value too large for key: ${key}`);
      }
    }
  }
}
