import { z } from 'zod';
import { FACEBOOK_COMPOSER_SCOPE } from './facebook-ui.js';

export const FACEBOOK_BACKGROUND_OPTIONS = '[data-wb-background-open="1"]';
export const FACEBOOK_NO_BACKGROUND = '[data-wb-background-clear="1"]';
export const nativeSolidBackgrounds = [
  { id: 'red', label: 'Solid red, background, background 2', color: 'rgb(226, 1, 59)' },
  { id: 'purple', label: 'Solid purple, background, background 1', color: 'rgb(198, 0, 255)' },
  { id: 'black', label: 'Solid black, background, background 3', color: 'rgb(17, 17, 17)' },
] as const;
export const nativeBackgroundCSS = (label: string) => {
  const solid = nativeSolidBackgrounds.find((value) => value.label === label);
  return solid
    ? '[data-wb-background="' + solid.id + '"]'
    : '[role="button"][aria-label="' + label + '"]';
};
export const FacebookBackground = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.boolean(),
    visible: z.boolean(),
    draftEmpty: z.boolean(),
    phase: z.enum(['absent', 'plain', 'solid', 'unsupported', 'ambiguous']),
    openCSS: z.string().max(200).nullable(),
    clearCSS: z.string().max(200).nullable(),
    selectedCSS: z.string().max(200).nullable(),
    options: z
      .array(
        z.object({ id: z.enum(['red', 'purple', 'black']), css: z.string().max(200) }).strict(),
      )
      .max(3),
  })
  .strict();
export type BackgroundReading = z.infer<typeof FacebookBackground>;
export const facebookBackgroundScope = FACEBOOK_COMPOSER_SCOPE;
