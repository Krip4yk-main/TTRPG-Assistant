import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidationErrors,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { MODERATION_TEXT_MAX, type MySanctionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { ModerationApi } from '../../../core/moderation/moderation.api';
import { MySanctionsStore } from '../../../core/moderation/my-sanctions.store';

/** Порожнє після обрізання пробілів — як `trim().min(1)` у `sanctionAppealInputSchema`. */
function trimmedRequired(control: AbstractControl<string>): ValidationErrors | null {
  return control.value.trim() ? null : { required: true };
}

/**
 * «Обмеження акаунта» (`/my-sanctions`): мої чинні санкції — вид, що саме заборонено,
 * причина від адміністрації, кінець або «назавжди» і стан апеляції. Оскаржити кожну можна
 * один раз (форма відкривається під санкцією); 409 `APPEAL_EXISTS` чи `SANCTION_NOT_ACTIVE`
 * — список перечитується.
 */
@Component({
  selector: 'nri-my-sanctions',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './my-sanctions.html',
  styleUrl: './my-sanctions.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MySanctions {
  private readonly store = inject(MySanctionsStore);
  private readonly api = inject(ModerationApi);
  private readonly auth = inject(AuthStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly items = this.store.items;
  protected readonly loadError = this.store.error;
  protected readonly max = MODERATION_TEXT_MAX;

  /** Санкція, під якою відкрита форма апеляції. */
  protected readonly openId = signal<number | null>(null);
  protected readonly busy = signal(false);
  /** Помилка надсилання апеляції (ключ i18n). */
  protected readonly error = signal<string | null>(null);
  /** Повідомлення після дії (ключ i18n). */
  protected readonly notice = signal<string | null>(null);

  protected readonly message = new FormControl('', {
    nonNullable: true,
    validators: [trimmedRequired, Validators.maxLength(MODERATION_TEXT_MAX)],
  });
  protected readonly form = new FormGroup({ message: this.message });
  private readonly value = toSignal(this.message.valueChanges, { initialValue: '' });
  protected readonly length = computed(() => this.value().length);

  constructor() {
    void this.store.refresh();
  }

  protected until(s: MySanctionDto): string | null {
    return s.endsAt ? formatDateTime(s.endsAt, viewerTimeZone(this.auth.me())) : null;
  }

  protected retry(): void {
    void this.store.refresh();
  }

  protected open(s: MySanctionDto): void {
    this.openId.set(s.id);
    this.error.set(null);
    this.notice.set(null);
    this.message.reset('');
    this.focus(`textarea[data-sanction="${s.id}"]`);
  }

  protected close(s: MySanctionDto): void {
    this.openId.set(null);
    this.error.set(null);
    this.focus(`button.appeal[data-sanction="${s.id}"]`);
  }

  protected async submit(s: MySanctionDto): Promise<void> {
    if (this.busy()) return;
    if (this.message.invalid) {
      this.message.markAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const saved = await firstValueFrom(
        this.api.appeal(s.id, { message: this.message.value.trim() }),
      );
      this.store.replace(saved);
      this.openId.set(null);
      this.notice.set('moderation.my.appealSent');
      this.focus('.notice-area');
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'APPEAL_EXISTS' || code === 'SANCTION_NOT_ACTIVE') {
        this.openId.set(null);
        this.notice.set(`errors.${code}`);
        await this.store.refresh();
        this.focus('.notice-area');
      } else if (code !== 'UNAUTHENTICATED') {
        this.error.set(`errors.${code}`);
      }
    } finally {
      this.busy.set(false);
    }
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
