import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationCancel, NavigationEnd, NavigationError, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Момент `gameOpened`: чи сторінку гри відкрито саме з картки (пошук, профіль). Картка перед
 * переходом позначає гру (`fromCard`), сторінка гри в конструкторі забирає позначку (`take`) —
 * він виконується під час активації маршруту, ще до `NavigationEnd`. Будь-яке завершення
 * переходу (успіх, скасування guard-ом, збій) позначку знімає, тож вона не переживає свій
 * перехід. Позначка лише в пам'яті: пряма адреса, оновлення сторінки й «назад» анімації не
 * мають.
 */
@Injectable({ providedIn: 'root' })
export class GameOpenedMoment {
  private marked: number | null = null;

  constructor() {
    inject(Router)
      .events.pipe(
        filter(
          (e) =>
            e instanceof NavigationEnd ||
            e instanceof NavigationCancel ||
            e instanceof NavigationError,
        ),
        takeUntilDestroyed(),
      )
      .subscribe(() => (this.marked = null));
  }

  /** Картка зараз відкриє сторінку гри `gameId` (виклик — саме перед переходом). */
  fromCard(gameId: number): void {
    this.marked = gameId;
  }

  /** Гра, відкрита з картки в поточному переході (і зняти позначку), або `null`. */
  take(): number | null {
    const id = this.marked;
    this.marked = null;
    return id;
  }
}
