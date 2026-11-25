import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
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
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { APPEAL_MESSAGE_MAX, type SanctionAppealStatus } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AppealsApi } from '../../../core/appeals/appeals.api';

/** `form` — пишемо повідомлення; `sent` — уже надіслано; `expired` — токен недійсний. */
export type BannedNoticeState = 'form' | 'sent' | 'expired';

/** Порожнє після обрізання пробілів — як `trim().min(1)` у `appealInputSchema`. */
function trimmedRequired(control: AbstractControl<string>): ValidationErrors | null {
  return control.value.trim() ? null : { required: true };
}

/**
 * Екран заблокованого акаунта з формою єдиного повідомлення адміністрації (апеляції).
 * Токен одноразовий, із помилки входу `ACCOUNT_BANNED`. Після відправки (чи 409
 * `APPEAL_EXISTS`) — стан «вже надіслано»; токен недійсний/прострочений (401) чи акаунт
 * уже розблоковано (403) — пропозиція увійти знову. Збій мережі/сервера, 429 чи CSRF —
 * повтор.
 * На зміну стану фокус переходить на заголовок нового стану.
 */
@Component({
  selector: 'nri-banned-notice',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './banned-notice.html',
  styleUrl: './banned-notice.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BannedNotice implements OnInit {
  private readonly api = inject(AppealsApi);
  private readonly injector = inject(Injector);

  readonly appealToken = input.required<string>();
  /** Повідомлення в цьому періоді бану вже надіслано (з `details` помилки входу). */
  readonly appealSent = input(false);
  /**
   * Стан уже поданої апеляції (з `details` помилки входу чи редиректу): на розгляді,
   * задоволено чи відхилено. `null` — невідомо (щойно надіслано тут — «на розгляді»).
   */
  readonly appealStatus = input<SanctionAppealStatus | null>(null);
  /** «Увійти знову» — повернутися до способів входу. */
  readonly back = output<void>();

  protected readonly max = APPEAL_MESSAGE_MAX;
  protected readonly state = signal<BannedNoticeState>('form');
  protected readonly busy = signal(false);
  /**
   * Ключ i18n тимчасової помилки (мережа, 5xx, 429, CSRF) — текст лишається, можна
   * спробувати ще раз.
   */
  protected readonly failed = signal<string | null>(null);

  protected readonly message = new FormControl('', {
    nonNullable: true,
    validators: [trimmedRequired, Validators.maxLength(APPEAL_MESSAGE_MAX)],
  });
  protected readonly form = new FormGroup({ message: this.message });
  private readonly value = toSignal(this.message.valueChanges, { initialValue: '' });
  protected readonly length = computed(() => this.value().length);

  private readonly title = viewChild<ElementRef<HTMLElement>>('title');
  private readonly stateTitle = viewChild<ElementRef<HTMLElement>>('stateTitle');

  /** Щойно надіслане тут — на розгляді, незалежно від вхідного стану. */
  private readonly sentStatus = signal<SanctionAppealStatus | null>(null);
  /** Стан апеляції в стані «вже надіслано» (невідомий — «на розгляді»). */
  protected readonly status = computed<SanctionAppealStatus>(
    () => this.sentStatus() ?? this.appealStatus() ?? 'pending',
  );

  ngOnInit(): void {
    if (this.appealSent() || this.appealStatus() !== null) this.state.set('sent');
    afterNextRender(() => this.title()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    if (this.message.invalid) {
      this.message.markAsTouched();
      return;
    }
    this.busy.set(true);
    this.failed.set(null);
    try {
      await firstValueFrom(
        this.api.create({ appealToken: this.appealToken(), message: this.message.value.trim() }),
      );
      this.sentStatus.set('pending');
      this.setState('sent');
    } catch (err) {
      const { status, code } = toApiError(err);
      if (code === 'APPEAL_EXISTS') this.setState('sent');
      else if (code === 'RATE_LIMITED' || code === 'CSRF') this.failed.set(`errors.${code}`);
      else if (status === 0 || status >= 500) this.failed.set('banned.form.sendError');
      else this.setState('expired');
    } finally {
      this.busy.set(false);
    }
  }

  private setState(state: BannedNoticeState): void {
    this.state.set(state);
    afterNextRender(() => this.stateTitle()?.nativeElement.focus(), { injector: this.injector });
  }
}
