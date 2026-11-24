import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AvailabilityEditor } from '../availability-editor/availability-editor';

/** «Мій календар» (`/calendar`): редактор вільного часу в режимі збереження. */
@Component({
  selector: 'nri-calendar-page',
  imports: [RouterLink, TranslatePipe, AvailabilityEditor],
  templateUrl: './calendar-page.html',
  styleUrl: './calendar-page.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarPage {}
