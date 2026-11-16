import { ValidateIf } from 'class-validator';

/**
 * Optional for a partial update, but never null.
 *
 * IsOptional skips validation for null as well as undefined, so on a PATCH a
 * `"name": null` sails through and reaches a NOT NULL column as a 500. This
 * skips only an absent field: null is validated, and refused, like any other
 * value of the wrong type.
 */
export function IsOptionalNotNull(): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined);
}
