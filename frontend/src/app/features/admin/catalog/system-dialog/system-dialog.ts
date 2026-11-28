import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';
import {
  type AdminCatalogSystemDto,
  type AdminCatalogSystemPatchInput,
  CATALOG_NAME_MAX,
  CATALOG_SLUG_MAX,
  CATALOG_SLUG_RE,
  type CatalogGenreDto,
} from '@nri/shared';
import { firstValueFrom, type Observable } from 'rxjs';
import { toApiError } from '../../../../core/api/api-error';
import { AdminApi } from '../../../../core/moderation/admin.api';

/** Дані діалогу: `system` — редагування (slug незмінний), немає — нова система. */
export interface SystemDialogData {
  system?: AdminCatalogSystemDto;
  genres: readonly CatalogGenreDto[];
  /** Порядок нової системи за замовчуванням (у кінець списку). */
  nextSort: number;
}

/** Межі порядку — як у `adminCatalogSystemCreateSchema`. */
const SORT_LIMIT = 1_000_000;

function trimmedRequired(control: AbstractControl<string>): ValidationErrors | null {
  return control.value.trim() ? null : { required: true };
}

/**
 * Додавання й редагування системи каталогу (адмін+): назва, slug (лише при створенні), жанр
 * за замовчуванням, порядок. Закривається з відповіддю сервера; без змін — без запиту.
 */
@Component({
  selector: 'nri-admin-system-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
  ],
  templateUrl: './system-dialog.html',
  styleUrl: './system-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemDialog {
  protected readonly data = inject<SystemDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<SystemDialog, AdminCatalogSystemDto>>(MatDialogRef);
  private readonly api = inject(AdminApi);

  protected readonly isNew = !this.data.system;
  protected readonly nameMax = CATALOG_NAME_MAX;
  protected readonly slugMax = CATALOG_SLUG_MAX;

  protected readonly form = new FormGroup({
    name: new FormControl(this.data.system?.name ?? '', {
      nonNullable: true,
      validators: [trimmedRequired, Validators.maxLength(CATALOG_NAME_MAX)],
    }),
    slug: new FormControl(this.data.system?.slug ?? '', {
      nonNullable: true,
      validators: this.isNew
        ? [
            trimmedRequired,
            Validators.maxLength(CATALOG_SLUG_MAX),
            Validators.pattern(CATALOG_SLUG_RE),
          ]
        : [],
    }),
    genreId: new FormControl<number | null>(this.data.system?.defaultGenreId ?? null, [
      Validators.required,
    ]),
    sort: new FormControl<number | null>(this.data.system?.sort ?? this.data.nextSort, [
      Validators.required,
      Validators.pattern(/^-?\d+$/),
      Validators.min(-SORT_LIMIT),
      Validators.max(SORT_LIMIT),
    ]),
  });
  protected readonly c = this.form.controls;

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const request = this.request();
    if (!request) {
      this.ref.close();
      return;
    }
    this.submitting.set(true);
    try {
      this.ref.close(await firstValueFrom(request));
    } catch (err) {
      const { code, details } = toApiError(err);
      const reason = (details as { reason?: unknown } | undefined)?.reason;
      if (code === 'CATALOG_SLUG_TAKEN') {
        this.c.slug.setErrors({ taken: true });
      } else if (code === 'VALIDATION' && reason === 'UNKNOWN_GENRE') {
        this.c.genreId.setErrors({ unknown: true });
      } else if (code !== 'UNAUTHENTICATED') {
        this.error.set(`errors.${code}`);
      }
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }

  /** Запит створення чи PATCH лише зі зміненими полями; `null` — змін немає. */
  private request(): Observable<AdminCatalogSystemDto> | null {
    const name = this.c.name.value.trim();
    const defaultGenreId = this.c.genreId.value!;
    const sort = Number(this.c.sort.value);
    const current = this.data.system;
    if (!current) {
      return this.api.createCatalogSystem({
        name,
        slug: this.c.slug.value.trim(),
        defaultGenreId,
        sort,
      });
    }
    const patch: AdminCatalogSystemPatchInput = {};
    if (name !== current.name) patch.name = name;
    if (defaultGenreId !== current.defaultGenreId) patch.defaultGenreId = defaultGenreId;
    if (sort !== current.sort) patch.sort = sort;
    return Object.keys(patch).length ? this.api.updateCatalogSystem(current.id, patch) : null;
  }
}
