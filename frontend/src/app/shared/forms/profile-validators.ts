import type {
  AbstractControl,
  FormControl,
  FormGroupDirective,
  NgForm,
  ValidationErrors,
  ValidatorFn,
} from '@angular/forms';
import type { ErrorStateMatcher } from '@angular/material/core';
import { canRegister, completeProfileSchema } from '@nri/shared';
import { toIsoDate, todayIso } from '../../core/i18n/dates';

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

/** Мінімальний вік реєстрації (`canRegister` з @nri/shared). */
export const minAgeValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value: unknown = control.value;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  if (value.getTime() > Date.now()) return { futureDate: true };
  return canRegister(toIsoDate(value), todayIso()) ? null : { ageTooLow: true };
};

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
