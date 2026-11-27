import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  TESTER_REPORT_THEME_MAX,
  TESTER_REPORT_UA_MAX,
  TESTER_REPORT_URL_MAX,
  stripReportUrlSecrets,
  type TesterReportContext,
} from '@nri/shared';
import { runtimeConfig } from '../../../environments/runtime-config';
import { AuthStore } from '../../core/auth/auth.store';
import { ThemeService } from '../../theming/theme.service';
import { TesterReportDialog, type TesterReportDialogData } from './tester-report-dialog';

/**
 * Плаваюча кнопка внизу справа: відкриває діалог звіту. На dev («Повідомити») — для всіх,
 * гостей теж; поза dev («Відгук») — лише для того, хто ввійшов (сервер: 2 на добу).
 * Банер «Тестове середовище» — у лівому нижньому куті, тож не перекриваються.
 */
@Component({
  selector: 'nri-tester-report',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './tester-report.html',
  styleUrl: './tester-report.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesterReport {
  /** Середовище розгортання (за замовчуванням — з конфігу збірки). */
  readonly deployEnv = input<string>(runtimeConfig.deployEnv);

  private readonly dialog = inject(MatDialog);
  private readonly doc = inject(DOCUMENT);
  private readonly auth = inject(AuthStore);
  private readonly theme = inject(ThemeService);

  /** Контекст у момент відкриття: сторінка без секретів, дизайн, вікно, user agent. */
  protected context(): TesterReportContext {
    const win = this.doc.defaultView;
    return {
      url: stripReportUrlSecrets(this.doc.location.href).slice(0, TESTER_REPORT_URL_MAX),
      theme: this.theme.theme().slice(0, TESTER_REPORT_THEME_MAX),
      viewportWidth: Math.max(0, Math.round(win?.innerWidth ?? 0)),
      viewportHeight: Math.max(0, Math.round(win?.innerHeight ?? 0)),
      userAgent: (win?.navigator.userAgent ?? '').slice(0, TESTER_REPORT_UA_MAX),
    };
  }

  /** Dev — тестувальницький режим («Повідомити»); інакше — нейтральний «Відгук». */
  protected readonly dev = computed(() => this.deployEnv() === 'dev');
  protected readonly visible = computed(() => this.dev() || this.auth.me() !== null);

  protected open(): void {
    if (this.dialog.getDialogById(DIALOG_ID)) return;
    this.dialog.open<TesterReportDialog, TesterReportDialogData, boolean>(TesterReportDialog, {
      id: DIALOG_ID,
      data: {
        context: this.context(),
        publicId: this.auth.me()?.publicId ?? null,
        feedback: !this.dev(),
      },
      width: '480px',
      maxWidth: 'calc(100vw - 32px)',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }
}

const DIALOG_ID = 'nri-tester-report-dialog';
