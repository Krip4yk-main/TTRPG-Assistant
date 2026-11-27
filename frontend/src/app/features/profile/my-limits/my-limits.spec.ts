import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { MyLimits, parseLimits } from './my-limits';

const me = (myLimits: string[]) =>
  ({ id: 1, status: 'active', timezone: 'Europe/Kyiv', myLimits }) as unknown as MeDto;

describe('MyLimits', () => {
  let fixture: ComponentFixture<MyLimits>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(limits: string[]) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    });
    TestBed.inject(AuthStore).setMe(me(limits));
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MyLimits);
    await settle();
  }

  afterEach(() => http.verify());

  it('is collapsed when empty', async () => {
    await create([]);
    expect(el().querySelector('details')!.open).toBe(false);
  });

  it('is open and prefilled when it has content', async () => {
    await create(['Без павуків']);
    expect(el().querySelector('details')!.open).toBe(true);
    expect(el().querySelector('textarea')!.value).toBe('Без павуків');
  });

  it('saves trimmed unique lines and updates the current user', async () => {
    await create([]);
    const ta = el().querySelector('textarea')!;
    ta.value = ' Без павуків \n\nБез павуків\nБез крові';
    ta.dispatchEvent(new Event('input'));
    el().querySelector<HTMLButtonElement>('.actions button')!.click();
    const req = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/me/limits');
    expect(req.request.body).toEqual({ limits: ['Без павуків', 'Без крові'] });
    req.flush(me(['Без павуків', 'Без крові']));
    await settle();
    expect(TestBed.inject(AuthStore).me()!.myLimits).toEqual(['Без павуків', 'Без крові']);
  });

  it('rejects more than 10 lines locally without a request', async () => {
    await create([]);
    const ta = el().querySelector('textarea')!;
    ta.value = Array.from({ length: 11 }, (_, i) => `межа ${i}`).join('\n');
    ta.dispatchEvent(new Event('input'));
    el().querySelector<HTMLButtonElement>('.actions button')!.click();
    await settle();
    expect(el().querySelector('[role=alert]')).toBeTruthy();
  });

  it('parseLimits trims, drops empties and duplicates', () => {
    expect(parseLimits(' a \n\nb\na')).toEqual(['a', 'b']);
  });
});
