import uk from './uk.json' with { type: 'json' };

export type Translate = (key: string, vars?: Record<string, string>) => string;

/**
 * Перекладач за ключем `a.b.c`; `{name}` підставляється за один прохід (значення, що самі
 * містять `{…}`, повторно не розгортаються). Немає рядка — повертає ключ.
 */
export function makeT(dict: Record<string, unknown> = uk): Translate {
  return (key, vars = {}) => {
    const node = lookup(dict, key);
    if (node === undefined) return key;
    return node.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
  };
}

/** Рядок за ключем або `undefined` (для перевірки наявності шаблону). */
export function lookup(dict: Record<string, unknown>, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  return typeof node === 'string' ? node : undefined;
}
