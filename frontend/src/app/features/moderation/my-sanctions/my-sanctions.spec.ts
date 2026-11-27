import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { NOTIFICATION_NEW_EVENT, type MeDto, type MySanctionDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { SanctionsBanner } from '../sanctions-banner/sanctions-banner';
import { MySanctions } from './my-sanctions';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Frodo',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
} satisfies MeDto;

const limit: MySanctionDto = {
  id: 4,
  type: 'application_limit',
  reason: 'Спам заявками',
  startsAt: '2026-11-20T10:00:00.000Z',
  endsAt: '2026-11-27T10:00:00.000Z',
  appealStatus: null,
};
const noPaid: MySanctionDto = {
  id: 5,
  type: 'no_paid_create',
  reason: 'Скарги гравців',
  startsAt: '2026-11-20T10:00:00.000Z',
  endsAt: null,
  appealStatus: 'rejected',
};

let notifications: Subject<unknown>;

async function setup() {
  notifications = new Subject();
  await TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: '**', children: [] }]),
      provideTranslateService(),
      {
        provide: SocketService,
        useValue: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          on: (ev: string) => (ev === NOTIFICATION_NEW_EVENT ? notifications : new Subject()),
          connected$: new Subject(),
          sessionLost$: new Subject(),
        },
      },
    ],
  }).compileComponents();
  TestBed.inject(AuthStore).setMe(me);
  return TestBed.inject(HttpTestingController);
}

describe('MySanctions', () => {
  let fixture: ComponentFixture<MySanctions>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    http = await setup();
    fixture = TestBed.createComponent(MySanctions);
    el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle();
  });

  afterEach(() => {
    http.verify();
    el.remove();
  });

  const list = (items: MySanctionDto[]) => {
    // Стор запитує при вході й сторінка — при відкритті: запити зливаються в один.
    http.expectOne('/api/me/sanctions').flush(items);
  };
  const card = (id: number) => el.querySelector<HTMLElement>(`li[data-sanction="${id}"]`)!;
  const type = async (value: string) => {
    const area = el.querySelector<HTMLTextAreaElement>('textarea.message')!;
    area.value = value;
    area.dispatchEvent(new Event('input'));
    await settle();
  };

  it('lists active sanctions with type, reason, end («forever» when none) and appeal state', async () => {
    list([limit, noPaid]);
    await settle();
    const a = card(4);
    expect(a.querySelector('h2')!.textContent).toContain(
      'moderation.sanctionTypes.application_limit',
    );
    expect(a.querySelector('.reason')!.textContent).toContain('Спам заявками');
    expect(a.querySelector('.ends')!.textContent).toContain('moderation.until');
    expect(a.querySelector('button.appeal')).not.toBeNull();
    const b = card(5);
    expect(b.querySelector('.ends')!.textContent).toContain('moderation.forever');
    expect(b.querySelector('.appeal-status')!.textContent).toContain(
      'moderation.appealStatus.rejected',
    );
    // Апеляція одна на санкцію: після рішення оскаржити знову не можна.
    expect(b.querySelector('button.appeal')).toBeNull();
  });

  it('empty list says there are no restrictions', async () => {
    list([]);
    await settle();
    expect(el.textContent).toContain('moderation.my.empty');
  });

  it('an appeal requires a message', async () => {
    list([limit]);
    await settle();
    card(4).querySelector<HTMLButtonElement>('button.appeal')!.click();
    await settle();
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    http.expectNone('/api/me/sanctions/4/appeal');
    expect(el.textContent).toContain('moderation.my.appealRequired');
  });

  it('sends one appeal and shows it as pending (no second appeal button)', async () => {
    list([limit]);
    await settle();
    card(4).querySelector<HTMLButtonElement>('button.appeal')!.click();
    await settle();
    expect(document.activeElement).toBe(el.querySelector('textarea.message'));
    await type('  Це непорозуміння  ');
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    const req = http.expectOne('/api/me/sanctions/4/appeal');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ message: 'Це непорозуміння' });
    req.flush({ ...limit, appealStatus: 'pending' }, { status: 201, statusText: 'Created' });
    await settle();
    expect(card(4).querySelector('.appeal-status')!.textContent).toContain(
      'moderation.appealStatus.pending',
    );
    expect(card(4).querySelector('button.appeal')).toBeNull();
    expect(el.querySelector('.notice-area')!.textContent).toContain('moderation.my.appealSent');
  });

  it('409 APPEAL_EXISTS (appealed in another tab) re-reads the list', async () => {
    list([limit]);
    await settle();
    card(4).querySelector<HTMLButtonElement>('button.appeal')!.click();
    await settle();
    await type('Ще раз');
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    http
      .expectOne('/api/me/sanctions/4/appeal')
      .flush({ error: { code: 'APPEAL_EXISTS' } }, { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne('/api/me/sanctions').flush([{ ...limit, appealStatus: 'pending' }]);
    await settle();
    expect(el.querySelector('.notice-area')!.textContent).toContain('moderation.my.appealExists');
    expect(el.querySelector('form')).toBeNull();
    expect(card(4).querySelector('.appeal-status')!.textContent).toContain(
      'moderation.appealStatus.pending',
    );
  });

  it('other errors stay in the form so the user can retry', async () => {
    list([limit]);
    await settle();
    card(4).querySelector<HTMLButtonElement>('button.appeal')!.click();
    await settle();
    await type('Текст');
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    http
      .expectOne('/api/me/sanctions/4/appeal')
      .flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'Error' });
    await settle();
    expect(el.querySelector('.send-error')!.textContent).toContain('errors.INTERNAL');
    expect(el.querySelector<HTMLTextAreaElement>('textarea.message')!.value).toBe('Текст');
  });
});

describe('SanctionsBanner', () => {
  let fixture: ComponentFixture<SanctionsBanner>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    http = await setup();
    fixture = TestBed.createComponent(SanctionsBanner);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => http.verify());

  it('hidden without active sanctions', async () => {
    http.expectOne('/api/me/sanctions').flush([]);
    await settle();
    expect(el.querySelector('.sanctions-banner')).toBeNull();
  });

  it('shown with active sanctions, linking to /my-sanctions; refreshed on a new notification', async () => {
    http.expectOne('/api/me/sanctions').flush([limit]);
    await settle();
    const banner = el.querySelector('.sanctions-banner')!;
    expect(banner.textContent).toContain('moderation.banner.text');
    expect(banner.querySelector('a')!.getAttribute('href')).toBe('/my-sanctions');

    // Санкцію знято — приходить сповіщення, банер зникає.
    notifications.next({ id: 1 });
    http.expectOne('/api/me/sanctions').flush([]);
    await settle();
    expect(el.querySelector('.sanctions-banner')).toBeNull();
  });
});
