import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { ModerationLogDto } from '@nri/shared';
import { SocketService } from '../../../core/realtime/socket.service';
import uk from '../../../../assets/i18n/uk.json';
import { AdminLog } from './log';

const entry = (id: number, action: string, targetType: string): ModerationLogDto =>
  ({
    id,
    actor: { publicId: 'admin00001', nickname: 'Адмін', role: 'admin' },
    action,
    targetType,
    targetId: 5,
    targetUser: null,
    reason: null,
    meta: null,
    createdAt: '2026-11-25T10:00:00.000Z',
  }) as unknown as ModerationLogDto;

describe('AdminLog', () => {
  it('translates plan 7 actions and target types; unknown ones stay raw', async () => {
    await TestBed.configureTestingModule({
      imports: [AdminLog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
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
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(AdminLog);
    fixture.detectChanges();
    await fixture.whenStable();
    http
      .expectOne((r) => r.url === '/api/admin/log')
      .flush({
        items: [
          entry(1, 'catalog.system_create', 'game_system'),
          entry(2, 'game.close', 'game'),
          entry(3, 'something.new', 'widget'),
          { ...entry(4, 'owner.bootstrap', 'user'), actor: null },
        ],
        nextCursor: null,
      });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-entry="3"]'),
      ).not.toBeNull();
    });
    const el = fixture.nativeElement as HTMLElement;
    const row = (id: number) => el.querySelector(`[data-entry="${id}"]`)!.textContent!;
    expect(row(1)).toContain('admin.log.actions.catalog_system_create');
    expect(row(2)).toContain('admin.log.actions.game_close');
    expect(row(3)).toContain('something.new');
    expect(row(4)).toContain('admin.log.actions.owner_bootstrap');
    http.verify();

    const log = uk.admin.log as unknown as {
      actions: Record<string, string>;
      targetTypes: Record<string, string>;
    };
    for (const a of [
      'owner_bootstrap',
      'game_close',
      'game_dismiss_dead',
      'game_dismiss_suspicious',
      'catalog_system_create',
      'catalog_system_update',
    ]) {
      expect(log.actions[a], a).toBeTruthy();
    }
    for (const t of ['user', 'game', 'game_system', 'complaint', 'appeal', 'rating']) {
      expect(log.targetTypes[t], t).toBeTruthy();
    }
  });
});
