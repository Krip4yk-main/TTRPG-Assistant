import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto, TesterReportDto } from '@nri/shared';
import uk from '../../../../assets/i18n/uk.json';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { AdminTesterReports } from './tester-reports';

const me: MeDto = {
  id: 1,
  publicId: 'admin00001',
  nickname: 'Адмін',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'admin',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  defaultView: 'player',
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
};

const report = (id: number, patch: Partial<TesterReportDto> = {}): TesterReportDto => ({
  id,
  kind: 'bug',
  text: `Звіт ${id}`,
  status: 'new',
  context: {
    url: 'https://dev.nri.example/games/5',
    theme: 'quest-board',
    viewportWidth: 1280,
    viewportHeight: 720,
    userAgent: 'Mozilla/5.0 Test',
  },
  reporter: null,
  processedBy: null,
  processedAt: null,
  createdAt: '2026-11-27T10:00:00.000Z',
  ...patch,
});

describe('AdminTesterReports', () => {
  let fixture: ComponentFixture<AdminTesterReports>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminTesterReports],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({ fallbackLang: 'uk' }),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            connected$: new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('uk', uk);
    translate.use('uk');
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminTesterReports);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  it('loads new reports first; shows kind, text, context and guest author', async () => {
    const req = http.expectOne((r) => r.url === '/api/admin/tester-reports');
    expect(req.request.params.get('status')).toBe('new');
    req.flush({
      items: [
        report(2, {
          kind: 'idea',
          reporter: { publicId: 'tester0001', nickname: 'Тестер', role: 'user' },
        }),
        report(1),
      ],
      nextCursor: null,
    });
    await settle();
    const cards = [...el.querySelectorAll('[data-report]')];
    expect(cards.map((c) => c.getAttribute('data-report'))).toEqual(['2', '1']);
    expect(cards[0]!.textContent).toContain('Ідея');
    expect(cards[0]!.textContent).toContain('Тестер');
    expect(cards[1]!.textContent).toContain('Баг');
    expect(cards[1]!.textContent).toContain('Гість');
    expect(cards[1]!.textContent).toContain('https://dev.nri.example/games/5');
    expect(cards[1]!.textContent).toContain('1280×720');
    expect(cards[1]!.textContent).toContain('Mozilla/5.0 Test');
  });

  it('mark processed: request, card leaves the «new» list', async () => {
    http
      .expectOne((r) => r.url === '/api/admin/tester-reports')
      .flush({ items: [report(1)], nextCursor: null });
    await settle();
    el.querySelector<HTMLButtonElement>('[data-report="1"] .mark-processed')!.click();
    await settle();
    const req = http.expectOne('/api/admin/tester-reports/1/processed');
    expect(req.request.method).toBe('POST');
    req.flush(
      report(1, {
        status: 'processed',
        processedBy: { publicId: 'admin00001', nickname: 'Адмін', role: 'admin' },
        processedAt: '2026-11-27T11:00:00.000Z',
      }),
    );
    await settle();
    expect(el.querySelector('[data-report="1"]')).toBeNull();
  });

  it('filter «processed» reloads; processed card shows who, no button', async () => {
    http
      .expectOne((r) => r.url === '/api/admin/tester-reports')
      .flush({ items: [], nextCursor: null });
    await settle();
    const toggles = [...el.querySelectorAll<HTMLButtonElement>('mat-button-toggle button')];
    toggles.find((b) => b.textContent!.includes('Опрацьовані'))!.click();
    await settle();
    const req = http.expectOne((r) => r.url === '/api/admin/tester-reports');
    expect(req.request.params.get('status')).toBe('processed');
    req.flush({
      items: [
        report(3, {
          status: 'processed',
          processedBy: { publicId: 'admin00001', nickname: 'Адмін', role: 'admin' },
          processedAt: '2026-11-27T11:00:00.000Z',
        }),
      ],
      nextCursor: null,
    });
    await settle();
    const card = el.querySelector('[data-report="3"]')!;
    expect(card.textContent).toContain('Опрацював');
    expect(card.textContent).toContain('Адмін');
    expect(card.querySelector('.mark-processed')).toBeNull();
  });
});
