import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  FormArray,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
} from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { TranslatePipe } from '@ngx-translate/core';
import {
  AGE_RATINGS,
  type AgeRating,
  type ChannelLink,
  GAME_EXPERIENCE,
  GAME_LANGUAGES,
  GAME_LOCKED_AFTER_PUBLISH,
  type GameDto,
  type GameExperience,
  type GameFormat,
  type GameInput,
  type GameKind,
  type GameLanguage,
  type GamePatch,
  type GameStatus,
  RECURRENCES,
  type Recurrence,
  ageOn,
  gameInputSchema,
  isRestrictedGame,
  localDate,
  meetsAgeRating,
  toZoned,
  weekdayOf,
  zonedToUtc,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { GamesApi } from '../../../core/games/games.api';
import { provideUkDates } from '../../../core/i18n/dates';
import { WarningChip } from '../../../shared/warning-chip/warning-chip';

type SystemChoice = number | 'other' | null;

const DEFAULT_TZ = 'Europe/Kyiv';
/** 30 хв … 12 год з кроком 30 хв (як у схемі). */
const DURATIONS = Array.from({ length: 24 }, (_, i) => (i + 1) * 30);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const MAX_CHANNELS = 5;
const MAX_QUESTIONS = 10;
const MAX_CUSTOM_WARNINGS = 10;
const LOCKED_STATUSES = new Set<GameStatus>(['recruiting', 'started']);
const CLOSED_STATUSES = new Set<GameStatus>(['finished', 'cancelled']);

/** Поле схеми → контрол форми (решта збігаються за назвою). */
const FIELD_TO_CONTROL: Partial<Record<string, string>> = {
  systemId: 'system',
  startsAt: 'startDate',
};

/** Повідомлення для правил `superRefine` (code `custom`). */
const CUSTOM_ERROR: Partial<Record<string, string>> = {
  systemId: 'systemRequired',
  systemOther: 'systemRequired',
  city: 'cityRequired',
  weekdays: 'weekdays',
  minPlayers: 'players',
};

/** Причини `VALIDATION { reason }` з бекенду → контрол. */
const REASON_TO_CONTROL: Partial<Record<string, string>> = {
  UNKNOWN_SYSTEM: 'system',
  UNKNOWN_GENRE: 'genreId',
  UNKNOWN_WARNING: 'contentWarningIds',
};

interface ZodLikeIssue {
  code?: string;
  path?: PropertyKey[];
  origin?: string;
  maximum?: number | bigint;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Форма гри (створення й редагування). Валідація — та сама `gameInputSchema`, що й на бекенді;
 * помилки показуються біля полів. Дата й час — у поясі гри (для нової — користувача) і
 * перетворюються на UTC ISO цілої хвилини.
 */
@Component({
  selector: 'nri-game-form',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatRadioModule,
    TranslatePipe,
    WarningChip,
  ],
  providers: [provideUkDates()],
  templateUrl: './game-form.html',
  styleUrl: './game-form.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameForm implements OnInit {
  private readonly api = inject(GamesApi);
  private readonly catalogStore = inject(CatalogStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Параметр маршруту `/games/:id/edit`; немає — нова гра. */
  readonly id = input<string>();

  protected readonly durations = DURATIONS;
  protected readonly weekdays = WEEKDAYS;
  protected readonly recurrences = RECURRENCES;
  protected readonly ageRatings = AGE_RATINGS;
  protected readonly experiences = GAME_EXPERIENCE;
  protected readonly languages = GAME_LANGUAGES;
  protected readonly maxChannels = MAX_CHANNELS;
  protected readonly maxQuestions = MAX_QUESTIONS;
  protected readonly maxCustomWarnings = MAX_CUSTOM_WARNINGS;
  protected readonly today = new Date();

  protected readonly catalog = this.catalogStore.catalog;
  protected readonly game = signal<GameDto | null>(null);
  private readonly gameId = signal<number | null>(null);
  protected readonly loadingGame = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly submitted = signal(false);
  /** Загальна помилка форми (ключ i18n). */
  protected readonly formError = signal<string | null>(null);
  /** Помилки API біля полів: контрол → ключ i18n. */
  protected readonly apiErrors = signal<Readonly<Record<string, string>>>({});
  /** Результат останньої перевірки схемою. */
  protected readonly valid = signal(false);
  /** Зміна помилок контролів (вони не сигнали) — для перерахунку шаблону. */
  private readonly tick = signal(0);

  protected readonly status = computed<GameStatus>(() => this.game()?.status ?? 'draft');
  protected readonly isDraft = computed(() => this.status() === 'draft');
  protected readonly locked = computed(() => LOCKED_STATUSES.has(this.status()));
  protected readonly closed = computed(() => CLOSED_STATUSES.has(this.status()));
  protected readonly ready = computed(
    () => this.catalog() !== null && (this.id() === undefined || this.game() !== null),
  );
  protected readonly timezone = computed(
    () => this.game()?.timezone ?? this.auth.me()?.timezone ?? DEFAULT_TZ,
  );
  private readonly viewerAge = computed(() => {
    const me = this.auth.me();
    return me?.birthDate ? ageOn(me.birthDate, localDate(new Date(), me.timezone)) : null;
  });
  /** Системи каталогу + поточна система гри, якщо її вже прибрали з каталогу. */
  protected readonly systemOptions = computed(() => {
    const systems = this.catalog()?.systems ?? [];
    const current = this.game()?.system;
    return current && !systems.some((s) => s.id === current.id)
      ? [...systems, { ...current, slug: '', defaultGenreId: 0 }]
      : systems;
  });

  protected readonly form = new FormGroup({
    title: new FormControl('', { nonNullable: true }),
    description: new FormControl('', { nonNullable: true }),
    system: new FormControl<SystemChoice>(null),
    systemOther: new FormControl('', { nonNullable: true }),
    genreId: new FormControl<number | null>(null),
    format: new FormControl<GameFormat>('online', { nonNullable: true }),
    city: new FormControl('', { nonNullable: true }),
    address: new FormControl('', { nonNullable: true }),
    platform: new FormControl('', { nonNullable: true }),
    kind: new FormControl<GameKind>('oneshot', { nonNullable: true }),
    startDate: new FormControl<Date | null>(null),
    startTime: new FormControl('', { nonNullable: true }),
    durationMinutes: new FormControl(180, { nonNullable: true }),
    recurrence: new FormControl<Recurrence>('none', { nonNullable: true }),
    weekdays: new FormControl<number[]>([], { nonNullable: true }),
    minPlayers: new FormControl<number | null>(3),
    maxPlayers: new FormControl<number | null>(5),
    priceUah: new FormControl<number | null>(null),
    ageRating: new FormControl<AgeRating>('none', { nonNullable: true }),
    experience: new FormControl<GameExperience>('any', { nonNullable: true }),
    language: new FormControl<GameLanguage>('uk', { nonNullable: true }),
    requirements: new FormControl('', { nonNullable: true }),
    coverUrl: new FormControl('', { nonNullable: true }),
    contentWarningIds: new FormControl<number[]>([], { nonNullable: true }),
    customWarnings: new FormArray<FormControl<string>>([]),
    channelLinks: new FormArray<
      FormGroup<{ label: FormControl<string>; url: FormControl<string> }>
    >([]),
    applicationQuestions: new FormArray<FormControl<string>>([]),
    showWhenFull: new FormControl(false, { nonNullable: true }),
  });
  protected readonly c = this.form.controls;
  protected readonly newCustomWarning = new FormControl('', { nonNullable: true });
  /** Знімок значень для умовних блоків шаблону. */
  protected readonly value = signal(this.form.getRawValue());

  private prefilling = false;
  private marked: AbstractControl[] = [];

  constructor() {
    this.catalogStore.load().catch(() => this.loadError.set('errors.INTERNAL'));

    // Система → типовий жанр, якщо користувач жанр ще не обирав сам.
    this.c.system.valueChanges.pipe(takeUntilDestroyed()).subscribe((choice) => {
      if (this.prefilling || this.c.genreId.dirty || typeof choice !== 'number') return;
      const system = this.catalog()?.systems.find((s) => s.id === choice);
      if (system) this.c.genreId.setValue(system.defaultGenreId);
    });
    // Щотижнева регулярність → підставляємо день першої сесії.
    this.c.recurrence.valueChanges.pipe(takeUntilDestroyed()).subscribe((r) => {
      const date = this.c.startDate.value;
      if (this.prefilling || (r !== 'weekly' && r !== 'biweekly')) return;
      if (this.c.weekdays.value.length === 0 && date) {
        this.c.weekdays.setValue([
          weekdayOf(date.getFullYear(), date.getMonth() + 1, date.getDate()),
        ]);
      }
    });
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.validate());
    this.validate();
  }

  ngOnInit(): void {
    const raw = this.id();
    if (raw === undefined) return;
    if (!/^\d{1,15}$/.test(raw)) {
      this.loadError.set('errors.NOT_FOUND');
      return;
    }
    void this.loadGame(Number(raw));
  }

  // ---------- шаблон ----------

  /** Помилка контролу (ключ i18n) — від схеми чи datepicker-а. */
  protected errorKey(path: string): string | null {
    this.tick();
    const errors = this.form.get(path)?.errors;
    if (!errors) return null;
    if (errors['matDatepickerParse']) return 'profile.errors.INVALID_DATE';
    if (errors['matDatepickerMin']) return 'games.form.errors.pastDate';
    return (errors['schema'] as string | undefined) ?? null;
  }

  /** Помилка для полів поза `mat-form-field` (радіо, перемикачі, чипи). */
  protected looseError(path: string): string | null {
    const key = this.errorKey(path);
    const control = this.form.get(path);
    return key && (control?.touched || this.submitted()) ? key : null;
  }

  protected apiError(control: string): string | null {
    return this.apiErrors()[control] ?? null;
  }

  protected ageAllowed(rating: AgeRating): boolean {
    return meetsAgeRating(this.viewerAge(), rating);
  }

  protected hours(minutes: number): string {
    return (minutes / 60).toLocaleString('uk-UA');
  }

  protected warningSelected(id: number): boolean {
    return this.value().contentWarningIds.includes(id);
  }

  protected toggleWarning(id: number): void {
    const current = this.c.contentWarningIds.value;
    this.c.contentWarningIds.setValue(
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
    this.c.contentWarningIds.markAsDirty();
    this.c.contentWarningIds.markAsTouched();
  }

  protected addCustomWarning(): void {
    const text = this.newCustomWarning.value.trim();
    const list = this.c.customWarnings;
    if (!text || list.length >= MAX_CUSTOM_WARNINGS || list.value.includes(text)) return;
    list.push(new FormControl(text, { nonNullable: true }));
    this.newCustomWarning.setValue('');
  }

  protected removeCustomWarning(i: number): void {
    this.c.customWarnings.removeAt(i);
  }

  protected addChannel(): void {
    if (this.c.channelLinks.length >= MAX_CHANNELS) return;
    this.c.channelLinks.push(this.channelGroup({ label: '', url: '' }));
  }

  protected removeChannel(i: number): void {
    this.c.channelLinks.removeAt(i);
  }

  protected addQuestion(): void {
    if (this.c.applicationQuestions.length >= MAX_QUESTIONS) return;
    this.c.applicationQuestions.push(new FormControl('', { nonNullable: true }));
  }

  protected removeQuestion(i: number): void {
    this.c.applicationQuestions.removeAt(i);
  }

  // ---------- збереження ----------

  /** «Зберегти чернетку» / «Зберегти зміни» (submit форми). */
  protected async save(): Promise<void> {
    await this.persist(false);
  }

  protected async publish(): Promise<void> {
    await this.persist(true);
  }

  private async persist(publish: boolean): Promise<void> {
    if (this.busy() || this.closed()) return;
    this.submitted.set(true);
    this.form.markAllAsTouched();
    const input = this.validate();
    if (!input) {
      this.focusFirstInvalid();
      return;
    }
    this.busy.set(true);
    this.formError.set(null);
    this.apiErrors.set({});
    try {
      const id = this.gameId();
      let dto: GameDto;
      if (id === null) {
        dto = await firstValueFrom(this.api.create(input));
        // Чернетку вже створено: повторне збереження (напр. після помилки публікації) — PATCH.
        this.gameId.set(dto.id);
        this.game.set(dto);
        this.location.replaceState(`/games/${dto.id}/edit`);
      } else {
        dto = await firstValueFrom(this.api.update(id, this.patchFor(input)));
        this.game.set(dto);
      }
      if (publish) await firstValueFrom(this.api.transition(dto.id, 'publish'));
      await this.router.navigateByUrl('/my-games');
    } catch (err) {
      this.showApiError(err);
    } finally {
      this.busy.set(false);
    }
  }

  /** Після публікації заблоковані поля не надсилаються. */
  private patchFor(input: GameInput): GamePatch {
    if (!this.locked()) return input;
    const patch: Record<string, unknown> = { ...input };
    for (const field of GAME_LOCKED_AFTER_PUBLISH) delete patch[field];
    return patch as GamePatch;
  }

  private showApiError(err: unknown): void {
    const { code, details } = toApiError(err);
    if (code === 'UNAUTHENTICATED') return;
    const fieldErrors: Record<string, string> = {};
    const d = (details ?? {}) as { field?: unknown; reason?: unknown };
    if (code === 'GAME_FIELD_LOCKED' && typeof d.field === 'string') {
      fieldErrors[this.controlName(d.field)] = 'errors.GAME_FIELD_LOCKED';
    } else if (code === 'AGE_RESTRICTED_CREATE') {
      fieldErrors['ageRating'] = 'errors.AGE_RESTRICTED_CREATE';
    } else if (code === 'GAME_IN_PAST') {
      fieldErrors['startDate'] = 'errors.GAME_IN_PAST';
    } else if (code === 'VALIDATION') {
      if (Array.isArray(details)) {
        for (const issue of details as ZodLikeIssue[]) {
          const field = issue.path?.[0];
          if (typeof field === 'string') {
            fieldErrors[this.controlName(field)] = 'games.form.errors.invalid';
          }
        }
      } else if (typeof d.reason === 'string' && REASON_TO_CONTROL[d.reason]) {
        fieldErrors[REASON_TO_CONTROL[d.reason]!] = `games.form.errors.${d.reason}`;
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      this.apiErrors.set(fieldErrors);
      this.focusFirstInvalid();
    } else {
      this.formError.set(`errors.${code}`);
    }
  }

  // ---------- валідація ----------

  /**
   * Перевіряє форму схемою з @nri/shared і розставляє помилки на контроли.
   * Повертає нормалізовані дані або `null`.
   */
  private validate(): GameInput | null {
    this.value.set(this.form.getRawValue());
    for (const control of this.marked) {
      control.updateValueAndValidity({ onlySelf: true, emitEvent: false });
    }
    this.marked = [];
    const result = gameInputSchema(this.timezone()).safeParse(this.payload());
    if (!result.success) {
      for (const issue of result.error.issues) this.markIssue(issue);
    }
    this.tick.update((n) => n + 1);
    const ok = result.success && this.c.startDate.errors === null;
    this.valid.set(ok);
    return ok ? result.data : null;
  }

  private markIssue(issue: ZodLikeIssue): void {
    const path = issue.path ?? [];
    const field = path[0];
    if (typeof field !== 'string') return;
    const control = this.form.get([
      this.controlName(field),
      ...(path.slice(1) as (string | number)[]),
    ]);
    if (!control || control.disabled || control.errors?.['schema']) return;
    control.setErrors(
      { ...control.errors, schema: this.issueKey(field, issue) },
      { emitEvent: false },
    );
    this.marked.push(control);
  }

  private issueKey(field: string, issue: ZodLikeIssue): string {
    const key = (k: string) => `games.form.errors.${k}`;
    switch (issue.code) {
      case 'custom':
        return key(CUSTOM_ERROR[field] ?? 'invalid');
      case 'invalid_type':
        return key('required');
      case 'invalid_format':
        return key(field === 'coverUrl' || field === 'channelLinks' ? 'httpsUrl' : 'invalid');
      case 'too_small':
      case 'too_big':
        if (issue.origin === 'string') {
          return issue.code === 'too_small' ? key('required') : key('tooLong');
        }
        if (field === 'minPlayers' || field === 'maxPlayers') return key('playersRange');
        if (field === 'priceUah') return key('price');
        return key('invalid');
      default:
        return key('invalid');
    }
  }

  /** Назва контролу для поля схеми. */
  private controlName(field: string): string {
    if (field === 'systemId' || field === 'systemOther') {
      if (this.c.system.value === 'other') return 'systemOther';
      return 'system';
    }
    if (field === 'startsAt' && this.c.startDate.value && !this.c.startTime.value) {
      return 'startTime';
    }
    return FIELD_TO_CONTROL[field] ?? field;
  }

  /** Вхід схеми зі значень форми (приховані поля — `null`/типові). */
  private payload(): Record<string, unknown> {
    const v = this.form.getRawValue();
    const offline = v.format === 'offline';
    const recurrence = v.kind === 'campaign' ? v.recurrence : 'none';
    const weekly = recurrence === 'weekly' || recurrence === 'biweekly';
    return {
      title: v.title,
      description: v.description,
      systemId: typeof v.system === 'number' ? v.system : null,
      systemOther: v.system === 'other' ? v.systemOther : null,
      genreId: v.genreId,
      format: v.format,
      city: offline ? v.city : null,
      address: offline ? v.address : null,
      platform: offline ? null : v.platform,
      kind: v.kind,
      startsAt: this.startsAt(v.startDate, v.startTime),
      durationMinutes: v.durationMinutes,
      recurrence,
      weekdays: weekly ? v.weekdays : [],
      minPlayers: v.minPlayers,
      maxPlayers: v.maxPlayers,
      priceUah: v.priceUah,
      ageRating: v.ageRating,
      experience: v.experience,
      language: v.language,
      requirements: v.requirements,
      coverUrl: v.coverUrl.trim() || null,
      channelLinks: v.channelLinks satisfies ChannelLink[],
      applicationQuestions: v.applicationQuestions,
      customWarnings: v.customWarnings,
      contentWarningIds: v.contentWarningIds,
      showWhenFull: v.showWhenFull,
    };
  }

  /** Дата (календарна) + `HH:mm` у поясі гри → UTC ISO; неповні дані — `undefined`. */
  private startsAt(date: Date | null, time: string): string | undefined {
    const m = /^(\d{2}):(\d{2})$/.exec(time);
    if (!date || Number.isNaN(date.getTime()) || !m) return undefined;
    return zonedToUtc(
      {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: Number(m[1]),
        minute: Number(m[2]),
      },
      this.timezone(),
    ).toISOString();
  }

  // ---------- завантаження ----------

  private async loadGame(id: number): Promise<void> {
    this.loadingGame.set(true);
    try {
      const view = await firstValueFrom(this.api.get(id));
      const me = this.auth.me();
      if (
        isRestrictedGame(view) ||
        !('channelLinks' in view) ||
        view.gm.publicId !== me?.publicId
      ) {
        this.loadError.set('errors.FORBIDDEN');
        return;
      }
      this.gameId.set(view.id);
      this.game.set(view);
      this.prefill(view);
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.loadError.set(`errors.${code}`);
    } finally {
      this.loadingGame.set(false);
    }
  }

  private prefill(g: GameDto): void {
    this.prefilling = true;
    const start = toZoned(new Date(g.startsAt), g.timezone);
    this.form.patchValue({
      title: g.title,
      description: g.description,
      system: g.system?.id ?? (g.systemOther !== null ? 'other' : null),
      systemOther: g.systemOther ?? '',
      genreId: g.genreId,
      format: g.format,
      city: g.city ?? '',
      address: g.address ?? '',
      platform: g.platform ?? '',
      kind: g.kind,
      startDate: new Date(start.year, start.month - 1, start.day),
      startTime: `${pad(start.hour)}:${pad(start.minute)}`,
      durationMinutes: g.durationMinutes,
      recurrence: g.recurrence,
      weekdays: [...g.weekdays],
      minPlayers: g.minPlayers,
      maxPlayers: g.maxPlayers,
      priceUah: g.priceUah,
      ageRating: g.ageRating,
      experience: g.experience,
      language: g.language,
      requirements: g.requirements ?? '',
      coverUrl: g.coverUrl ?? '',
      contentWarningIds: [...g.contentWarningIds],
      showWhenFull: g.showWhenFull,
    });
    this.c.customWarnings.clear();
    for (const w of g.customWarnings) {
      this.c.customWarnings.push(new FormControl(w, { nonNullable: true }));
    }
    this.c.channelLinks.clear();
    for (const link of g.channelLinks) this.c.channelLinks.push(this.channelGroup(link));
    this.c.applicationQuestions.clear();
    for (const q of g.applicationQuestions) {
      this.c.applicationQuestions.push(new FormControl(q, { nonNullable: true }));
    }
    // Жанр гри вже обрано — зміна системи його не перезаписує.
    this.c.genreId.markAsDirty();
    this.prefilling = false;
    if (CLOSED_STATUSES.has(g.status)) {
      this.form.disable();
    } else if (LOCKED_STATUSES.has(g.status)) {
      this.c.system.disable();
      this.c.systemOther.disable();
      this.c.kind.disable();
    }
    this.validate();
  }

  private channelGroup(link: ChannelLink) {
    return new FormGroup({
      label: new FormControl(link.label, { nonNullable: true }),
      url: new FormControl(link.url, { nonNullable: true }),
    });
  }

  /** Фокус на першому полі з помилкою після рендеру. */
  private focusFirstInvalid(): void {
    afterNextRender(
      () => {
        const el = this.host.nativeElement.querySelector<HTMLElement>(
          '[aria-invalid="true"], .field-error',
        );
        const target =
          el?.classList.contains('field-error') === true
            ? el.closest('.field')?.querySelector<HTMLElement>('input, select, textarea, button')
            : el;
        target?.focus();
      },
      { injector: this.injector },
    );
  }
}
