import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
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
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { TranslatePipe } from '@ngx-translate/core';
import {
  TESTER_REPORT_KINDS,
  TESTER_REPORT_TEXT_MAX,
  type TesterReportContext,
  type TesterReportKind,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../core/api/api-error';
import { TesterReportsApi } from '../../core/tester-reports/tester-reports.api';

/** Контекст звіту, зібраний віджетом у момент відкриття, і `publicId` (якщо ввійшов). */
export interface TesterReportDialogData {
  context: TesterReportContext;
  publicId: string | null;
}

function trimmedRequired(control: AbstractControl<string>): ValidationErrors | null {
  return control.value.trim() ? null : { required: true };
}

/**
 * Невеликий діалог звіту тестувальника: тип (Баг / Ідея / Інше), текст і «Надіслати». Під полем —
 * дрібним текстом, що додасться автоматично. Після надсилання — подяка й «Закрити».
 */
@Component({
  selector: 'nri-tester-report-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatRadioModule,
    TranslatePipe,
  ],
  templateUrl: './tester-report-dialog.html',
  styleUrl: './tester-report-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesterReportDialog {
  protected readonly data = inject<TesterReportDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<TesterReportDialog, boolean>>(MatDialogRef);
  private readonly api = inject(TesterReportsApi);
  private readonly injector = inject(Injector);
  private readonly doneButton = viewChild<ElementRef<HTMLButtonElement>>('done');

  protected readonly kinds = TESTER_REPORT_KINDS;
  protected readonly max = TESTER_REPORT_TEXT_MAX;
  protected readonly kind = new FormControl<TesterReportKind>('bug', { nonNullable: true });
  protected readonly text = new FormControl('', {
    nonNullable: true,
    validators: [trimmedRequired, Validators.maxLength(TESTER_REPORT_TEXT_MAX)],
  });
  protected readonly form = new FormGroup({ kind: this.kind, text: this.text });
  private readonly value = toSignal(this.text.valueChanges, { initialValue: '' });
  protected readonly length = computed(() => this.value().length);

  protected readonly viewport = `${this.data.context.viewportWidth}×${this.data.context.viewportHeight}`;
  protected readonly submitting = signal(false);
  protected readonly sent = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting() || this.sent()) return;
    this.error.set(null);
    if (this.text.invalid) {
      this.text.markAsTouched();
      return;
    }
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.api.submit({
          kind: this.kind.value,
          text: this.text.value.trim(),
          context: this.data.context,
        }),
      );
      this.sent.set(true);
      // Кнопка «Надіслати» зникає — фокус на «Закрити», щоб не загубився.
      afterNextRender(() => this.doneButton()?.nativeElement.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.error.set(`errors.${toApiError(err).code}`);
    } finally {
      this.submitting.set(false);
    }
  }

  protected close(): void {
    this.ref.close(this.sent());
  }
}
