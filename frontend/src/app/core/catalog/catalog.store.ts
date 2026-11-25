import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { CatalogDto } from '@nri/shared';

/** Каталог систем, жанрів і попереджень. Завантажується один раз за сесію застосунку. */
@Injectable({ providedIn: 'root' })
export class CatalogStore {
  private readonly http = inject(HttpClient);
  private readonly state = signal<CatalogDto | null>(null);
  private loading: Promise<void> | null = null;
  /** Каталог змінено в адмінці: наступний `load()` перечитає його (поточні дані лишаються). */
  private stale = false;
  /** Зростає з кожним `invalidate()`: відповідь запиту, почату раніше, не знімає `stale`. */
  private generation = 0;
  private loadingGeneration = -1;

  readonly catalog = this.state.asReadonly();

  load(): Promise<void> {
    if (this.state() && !this.stale) return Promise.resolve();
    if (this.loading && this.loadingGeneration === this.generation) return this.loading;
    const generation = this.generation;
    const request: Promise<void> = firstValueFrom(this.http.get<CatalogDto>('/api/catalog'))
      .then((dto) => {
        if (generation === this.generation) {
          this.state.set(dto);
          this.stale = false;
        } else if (!this.state()) {
          // Дані до зміни — краще, ніж нічого; `stale` лишається, наступний load() перечитає.
          this.state.set(dto);
        }
      })
      .finally(() => {
        if (this.loading === request) this.loading = null;
      });
    this.loading = request;
    this.loadingGeneration = generation;
    return request;
  }

  /** Каталог змінено (адмінка): наступний `load()` візьме свіжі дані. */
  invalidate(): void {
    this.stale = true;
    this.generation++;
  }

  systemName(id: number): string | null {
    return this.state()?.systems.find((s) => s.id === id)?.name ?? null;
  }

  /** Ключ перекладу жанру (`genres.<slug>`). */
  genreKey(id: number): string | null {
    const g = this.state()?.genres.find((x) => x.id === id);
    return g ? `genres.${g.slug}` : null;
  }
}
