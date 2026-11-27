import { DOCUMENT, Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
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
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import type { ErrorStateMatcher } from '@angular/material/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  AGE_RATINGS,
  type AgeRating,
  type ChannelLink,
  GAME_EXPERIENCE,
  GAME_LANGUAGES,
  GAME_LOCKED_AFTER_PUBLISH,
  IMAGE_URL_INVALID_REASONS,
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
  SAFETY_TOOLS,
  type SafetyList,
  type SafetyTool,
  emptySafetyList,
  ageOn,
  gameInputSchema,
  isRestrictedGame,
  localDate,
  meetsAgeRating,
  toZoned,
  weekdayOf,
  zonedToUtc,
  type SanctionActiveDetails,
} from '@nri/shared';
import { firstValueFrom, fromEvent, merge } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { GamesApi } from '../../../core/games/games.api';
import { fromIsoDate, provideUkDates } from '../../../core/i18n/dates';
import { WarningChip } from '../../../shared/warning-chip/warning-chip';
import { sanctionActiveDetails } from '../../../core/moderation/sanction-active';
import { SanctionActiveNotice } from '../../moderation/sanction-active-notice/sanction-active-notice';
import { DeadGamesNotice } from '../dead-games/dead-games-notice';
import { StartTimeField } from '../../sessions/start-time-field/start-time-field';
import { GameSafetyFields, type SafetyChange } from './safety-fields/game-safety-fields';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';
import {
  type StoredGameValues,
  gameDraftKey,
  readGameDraft,
  removeGameDraft,
  writeGameDraft,
} from '../../../core/games/game-draft-storage';

type SystemChoice = number | 'other' | null;

const DEFAULT_TZ = 'Europe/Kyiv';
/** 30 хв … 12 год з кроком 30 хв (як у схемі). */
const DURATIONS = Array.from({ length: 24 }, (_, i) => (i + 1) * 30);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const MAX_CHANNELS = 5;
const MAX_QUESTIONS = 10;
const MAX_CUSTOM_WARNINGS = 10;
/** Затримка автозбереження незбережених значень у `localStorage`. */
const AUTOSAVE_DEBOUNCE_MS = 500;
const LOCKED_STATUSES = new Set<GameStatus>(['recruiting', 'started', 'paused']);
/** Розклад лише для читання: гра йде (зміна — на сторінці гри) чи на паузі (— відновленням). */
const SCHEDULE_LOCKED = new Set<GameStatus>(['started', 'paused']);
const CLOSED_STATUSES = new Set<GameStatus>(['finished', 'cancelled']);
/**
 * Поля правила розкладу. Для гри, що вже йде, вони лише для читання: розклад змінюється
 * на сторінці гри («Змінити розклад» / «Перетворити на кампанію»), де сесії перебудовуються.
 */
const RULE_CONTROLS = [
  'startDate',
  'startTime',
  'startWindowMinutes',
  'durationMinutes',
  'recurrence',
  'weekdays',
] as const;
const RULE_FIELDS = [
  'startsAt',
  'startWindowMinutes',
  'durationMinutes',
  'recurrence',
  'weekdays',
] as const;

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
  veils: 'safetyOverlap',
};

/** Поля безпеки гри: контрол тримає ціле значення (помилки вкладених шляхів — на ньому). */
const SAFETY_CONTROLS = new Set(['safetyTools', 'lines', 'veils']);

/** Причини `VALIDATION { reason }` з бекенду → контрол. */
const REASON_TO_CONTROL: Partial<Record<string, string>> = {
  UNKNOWN_SYSTEM: 'system',
  UNKNOWN_GENRE: 'genreId',
  UNKNOWN_WARNING: 'contentWarningIds',
};

/** Розділи форми (ключі `games.form.sections.*`) — для підказки біля «Опублікувати». */
const SECTIONS = [
  'main',
  'place',
  'schedule',
  'players',
  'warnings',
  'safety',
  'channels',
  'questions',
] as const;
type Section = (typeof SECTIONS)[number];
const CONTROL_SECTION: Record<string, Section> = {
  title: 'main',
  description: 'main',
  system: 'main',
  systemOther: 'main',
  genreId: 'main',
  coverUrl: 'main',
  format: 'place',
  city: 'place',
  address: 'place',
  platform: 'place',
  language: 'place',
  kind: 'schedule',
  startDate: 'schedule',
  startTime: 'schedule',
  startWindowMinutes: 'schedule',
  durationMinutes: 'schedule',
  recurrence: 'schedule',
  weekdays: 'schedule',
  minPlayers: 'players',
  maxPlayers: 'players',
  priceUah: 'players',
  ageRating: 'players',
  experience: 'players',
  requirements: 'players',
  showWhenFull: 'players',
  contentWarningIds: 'warnings',
  customWarnings: 'warnings',
  safetyTools: 'safety',
  lines: 'safety',
  veils: 'safety',
  channelLinks: 'channels',
  applicationQuestions: 'questions',
};

interface ZodLikeIssue {
  code?: string;
  path?: PropertyKey[];
  origin?: string;
  maximum?: number | bigint;
}

const pad = (n: number) => String(n).padStart(2, '0');

const isString = (x: unknown): x is string => typeof x === 'string';
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every(isString);
const isNumberArray = (x: unknown): x is number[] => Array.isArray(x) && x.every(isNumber);
const isSafetyTools = (x: unknown): x is SafetyTool[] =>
  Array.isArray(x) && x.every((t) => (SAFETY_TOOLS as readonly unknown[]).includes(t));
const isSafetyList = (x: unknown): x is SafetyList => {
  const l = x as Partial<SafetyList> | null;
  return (
    typeof l === 'object' && l !== null && isNumberArray(l.warningIds) && isStringArray(l.custom)
  );
};

/** Календарна дата datepicker-а ↔ `YYYY-MM-DD` для збереження. */
function dateToStored(d: Date | null): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateFromStored(x: unknown): Date | null | undefined {
  if (x === null) return null;
  const m = isString(x) ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(x) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

/**
 * Форма гри (створення й редагування). Валідація — та сама `gameInputSchema`, що й на бекенді;
 * помилки показуються біля полів. Дата й час — у поясі гри (для нової — користувача) і
 * перетворюються на UTC ISO цілої хвилини.
 *
 * Автозбереження: введені значення (із затримкою) лежать у `localStorage` під ключем
 * користувача й гри і відновлюються після перезавантаження; копія зникає після успішного
 * збереження чи «Відкинути зміни». Для завершених/скасованих ігор нічого не зберігається.
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
    SanctionActiveNotice,
    DeadGamesNotice,
    StartTimeField,
    GameSafetyFields,
  ],
  providers: [provideUkDates()],
  templateUrl: './game-form.html',
  styleUrl: './game-form.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameForm {
  private readonly api = inject(GamesApi);
  private readonly catalogStore = inject(CatalogStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly dialog = inject(MatDialog);

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

  protected readonly catalog = this.catalogStore.catalog;
  protected readonly game = signal<GameDto | null>(null);
  protected readonly gameId = signal<number | null>(null);
  protected readonly loadingGame = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly submitted = signal(false);
  /** Загальна помилка форми (ключ i18n). */
  protected readonly formError = signal<string | null>(null);
  /** Відмова через санкцію (409 `SANCTION_ACTIVE`, напр. платна гра під забороною). */
  protected readonly sanction = signal<SanctionActiveDetails | null>(null);
  /** Відмова 409 `GAME_CREATION_BLOCKED`: «мертві» ігри майстра (`details.deadGameIds`). */
  protected readonly blockedBy = signal<readonly number[] | null>(null);
  /** Блок знято («Все ок» / «Закрити» для всіх «мертвих» ігор) — можна зберегти ще раз. */
  protected readonly unblocked = signal(false);
  /** Помилки API біля полів: контрол → ключ i18n. */
  protected readonly apiErrors = signal<Readonly<Record<string, string>>>({});
  /** Значення контролів у момент помилки API: зміна значення прибирає помилку. */
  private apiErrorValues: Record<string, string> = {};
  /** Результат останньої перевірки схемою. */
  protected readonly valid = signal(false);
  /** Розділи з помилками (порядок форми). */
  protected readonly invalidSections = signal<Section[]>([]);
  /** Зміна помилок контролів (вони не сигнали) — для перерахунку шаблону. */
  private readonly tick = signal(0);
  /** Форму заповнено незбереженими значеннями з `localStorage`. */
  protected readonly restored = signal(false);
  /** Локальну копію відкинуто: гру тим часом змінено на сервері (інший пристрій). */
  protected readonly staleDropped = signal(false);
  /** Значення відрізняються від збережених (сервера чи типових для нової гри). */
  protected readonly hasChanges = signal(false);

  protected readonly status = computed<GameStatus>(() => this.game()?.status ?? 'draft');
  protected readonly isDraft = computed(() => this.status() === 'draft');
  /** Дату старту можна лишити порожньою лише в чернетці; час обов'язковий, коли дату задано. */
  protected readonly startDateRequired = computed(() => !this.isDraft());
  protected readonly startTimeRequired = computed(
    () => !this.isDraft() || this.value().startDate !== null,
  );
  protected readonly locked = computed(() => LOCKED_STATUSES.has(this.status()));
  protected readonly closed = computed(() => CLOSED_STATUSES.has(this.status()));
  /** Гра йде: правило розкладу тут не редагується (див. `RULE_CONTROLS`). */
  protected readonly scheduleLocked = computed(() => SCHEDULE_LOCKED.has(this.status()));
  protected readonly ready = computed(
    () => this.catalog() !== null && (this.id() === undefined || this.game() !== null),
  );
  protected readonly timezone = computed(
    () => this.game()?.timezone ?? this.auth.me()?.timezone ?? DEFAULT_TZ,
  );
  /** «Сьогодні» в поясі гри — мінімум datepicker-а (справжня перевірка — GAME_IN_PAST). */
  protected readonly minDate = computed(() => fromIsoDate(localDate(new Date(), this.timezone())));
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
    /** Вікно початку «з … до …», хв; `null` — точний час. */
    startWindowMinutes: new FormControl<number | null>(null),
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
    safetyTools: new FormControl<SafetyTool[]>([], { nonNullable: true }),
    lines: new FormControl<SafetyList>(emptySafetyList(), { nonNullable: true }),
    veils: new FormControl<SafetyList>(emptySafetyList(), { nonNullable: true }),
    channelLinks: new FormArray<
      FormGroup<{ label: FormControl<string>; url: FormControl<string> }>
    >([]),
    applicationQuestions: new FormArray<FormControl<string>>([]),
    showWhenFull: new FormControl(false, { nonNullable: true }),
  });
  protected readonly c = this.form.controls;
  protected readonly newCustomWarning = new FormControl('', { nonNullable: true });
  /** «Максимум гравців»: помилку min > max видно, щойно змінили будь-яке з двох полів. */
  protected readonly playersErrorState: ErrorStateMatcher = {
    isErrorState: (control, form) =>
      !!control?.invalid && (control.touched || this.c.minPlayers.touched || !!form?.submitted),
  };
  /** Знімок значень для умовних блоків шаблону. */
  protected readonly value = signal(this.form.getRawValue());

  /** Початкові значення — для скидання форми при зміні `id`. */
  private readonly defaults = this.form.getRawValue();
  private prefilling = false;
  private marked: AbstractControl[] = [];
  private loadSeq = 0;
  /** Автозбереження ввімкнено (гру завантажено, вона не завершена/скасована). */
  private draftReady = false;
  /** Знімок значень, із якими порівнюємо (сервер/типові). */
  private baseline = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

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

    merge(this.form.valueChanges, this.newCustomWarning.valueChanges)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.onValuesChanged());
    // Не втрачаємо останні зміни при закритті вкладки чи переході деінде.
    const win = inject(DOCUMENT).defaultView;
    if (win) {
      fromEvent(win, 'pagehide')
        .pipe(takeUntilDestroyed())
        .subscribe(() => this.flushDraft());
    }
    inject(DestroyRef).onDestroy(() => this.flushDraft());

    // Маршрут може перевикористати компонент (`/games/1/edit` → `/games/2/edit`).
    effect(() => {
      const raw = this.id();
      untracked(() => this.open(raw));
    });
  }

  /** Скидає форму й завантажує гру за параметром маршруту (немає — нова гра). */
  private open(raw: string | undefined): void {
    this.flushDraft();
    this.draftReady = false;
    this.restored.set(false);
    this.staleDropped.set(false);
    this.hasChanges.set(false);
    const seq = ++this.loadSeq;
    this.game.set(null);
    this.gameId.set(null);
    this.loadError.set(null);
    this.formError.set(null);
    this.blockedBy.set(null);
    this.unblocked.set(false);
    this.setApiErrors({});
    this.submitted.set(false);
    this.prefilling = true;
    this.form.enable({ emitEvent: false });
    this.c.customWarnings.clear({ emitEvent: false });
    this.c.channelLinks.clear({ emitEvent: false });
    this.c.applicationQuestions.clear({ emitEvent: false });
    this.form.reset(this.defaults);
    this.newCustomWarning.setValue('', { emitEvent: false });
    this.prefilling = false;
    if (raw === undefined) {
      this.startDraft();
      return;
    }
    if (!/^\d{1,15}$/.test(raw)) {
      this.loadError.set('errors.NOT_FOUND');
      return;
    }
    void this.loadGame(Number(raw), seq);
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

  /** Зміна в секції «Безпека гри» (кілька полів разом — напр. тему перенесено з меж у завіси). */
  protected onSafetyChange(change: SafetyChange): void {
    for (const name of ['safetyTools', 'lines', 'veils'] as const) {
      const value = change[name];
      if (value === undefined) continue;
      const control = this.c[name] as FormControl<typeof value>;
      control.setValue(value);
      control.markAsDirty();
      control.markAsTouched();
    }
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

  /** Очищає дату й час старту (лише чернетка: «дату ще не визначено»). */
  protected clearStart(): void {
    this.c.startDate.setValue(null);
    this.c.startTime.setValue('');
    this.c.startDate.markAsDirty();
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
    // Чернетку без дати можна зберегти, але не опублікувати.
    if (publish && input.startsAt === null) {
      this.setApiErrors({ startDate: 'errors.GAME_START_REQUIRED' });
      this.focusFirstInvalid();
      return;
    }
    this.busy.set(true);
    this.formError.set(null);
    this.sanction.set(null);
    this.blockedBy.set(null);
    this.unblocked.set(false);
    this.setApiErrors({});
    try {
      const id = this.gameId();
      let dto: GameDto;
      if (id === null) {
        dto = await firstValueFrom(this.api.create(input));
        this.discardStored();
        // Чернетку вже створено: повторне збереження (напр. після помилки публікації) — PATCH.
        this.gameId.set(dto.id);
        this.game.set(dto);
        this.location.replaceState(`/games/${dto.id}/edit`);
      } else {
        dto = await firstValueFrom(this.api.update(id, this.patchFor(input)));
        this.game.set(dto);
      }
      // Значення вже на сервері — локальна копія більше не потрібна.
      this.discardStored();
      this.baseline = this.snapshotValues();
      if (publish) await firstValueFrom(this.api.transition(dto.id, 'publish'));
      await this.router.navigateByUrl('/my-games');
    } catch (err) {
      this.showApiError(err);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Після публікації заблоковані поля не надсилаються; для гри, що йде, — і правило розкладу.
   * Незмінене посилання на обкладинку теж не надсилається: сервер перевіряє (і обмежує за
   * частотою) лише нові посилання.
   */
  private patchFor(input: GameInput): GamePatch {
    const patch: Record<string, unknown> = { ...input };
    if (input.coverUrl !== null && input.coverUrl === this.game()?.coverUrl) {
      delete patch['coverUrl'];
    }
    if (this.locked()) {
      for (const field of GAME_LOCKED_AFTER_PUBLISH) delete patch[field];
      if (this.scheduleLocked()) for (const field of RULE_FIELDS) delete patch[field];
    }
    return patch as GamePatch;
  }

  private showApiError(err: unknown): void {
    const apiError = toApiError(err);
    const { code, details } = apiError;
    if (code === 'UNAUTHENTICATED') return;
    const sanction = sanctionActiveDetails(apiError);
    if (sanction) {
      this.sanction.set(sanction);
      this.focusSanction();
      return;
    }
    if (code === 'GAME_CREATION_BLOCKED') {
      const ids = (details as { deadGameIds?: unknown } | undefined)?.deadGameIds;
      this.blockedBy.set(
        Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : [],
      );
      this.focusNotice('.dead-games-notice');
      return;
    }
    const fieldErrors: Record<string, string> = {};
    const d = (details ?? {}) as { field?: unknown; reason?: unknown };
    if (code === 'GAME_FIELD_LOCKED' && typeof d.field === 'string') {
      fieldErrors[this.controlName(d.field)] = 'errors.GAME_FIELD_LOCKED';
    } else if (code === 'AGE_RESTRICTED_CREATE') {
      fieldErrors['ageRating'] = 'errors.AGE_RESTRICTED_CREATE';
    } else if (code === 'GAME_IN_PAST' && !this.isDraft() && this.startUnchanged()) {
      // Опублікована гра, дату не змінювали (напр. лише вікно чи тривалість): правило з минулою
      // першою сесією змінити не можна — пояснюємо, що треба обрати нову дату.
      fieldErrors['startDate'] = 'games.form.errors.ruleInPast';
    } else if (code === 'GAME_IN_PAST' || code === 'GAME_START_REQUIRED') {
      fieldErrors['startDate'] = `errors.${code}`;
    } else if (code === 'IMAGE_URL_INVALID') {
      // Посилання на обкладинку не пройшло перевірку сервера: причина — біля поля.
      const reason = (IMAGE_URL_INVALID_REASONS as readonly unknown[]).includes(d.reason)
        ? (d.reason as string)
        : 'unreachable';
      fieldErrors['coverUrl'] = `errors.imageUrl.${reason}`;
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
      this.setApiErrors(fieldErrors);
      this.focusFirstInvalid();
    } else {
      this.formError.set(`errors.${code}`);
    }
  }

  /** Дата й час старту ті самі, що на сервері. */
  private startUnchanged(): boolean {
    const v = this.form.getRawValue();
    const saved = this.game()?.startsAt ?? null;
    return saved !== null && this.startsAt(v.startDate, v.startTime) === saved;
  }

  private setApiErrors(errors: Record<string, string>): void {
    this.apiErrorValues = {};
    for (const name of Object.keys(errors)) this.apiErrorValues[name] = this.snapshot(name);
    this.apiErrors.set(errors);
  }

  private snapshot(name: string): string {
    return JSON.stringify(this.form.get(name)?.getRawValue() ?? null);
  }

  /** Прибирає помилки API з контролів, значення яких змінилося. */
  private clearEditedApiErrors(): void {
    const current = this.apiErrors();
    const names = Object.keys(current);
    if (names.length === 0) return;
    const kept = names.filter((n) => this.snapshot(n) === this.apiErrorValues[n]);
    if (kept.length === names.length) return;
    this.apiErrors.set(Object.fromEntries(kept.map((n) => [n, current[n]!])));
  }

  // ---------- валідація ----------

  /**
   * Перевіряє форму схемою з @nri/shared і розставляє помилки на контроли.
   * Повертає нормалізовані дані або `null`.
   */
  private validate(): GameInput | null {
    this.value.set(this.form.getRawValue());
    this.clearEditedApiErrors();
    for (const control of this.marked) {
      control.updateValueAndValidity({ onlySelf: true, emitEvent: false });
    }
    this.marked = [];
    const result = gameInputSchema(this.timezone()).safeParse(this.payload());
    const sections = new Set<Section>();
    if (!result.success) {
      for (const issue of result.error.issues) {
        const name = this.markIssue(issue);
        if (name && CONTROL_SECTION[name]) sections.add(CONTROL_SECTION[name]);
      }
    }
    // min ≤ max — локально, біля «Максимум»: схема перевіряє це лише коли решта полів валідна.
    const { minPlayers: min, maxPlayers: max } = this.c;
    if (typeof min.value === 'number' && typeof max.value === 'number' && min.value > max.value) {
      if (this.mark(max, 'games.form.errors.players')) sections.add('players');
    }
    if (this.c.startDate.errors !== null) sections.add('schedule');
    this.invalidSections.set(SECTIONS.filter((x) => sections.has(x)));
    this.tick.update((n) => n + 1);
    const ok = result.success && sections.size === 0;
    this.valid.set(ok);
    return ok ? result.data : null;
  }

  /** Ставить помилку схеми на контрол; повертає назву кореневого контролу. */
  private markIssue(issue: ZodLikeIssue): string | null {
    const path = issue.path ?? [];
    const field = path[0];
    if (typeof field !== 'string') return null;
    // min > max показуємо біля «Максимум».
    const name =
      field === 'minPlayers' && issue.code === 'custom' ? 'maxPlayers' : this.controlName(field);
    const control = SAFETY_CONTROLS.has(name)
      ? this.form.get(name)
      : this.form.get([name, ...(path.slice(1) as (string | number)[])]);
    if (!control || control.disabled) return null;
    this.mark(control, this.issueKey(field, issue));
    return name;
  }

  /** Перша помилка на контролі виграє; `false` — контрол вимкнено. */
  private mark(control: AbstractControl, key: string): boolean {
    if (control.disabled) return false;
    if (control.errors?.['schema']) return true;
    control.setErrors({ ...control.errors, schema: key }, { emitEvent: false });
    this.marked.push(control);
    return true;
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
      startWindowMinutes: v.startWindowMinutes,
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
      // PATCH замінює списки цілком — завжди надсилаємо обидва вкладені масиви.
      safetyTools: v.safetyTools,
      lines: v.lines,
      veils: v.veils,
      showWhenFull: v.showWhenFull,
    };
  }

  /**
   * Дата (календарна) + `HH:mm` у поясі гри → UTC ISO; неповні дані — `undefined`. Порожня
   * дата в чернетці — `null` («дату ще не визначено»), час тоді ігнорується.
   */
  private startsAt(date: Date | null, time: string): string | null | undefined {
    if (date === null && this.isDraft()) return null;
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

  private async loadGame(id: number, seq: number): Promise<void> {
    this.loadingGame.set(true);
    try {
      const view = await firstValueFrom(this.api.get(id));
      if (seq !== this.loadSeq) return; // уже відкрито іншу гру
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
      if (seq !== this.loadSeq) return;
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.loadError.set(`errors.${code}`);
    } finally {
      if (seq === this.loadSeq) this.loadingGame.set(false);
    }
  }

  private prefill(g: GameDto): void {
    this.prefilling = true;
    const start = g.startsAt === null ? null : toZoned(new Date(g.startsAt), g.timezone);
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
      startDate: start ? new Date(start.year, start.month - 1, start.day) : null,
      startTime: start ? `${pad(start.hour)}:${pad(start.minute)}` : '',
      startWindowMinutes: g.startWindowMinutes,
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
      safetyTools: [...g.safetyTools],
      lines: { warningIds: [...g.lines.warningIds], custom: [...g.lines.custom] },
      veils: { warningIds: [...g.veils.warningIds], custom: [...g.veils.custom] },
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
      this.discardStored();
    } else {
      if (LOCKED_STATUSES.has(g.status)) {
        this.c.system.disable();
        this.c.systemOther.disable();
        this.c.kind.disable();
      }
      if (SCHEDULE_LOCKED.has(g.status)) for (const name of RULE_CONTROLS) this.c[name].disable();
      this.startDraft();
    }
    this.validate();
  }

  // ---------- автозбереження ----------

  /** Ключ `localStorage` поточної гри; без користувача — `null`. */
  private draftKey(): string | null {
    const me = this.auth.me();
    return me ? gameDraftKey(me.id, this.gameId()) : null;
  }

  private storedValues(): StoredGameValues {
    const v = this.form.getRawValue();
    return {
      ...v,
      startDate: dateToStored(v.startDate),
      newCustomWarning: this.newCustomWarning.value,
    };
  }

  private snapshotValues(): string {
    return JSON.stringify(this.storedValues());
  }

  /** Форма готова: запам'ятовуємо «чисті» значення й відновлюємо незбережені. */
  private startDraft(): void {
    this.baseline = this.snapshotValues();
    this.draftReady = true;
    const key = this.draftKey();
    const stored = key ? readGameDraft(key) : null;
    if (!key || !stored) return;
    const serverUpdatedAt = this.game()?.updatedAt ?? null;
    // Гру змінено після того, як зроблено копію (інший пристрій/вкладка) — копію відкидаємо.
    const stale =
      serverUpdatedAt !== null &&
      !(stored.updatedAt !== null && Date.parse(serverUpdatedAt) <= Date.parse(stored.updatedAt));
    if (stale) {
      removeGameDraft(key);
      this.staleDropped.set(true);
      return;
    }
    this.prefilling = true;
    this.applyStored(stored.values);
    this.prefilling = false;
    this.validate();
    const changed = this.snapshotValues() !== this.baseline;
    this.hasChanges.set(changed);
    this.restored.set(changed);
    if (!changed && key) removeGameDraft(key);
  }

  /** Підставляє збережені значення; некоректні й заблоковані поля пропускаються. */
  private applyStored(values: StoredGameValues): void {
    const c = this.c;
    const set = <T>(control: FormControl<T>, value: unknown, ok: (x: unknown) => boolean) => {
      if (value !== undefined && !control.disabled && ok(value)) control.setValue(value as T);
    };
    const nullableNumber = (x: unknown) => x === null || isNumber(x);
    for (const name of [
      'title',
      'description',
      'systemOther',
      'format',
      'city',
      'address',
      'platform',
      'kind',
      'startTime',
      'recurrence',
      'ageRating',
      'experience',
      'language',
      'requirements',
      'coverUrl',
    ] as const) {
      set(c[name] as FormControl<string>, values[name], isString);
    }
    set(c.system, values['system'], (x) => x === 'other' || nullableNumber(x));
    set(c.genreId, values['genreId'], nullableNumber);
    if (isNumber(values['genreId'])) c.genreId.markAsDirty();
    for (const name of ['minPlayers', 'maxPlayers', 'priceUah'] as const) {
      set(c[name], values[name], nullableNumber);
    }
    set(c.durationMinutes, values['durationMinutes'], isNumber);
    set(c.startWindowMinutes, values['startWindowMinutes'], nullableNumber);
    set(c.weekdays, values['weekdays'], isNumberArray);
    set(c.contentWarningIds, values['contentWarningIds'], isNumberArray);
    set(c.showWhenFull, values['showWhenFull'], (x) => typeof x === 'boolean');
    set(c.safetyTools, values['safetyTools'], isSafetyTools);
    set(c.lines, values['lines'], isSafetyList);
    set(c.veils, values['veils'], isSafetyList);
    const date = dateFromStored(values['startDate']);
    if (date !== undefined && !c.startDate.disabled) c.startDate.setValue(date);
    set(this.newCustomWarning, values['newCustomWarning'], isString);
    const strings = (list: FormArray<FormControl<string>>, value: unknown) => {
      if (!isStringArray(value)) return;
      list.clear();
      for (const x of value) list.push(new FormControl(x, { nonNullable: true }));
    };
    strings(c.customWarnings, values['customWarnings']);
    strings(c.applicationQuestions, values['applicationQuestions']);
    const links = values['channelLinks'];
    if (
      Array.isArray(links) &&
      links.every((l: unknown) => {
        const link = l as Partial<ChannelLink> | null;
        return isString(link?.label) && isString(link?.url);
      })
    ) {
      c.channelLinks.clear();
      for (const link of links as ChannelLink[]) c.channelLinks.push(this.channelGroup(link));
    }
  }

  private onValuesChanged(): void {
    if (!this.draftReady || this.prefilling || this.closed()) return;
    this.hasChanges.set(this.snapshotValues() !== this.baseline);
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushDraft(true), AUTOSAVE_DEBOUNCE_MS);
  }

  /** Записує відкладене збереження зараз (`force` — з таймера). */
  private flushDraft(force = false): void {
    if (this.saveTimer === null && !force) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const key = this.draftKey();
    if (!key || !this.draftReady || this.closed()) return;
    const snapshot = this.storedValues();
    if (JSON.stringify(snapshot) === this.baseline) {
      removeGameDraft(key);
      this.restored.set(false);
    } else {
      writeGameDraft(key, snapshot, this.game()?.updatedAt ?? null);
    }
  }

  /** Прибирає локальну копію поточної гри й відкладене збереження. */
  private discardStored(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const key = this.draftKey();
    if (key) removeGameDraft(key);
    this.restored.set(false);
    this.hasChanges.set(false);
  }

  /** «Відкинути зміни»: після підтвердження — значення з сервера чи типові для нової гри. */
  protected async discardChanges(): Promise<void> {
    if (this.busy()) return;
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'games.form.discardConfirm.title',
        text: 'games.form.discardConfirm.text',
        confirm: 'games.form.discardConfirm.confirm',
        danger: true,
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.discardStored();
    const id = this.gameId();
    this.open(id === null ? undefined : String(id));
  }

  private channelGroup(link: ChannelLink) {
    return new FormGroup({
      label: new FormControl(link.label, { nonNullable: true }),
      url: new FormControl(link.url, { nonNullable: true }),
    });
  }

  /** «Мертвих» ігор більше немає — створення знову доступне. */
  protected onUnblocked(): void {
    this.blockedBy.set(null);
    this.unblocked.set(true);
    // Кнопки останньої гри зникли разом із поясненням — фокус на підказку.
    this.focusNotice('.unblocked-notice');
  }

  /** Пояснення санкції — у live-регіоні; фокус на ньому, щоб його було видно й почуто. */
  private focusSanction(): void {
    this.focusNotice('.sanction-notice');
  }

  private focusNotice(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
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
