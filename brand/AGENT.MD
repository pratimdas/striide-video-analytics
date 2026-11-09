# StriideAi Brand Kit — machine-readable spec

Audience: AI agents and developers building StriideAi surfaces (site pages, emails, decks,
social assets). Follow this file literally. Human-readable version: https://striideai.com/brand-kit

StriideAi shares the Striide / myStriide brand system (https://mystriide.com/brand-kit).
Where this file is silent, follow that one.

## 1. Identity

- Product name: **StriideAi** — capital S, double i, capital A, lowercase i, one word.
  Never "Striide AI" in product copy, "StriideAI", "Striideai" or "Stride AI".
- Endorsement: **by Striide**, part of the myStriide network. Always secondary to the wordmark.
- Description: "Multi-sport AI video analysis, starting with cricket." Development stage —
  never claim launch, accuracy figures, rankings or confirmed integrations.
- Voice: British English, plain, concrete, quietly confident. No hype, no exclamation marks,
  no emoji in product copy. Decisions stay with people; AI supports coaches.

## 2. Logo assets

| Asset | File | Use |
| --- | --- | --- |
| Wordmark (light bg) | `/brand-kit/striideai-wordmark.svg` · `.png` | Default lockup |
| Wordmark (dark bg) | `/brand-kit/striideai-wordmark-invert.svg` · `.png` | Navy / photo backgrounds |
| Symbol | `/brand-kit/striideai-symbol.svg` · `.png` | Avatars, app icon, favicon source |

Lettering is outlined to vector paths. Navy strokes plus a pitch-green lower stroke form the
symbol. Clear space equal to the cap height of the "S"; minimum wordmark width 96px. Never
stretch, rotate, recolour, outline, add shadows or place on a busy photo without a scrim.

## 3. Colour (tokens in src/styles.css — never hardcode hex in components)

| Token | Hex | Meaning |
| --- | --- | --- |
| `--paper` / `--background` | `#FBF8F2` | Warm paper canvas |
| `--ink` / `--foreground` | `#12172A` | Primary text |
| `--navy` / `--primary` | `#1E2540` | Structure, headers, dark sections |
| `--pitch` | `#2F7D54` | Primary CTAs, progress, focus |
| `--gold` | `#D9A441` | Badges, recommended / premium only |
| `--border` | `#E1DCD3` | Hairlines, inputs |

- Pitch green carries the main call to action on StriideAi.
- Gold is reserved for badges (e.g. "Recommended"). Never a CTA or body text on paper.
- No purple/indigo gradients or new hues without a token.

## 4. Typography

- Display / headings: **Fraunces** 600, tight tracking.
- Body / UI: **Manrope** 400/500/600.
- Eyebrow: `text-xs uppercase tracking-[0.2em] text-muted-foreground`.
- Load fonts via `<link>` in the root route, never remote `@import` in CSS.

## 5. Shape and motion

Radius base 0.625rem; rounded-xl cards; hairline borders; restrained elevation;
150–250ms ease-out motion; respect reduced motion. Max width 6xl.

## 6. Imagery

Real sport, natural light, candid. Multi-sport by default with cricket as the initial focus.
Every image has meaningful alt text.

## 7. Accessibility

WCAG 2.2 AA: 4.5:1 body contrast, visible focus rings, 44×44px touch targets, layouts from 375px.

## 8. Pre-ship checklist

- Name spelled StriideAi; endorsement secondary.
- Colours from tokens only; gold not used as a CTA.
- No invented metrics, testimonials, launch dates or integrations.
- Prices only from the backend pricing catalog, in GBP incl. VAT.
