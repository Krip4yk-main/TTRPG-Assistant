import type {
  AbstractControl,
  FormControl,
  FormGroupDirective,
  NgForm,
  ValidationErrors,
  ValidatorFn,
} from '@angular/forms';
import type { ErrorStateMatcher } from '@angular/material/core';
import { canRegister, completeProfileSchema, localDate } from '@nri/shared';
import { toIsoDate } from '../../core/i18n/dates';

/** Формат ніку — та сама Zod-схема, що й на бекенді. */
export const nicknameValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  if (!value) return null; // required перевіряє окремо
  return completeProfileSchema.shape.nickname.safeParse(value).success
    ? null
    : { nicknameFormat: true };
};

/**
 * Мінімальний вік реєстрації (`canRegister` з @nri/shared). «Сьогодні» — календарна дата
 * у поясі користувача (та сама `localDate`, що й на бекенді), а не пояс браузера.
 */
export function minAgeValidatorFor(
  timezone: () => string | null | undefined,
  now: () => Date = () => new Date(),
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
    const today = localDate(now(), timezone());
    const birth = toIsoDate(value);
    if (birth > today) return { futureDate: true };
    return canRegister(birth, today) ? null : { ageTooLow: true };
  };
}

export const timezoneValidator: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  const value: unknown = control.value;
  if (typeof value !== 'string' || !value) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return null;
  } catch {
    return { timezone: true };
  }
};

/**
 * Показує помилку, щойно в полі є значення (наприклад, вибрана дата з календаря),
 * а не лише після blur — щоб попередження про вік було видно одразу.
 */
export const eagerErrorState: ErrorStateMatcher = {
  isErrorState(control: FormControl | null, form: FormGroupDirective | NgForm | null): boolean {
    if (!control?.invalid) return false;
    const hasValue = control.value !== null && control.value !== '';
    return hasValue || control.touched || control.dirty || !!form?.submitted;
  },
};
