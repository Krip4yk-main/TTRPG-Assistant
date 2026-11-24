import type { SessionLostReason } from '../../../core/realtime/socket.service';
import { Subject } from 'rxjs';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { CompleteProfile } from './complete-profile';
import { SocketService } from '../../../core/realtime/socket.service';
import { AuthStore } from '../../../core/auth/auth.store';

/** Дата `years` років тому відносно сьогодні (локальний час). */
function yearsAgo(years: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

describe('CompleteProfile', () => {
  let fixture: ComponentFixture<CompleteProfile>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const submitButton = () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CompleteProfile],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        // Без завантажувача перекладів pipe `translate` повертає сам ключ.
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            sessionLost$: new Subject<SessionLostReason>(),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CompleteProfile);
    http = TestBed.inject(HttpTestingController);
    el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  it('вік 13 років → «Зберегти» вимкнена й показано profile.errors.AGE_TOO_LOW', async () => {
    const form = fixture.componentInstance.form;
    form.controls.nickname.setValue('Frodo');
    form.controls.birthDate.setValue(yearsAgo(13));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(submitButton().disabled).toBe(true);
    expect(el.textContent).toContain('profile.errors.AGE_TOO_LOW');
  });

  it('відповідь 409 NICKNAME_TAKEN → показано profile.errors.NICKNAME_TAKEN', async () => {
    const form = fixture.componentInstance.form;
    form.controls.nickname.setValue('Gandalf');
    form.controls.birthDate.setValue(yearsAgo(30));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(submitButton().disabled).toBe(false);
    submitButton().click();

    const req = http.expectOne('/api/me/complete-profile');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.nickname).toBe('Gandalf');
    expect(req.request.body.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    req.flush({ error: { code: 'NICKNAME_TAKEN' } }, { status: 409, statusText: 'Conflict' });
    await fixture.whenStable();

    expect(el.textContent).toContain('profile.errors.NICKNAME_TAKEN');
    expect(el.textContent).not.toContain('profile.errors.AGE_TOO_LOW');
  });

  it('відповідь 422 AGE_TOO_LOW → стан очищено й перехід на /login?error=AGE_TOO_LOW', async () => {
    const auth = TestBed.inject(AuthStore);
    auth.setMe({
      id: 7,
      publicId: 'abcdefghjk',
      nickname: null,
      avatarUrl: null,
      birthDate: null,
      role: 'user',
      status: 'pending',
      timezone: 'Europe/Kyiv',
      locale: 'uk',
      identities: [{ provider: 'dev', displayName: 'kid' }],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const form = fixture.componentInstance.form;
    form.controls.nickname.setValue('Pippin');
    form.controls.birthDate.setValue(yearsAgo(20));
    fixture.detectChanges();
    await fixture.whenStable();
    submitButton().click();

    http
      .expectOne('/api/me/complete-profile')
      .flush({ error: { code: 'AGE_TOO_LOW' } }, { status: 422, statusText: 'Unprocessable' });
    await fixture.whenStable();

    expect(auth.me()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { error: 'AGE_TOO_LOW' } });
  });
});
