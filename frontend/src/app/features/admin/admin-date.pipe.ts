import { Pipe, type PipeTransform, inject } from '@angular/core';
import { AuthStore } from '../../core/auth/auth.store';
import { formatDateTime, viewerTimeZone } from '../../core/i18n/dates';

/** Момент часу (ISO) у поясі переглядача: `2 бер. 2027 р., 19:00`; `null` — порожньо. */
@Pipe({ name: 'adminDate' })
export class AdminDatePipe implements PipeTransform {
  private readonly auth = inject(AuthStore);

  transform(iso: string | null | undefined): string {
    return iso ? formatDateTime(iso, viewerTimeZone(this.auth.me())) : '';
  }
}
