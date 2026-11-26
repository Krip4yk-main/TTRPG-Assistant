import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { CoverAttachment } from '../../../shared/attachment/cover-attachment';

/**
 * Обкладинка гри в дизайнах сцени — знімок, що визирає з-за верхнього правого кута панелі
 * картки (пошук і «Мої ігри»). Поведінка — спільна `CoverAttachment` (наведення / клік /
 * Enter / Space виносять наперед, Esc і дотик деінде повертають, зламана картинка ховає
 * вкладення, клік по ньому гру не відкриває). Тут — лише каркас (місце в шарах, приховування);
 * вигляд у спокої й наперед (`.front`, `:hover:not(.dismissed)`) і місце задає бандл дизайну
 * (`nri-sc-attachment` у `themes/<id>/<id>.less`).
 */
@Component({
  selector: 'nri-sc-attachment',
  imports: [TranslatePipe],
  templateUrl: './scene-attachment.html',
  styleUrl: './scene-attachment.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [{ directive: CoverAttachment, inputs: ['src', 'title'] }],
})
export class SceneAttachment {
  protected readonly att = inject(CoverAttachment);
}
