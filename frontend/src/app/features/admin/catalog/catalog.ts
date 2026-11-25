import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { AdminCatalogSystemDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { AdminApi } from '../../../core/moderation/admin.api';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';
import { SystemDialog, type SystemDialogData } from './system-dialog/system-dialog';

const DIALOG = {
  autoFocus: 'first-tabbable',
  restoreFocus: true,
  width: '560px',
  maxWidth: 'calc(100vw - 32px)',
} as const;

/** Крок порядку для нової системи (у кінець списку). */
const SORT_STEP = 10;

/** Повідомлення вкладки: ключ i18n. */
interface Message {
  kind: 'error' | 'info';
  key: string;
}

/**
 * Вкладка «Каталог» (адмін і власник): усі системи, зокрема вимкнені. Додати систему,
 * змінити назву / жанр за замовчуванням / порядок, вимкнути чи увімкнути (з підтвердженням).
 * Вимкнена система не пропонується в нових іграх; наявні ігри її зберігають.
 */
@Component({
  selector: 'nri-admin-catalog',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './catalog.html',
  styleUrls: ['../admin-list.less', './catalog.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminCatalog {
  private readonly api = inject(AdminApi);
  private readonly catalogStore = inject(CatalogStore);
  private readonly dialog = inject(MatDialog);

  protected readonly systems = signal<AdminCatalogSystemDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busyId = signal<number | null>(null);
  protected readonly message = signal<Message | null>(null);
  /** Жанри — з публічного каталогу (їх не редагують). */
  private readonly genres = computed(() => this.catalogStore.catalog()?.genres ?? []);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      const [{ items }] = await Promise.all([
        firstValueFrom(this.api.catalogSystems()),
        this.catalogStore.load(),
      ]);
      this.systems.set(items);
    } catch (err) {
      if (toApiError(err).code !== 'UNAUTHENTICATED') this.loadFailed.set(true);
    }
  }

  protected genreKey(id: number): string | null {
    return this.catalogStore.genreKey(id);
  }

  protected async create(): Promise<void> {
    const list = this.systems() ?? [];
    const nextSort = list.length ? Math.max(...list.map((s) => s.sort)) + SORT_STEP : 0;
    const saved = await this.openDialog({ genres: this.genres(), nextSort });
    if (!saved) return;
    this.systems.update((items) => sorted([...(items ?? []), saved]));
    this.changed('created');
  }

  protected async edit(system: AdminCatalogSystemDto): Promise<void> {
    const saved = await this.openDialog({ system, genres: this.genres(), nextSort: system.sort });
    if (!saved) return;
    this.replace(saved);
    this.changed('updated');
  }

  /** Вимкнути / увімкнути — лише після підтвердження. */
  protected async toggle(system: AdminCatalogSystemDto): Promise<void> {
    if (this.busyId() !== null) return;
    const action = system.isActive ? 'disable' : 'enable';
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: `admin.catalog.${action}Title`,
        text: `admin.catalog.${action}Text`,
        params: { name: system.name },
        confirm: `admin.catalog.${action}`,
        danger: action === 'disable',
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.busyId.set(system.id);
    this.message.set(null);
    try {
      const saved = await firstValueFrom(
        this.api.updateCatalogSystem(system.id, { isActive: !system.isActive }),
      );
      this.replace(saved);
      this.changed(saved.isActive ? 'enabled' : 'disabled');
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.message.set({ kind: 'error', key: `errors.${code}` });
    } finally {
      this.busyId.set(null);
    }
  }

  private openDialog(data: SystemDialogData): Promise<AdminCatalogSystemDto | undefined> {
    return firstValueFrom(
      this.dialog
        .open<SystemDialog, SystemDialogData, AdminCatalogSystemDto>(SystemDialog, {
          ...DIALOG,
          data,
        })
        .afterClosed(),
    );
  }

  private replace(saved: AdminCatalogSystemDto): void {
    this.systems.update((items) =>
      sorted((items ?? []).map((s) => (s.id === saved.id ? saved : s))),
    );
  }

  /** Після зміни — повідомлення й свіжий каталог для форм ігор. */
  private changed(done: 'created' | 'updated' | 'enabled' | 'disabled'): void {
    this.message.set({ kind: 'info', key: `admin.catalog.done.${done}` });
    this.catalogStore.invalidate();
  }
}

/** Порядок як на сервері: `sort`, потім `id`. */
function sorted(items: AdminCatalogSystemDto[]): AdminCatalogSystemDto[] {
  return [...items].sort((a, b) => a.sort - b.sort || a.id - b.id);
}
