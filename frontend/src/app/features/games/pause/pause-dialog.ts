import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { TranslatePipe } from '@ngx-translate/core';
import { PAUSE_NOTE_MAX, PAUSE_REASONS, type GameDto, type PauseReason } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { GamesApi } from '../../../core/games/games.api';

export interface PauseDialogData {
  gameId: number;
  title: string;
  /** Перед запитом (напр. приглушити власні пінги змін, що прийдуть раніше за відповідь). */
  beforeRequest?: () => void;
}

/**
 * «Поставити на паузу»: причина зі списку (обов'язкова) і необов'язкове пояснення до
 * `PAUSE_NOTE_MAX` символів (бачать учасники). Закривається з оновленою `GameDto`.
 */
@Component({
  selector: 'nri-pause-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatRadioModule,
    TranslatePipe,
  ],
  templateUrl: './pause-dialog.html',
  styleUrl: './pause-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PauseDialog {
  protected readonly data = inject<PauseDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<PauseDialog, GameDto>>(MatDialogRef);
  private readonly api = inject(GamesApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly reasons = PAUSE_REASONS;
  protected readonly max = PAUSE_NOTE_MAX;
  protected readonly form = new FormGroup({
    reason: new FormControl<PauseReason | null>(null, { validators: [Validators.required] }),
    note: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(PAUSE_NOTE_MAX)],
    }),
  });
  protected readonly reason = this.form.controls.reason;
  protected readonly note = this.form.controls.note;
  protected readonly noteLength = toSignal(this.note.valueChanges, { initialValue: '' });
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    const { reason, note } = this.form.getRawValue();
    if (this.form.invalid || !reason) {
      this.form.markAllAsTouched();
      this.focus(this.reason.invalid ? 'mat-radio-button input' : 'textarea');
      return;
    }
    this.submitting.set(true);
    try {
      const trimmed = note.trim();
      this.data.beforeRequest?.();
      const dto = await firstValueFrom(
        this.api.pause(this.data.gameId, { reason, note: trimmed || null }),
      );
      this.ref.close(dto);
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
