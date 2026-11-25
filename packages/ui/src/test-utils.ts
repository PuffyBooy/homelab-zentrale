import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Static HTML of an element, without React's text separators. */
export function html(el: ReactElement | null): string {
  return el ? renderToStaticMarkup(el).replace(/<!-- -->/g, '') : '';
}

/** Count of `class="…"` attributes that contain the given class name. */
export function countClass(markup: string, name: string): number {
  const re = new RegExp(`class="[^"]*(?<![\\w-])${name}(?![\\w-])[^"]*"`, 'g');
  return markup.match(re)?.length ?? 0;
}
