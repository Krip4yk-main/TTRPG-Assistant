import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AvailabilityEditor } from '../availability-editor/availability-editor';
import { CalendarFeed } from '../calendar-feed/calendar-feed';
import { CalendarImport } from '../calendar-import/calendar-import';

/** «Мій календар» (`/calendar`): редактор вільного часу в режимі збереження й імпорт зайнятості з iCal. */
@Component({
  selector: 'nri-calendar-page',
  imports: [RouterLink, TranslatePipe, AvailabilityEditor, CalendarImport, CalendarFeed],
  templateUrl: './calendar-page.html',
  styleUrl: './calendar-page.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarPage {}
