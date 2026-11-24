import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe } from '@ngx-translate/core';
import {
  EXPERIENCE_LEVELS,
  PREFERRED_FORMATS,
  PROFILE_PRIVACY_KEYS,
  type ExperienceLevel,
  type PreferredFormat,
  type ProfileDto,
  type ProfilePrivacyKey,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { ProfileApi } from '../../../core/profile/profile.api';

export const BIO_MAX = 1000;
export const CITY_MAX = 80;
export const FAVORITE_SYSTEMS_MAX = 10;

type PrivacyGroup = FormGroup<Record<ProfilePrivacyKey, FormControl<boolean>>>;

/**
 * Редагування власного профілю (`/profile/edit`). Біля кожного поля — перемикач
 * «Показувати в профілі» (`privacy`); приховане поле бекенд не віддає іншим.
 */
@Component({
  selector: 'nri-profile-edit',
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    TranslatePipe,
  ],
  templateUrl: './profile-edit.html',
  styleUrl: './profile-edit.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileEdit {
  private readonly api = inject(ProfileApi);
  private readonly catalogStore = inject(CatalogStore);
  private readonly auth = inject(AuthStore);

  protected readonly bioMax = BIO_MAX;
  protected readonly cityMax = CITY_MAX;
  protected readonly systemsMax = FAVORITE_SYSTEMS_MAX;
  protected readonly formats = PREFERRED_FORMATS;
  protected readonly experiences = EXPERIENCE_LEVELS;
  protected readonly catalog = this.catalogStore.catalog;
  protected readonly publicId = computed(() => this.auth.me()?.publicId ?? null);

  protected readonly form = new FormGroup({
    bio: new FormControl('', { nonNullable: true, validators: Validators.maxLength(BIO_MAX) }),
    city: new FormControl('', { nonNullable: true, validators: Validators.maxLength(CITY_MAX) }),
    favoriteSystemIds: new FormControl<number[]>([], {
      nonNullable: true,
      validators: Validators.maxLength(FAVORITE_SYSTEMS_MAX),
    }),
    preferredFormats: new FormControl<PreferredFormat[]>([], { nonNullable: true }),
    experience: new FormControl<ExperienceLevel | null>(null),
    privacy: new FormGroup(
      Object.fromEntries(
        PROFILE_PRIVACY_KEYS.map((k) => [k, new FormControl(true, { nonNullable: true })]),
      ) as Record<ProfilePrivacyKey, FormControl<boolean>>,
    ) as PrivacyGroup,
  });

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly saving = signal(false);
  protected readonly message = signal<{ kind: 'error' | 'info'; key: string } | null>(null);
  protected readonly bioLength = toSignal(this.form.controls.bio.valueChanges, {
    initialValue: '',
  });
  protected readonly formatsValue = toSignal(this.form.controls.preferredFormats.valueChanges, {
    initialValue: [] as PreferredFormat[],
  });

  constructor() {
    void this.catalogStore.load();
    void this.load();
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.reset(await firstValueFrom(this.api.getMine()));
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  private reset(p: ProfileDto): void {
    this.form.reset({
      bio: p.bio ?? '',
      city: p.city ?? '',
      favoriteSystemIds: p.favoriteSystemIds,
      preferredFormats: p.preferredFormats,
      experience: p.experience,
      privacy: p.privacy,
    });
  }

  protected privacyControl(key: ProfilePrivacyKey): FormControl<boolean> {
    return this.form.controls.privacy.controls[key];
  }

  protected toggleFormat(format: PreferredFormat, checked: boolean): void {
    const c = this.form.controls.preferredFormats;
    const cur = c.value.filter((f) => f !== format);
    c.setValue(checked ? PREFERRED_FORMATS.filter((f) => f === format || cur.includes(f)) : cur);
    c.markAsDirty();
  }

  protected async save(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) return;
    this.saving.set(true);
    this.message.set(null);
    const v = this.form.getRawValue();
    try {
      const saved = await firstValueFrom(
        this.api.update({
          bio: v.bio.trim() || null,
          city: v.city.trim() || null,
          favoriteSystemIds: v.favoriteSystemIds,
          preferredFormats: v.preferredFormats,
          experience: v.experience,
          privacy: v.privacy,
        }),
      );
      this.reset(saved);
      this.message.set({ kind: 'info', key: 'profileEdit.saved' });
    } catch {
      this.message.set({ kind: 'error', key: 'profileEdit.saveError' });
    } finally {
      this.saving.set(false);
    }
  }
}
