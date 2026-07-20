# DESIGN.md — Health Dashboard

| meta | |
| --- | --- |
| version | 1.0 |
| name | health-dashboard-design |
| based-on | Revolut design analysis (VoltAgent/awesome-design-md), adapted: dark-only app canvas, free font stack, semantic health-metric accent palette |
| description | A dark, precise, fintech-grade dashboard system. True-black canvas, luminance-based elevation (no drop shadows), pill buttons, rounded-12/20px cards, tight medium-weight display type. Color is semantic, not decorative: each metric family owns one saturated accent, used only where that family's data appears. The result reads elegant and restrained at rest, colorful exactly where information lives. |

## Overview

This system adapts Revolut's design language from a marketing site to a **desktop data dashboard**. Three deliberate departures from the source:

1. **Dark-first, one continuous surface.** Revolut alternates black storytelling bands with white catalogue bands. A dashboard is one continuous surface, so this app defaults to the dark canvas (`{colors.canvas}` — `#000000`, true black, never near-black). Elevation comes from surface luminance steps, never from shadows. A light theme (see "Light theme") inverts the ladder onto true white for bright rooms; both obey the no-shadow and grayscale-clean laws.
2. **Free fonts.** Aeonik Pro (proprietary) is replaced by **Space Grotesk** for all display/heading sizes; **Inter** remains for body, labels, and data. Space Grotesk at weight 500 with tight negative tracking preserves the compressed, confident display character.
3. **Semantic accents.** Revolut's accent palette is decorative (illustrations only). Here the accent palette is **informational**: five color families, each permanently bound to one metric domain. Color = meaning. After a week of use, a glance at hue tells the user which system of their body a number belongs to.

**Key characteristics:**

- True-black canvas with a two-step elevated-surface ladder (`{colors.surface}` → `{colors.surface-elevated}`).
- Space Grotesk 500 display type, `lineHeight: 1.0–1.2`, negative letter-spacing that scales with size. Capped at 72px — this is a dashboard, not a billboard. The one place display type goes big is the **hero metric** (e.g. weekly Zone 2 minutes) at the top of each tab.
- All buttons and chips are pills (`{rounded.full}`). Cards are `{rounded.lg}` (20px). Inputs and chart containers are `{rounded.md}` (12px).
- Accent colors appear **only** on data elements (chart lines, hero digits, sparklines, badges, calendar cells) — never as button surfaces, never as decoration.
- Neutral UI chrome: buttons, nav, and inputs use only white/black/gray. The brightest neutral pixel is the primary CTA (white pill on black), exactly as in the source system.
- Numbers everywhere use tabular figures (`font-variant-numeric: tabular-nums`) so columns and tickers align.

## Colors

### Canvas & Surfaces

| Token | Value | Use |
| --- | --- | --- |
| `{colors.canvas}` | `#000000` | App background. True black. |
| `{colors.surface}` | `#0A0A0A` | Inset panels, chart plot backgrounds. |
| `{colors.surface-elevated}` | `#16181A` | Cards. The default card surface. |
| `{colors.surface-hover}` | `#1D2023` | Hover state of interactive cards and list rows. |
| `{colors.hairline}` | `rgba(255,255,255,0.12)` | 1px dividers, card outlines where needed. |
| `{colors.divider-soft}` | `rgba(255,255,255,0.06)` | Table row separators, subtle grid lines in charts. |

### Text

| Token | Value | Use |
| --- | --- | --- |
| `{colors.text}` | `#FFFFFF` | Primary text, hero digits. |
| `{colors.text-secondary}` | `rgba(255,255,255,0.72)` | Supporting text, card subtitles. |
| `{colors.text-tertiary}` | `rgba(255,255,255,0.48)` | Metadata, axis labels, captions. |
| `{colors.text-disabled}` | `rgba(255,255,255,0.30)` | Disabled labels, empty-state hints. |
| `{colors.text-on-accent}` | `#0A0A0A` | Text on any accent-colored surface (badges). |

### Semantic accents — one family per metric domain

| Token | Value | Domain | Appears on |
| --- | --- | --- | --- |
| `{colors.aerobic}` | `#2DD4BF` | Zone 2 / aerobic base | Z2 charts, EF trend, time-in-zone bars, Zone 2 tab hero metric |
| `{colors.load}` | `#6366F1` | Training load / fitness | CTL/ATL curves, TRIMP bars, load tab accents |
| `{colors.recovery}` | `#5B8DEF` | Recovery | Sleep charts, RHR trend, HRV trend, recovery tab hero |
| `{colors.sessions}` | `#FB923C` | Sessions / adherence | Calendar heatmap cells, streak counter, session list markers |
| `{colors.flag}` | `#EF4444` | Warnings only | ACWR flag banner, elevated-RHR flag, missed-minimum flag. Nowhere else, ever. |

Each accent has a **dim variant** at 15% opacity for area fills, calendar cell backgrounds, and badge backgrounds: `{colors.aerobic-dim}` `rgba(45,212,191,0.15)`, `{colors.load-dim}` `rgba(99,102,241,0.15)`, `{colors.recovery-dim}` `rgba(91,141,239,0.15)`, `{colors.sessions-dim}` `rgba(251,146,60,0.15)`, `{colors.flag-dim}` `rgba(239,68,68,0.15)`.

Multi-series charts within one domain (e.g. deep vs. REM sleep) use the domain accent plus `{colors.text-tertiary}` gray for secondary series — never borrow another domain's accent.

## Typography

### Font Family

- **Space Grotesk** — display and headings, always weight 500. Loaded from Google Fonts / self-hosted (open license). Negative letter-spacing scales with size.
- **Inter** — body, labels, buttons, table data. Weight 400 default, 600 emphatic — never 500. UI labels carry positive tracking (`0.16–0.24px`) for mechanical precision. All numeric contexts set `font-variant-numeric: tabular-nums`.

### Hierarchy

| Token | Font | Size | Weight | Line Height | Letter Spacing | Use |
| --- | --- | --- | --- | --- | --- | --- |
| `{typography.hero-metric}` | Space Grotesk | 72px | 500 | 1.0 | -1.44px | The one big number per tab (weekly Z2 minutes, CTL). |
| `{typography.display}` | Space Grotesk | 40px | 500 | 1.1 | -0.4px | Tab titles. |
| `{typography.heading-lg}` | Space Grotesk | 28px | 500 | 1.2 | -0.28px | Card hero numbers (secondary stats). |
| `{typography.heading-md}` | Space Grotesk | 20px | 500 | 1.3 | -0.1px | Card titles. |
| `{typography.heading-sm}` | Space Grotesk | 16px | 500 | 1.4 | 0 | Section labels inside cards. |
| `{typography.body-md}` | Inter | 15px | 400 | 1.5 | 0.16px | Default body, chat messages. |
| `{typography.body-md-bold}` | Inter | 15px | 600 | 1.5 | 0.16px | Emphatic body. |
| `{typography.body-sm}` | Inter | 13px | 400 | 1.45 | 0.16px | Table data, list metadata. |
| `{typography.label}` | Inter | 12px | 600 | 1.35 | 0.6px | UPPERCASE eyebrow labels above metrics ("ZONE 2 · THIS WEEK"). |
| `{typography.caption}` | Inter | 12px | 400 | 1.4 | 0.24px | Axis labels, footnotes, timestamps. |
| `{typography.button-md}` | Inter | 14px | 600 | 1.4 | 0.24px | Default button label. |
| `{typography.button-sm}` | Inter | 13px | 600 | 1.4 | 0.24px | Pills, chips, filter tabs. |

### Principles

- Display sizes are always weight 500 — authority comes from size and tight tracking, never from bold.
- The hero metric's unit and eyebrow label sit in `{typography.label}` `{colors.text-tertiary}` — giant digit, whisper label.
- Body never uses Space Grotesk; display never uses Inter.
- Every number that can be compared to another number uses tabular figures.

## Layout

### Spacing

Base unit 4px. Tokens: `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 64px.

- Card internal padding: `{spacing.lg}` (24px). Hero-metric cards: `{spacing.xl}` (32px).
- Grid gap between cards: `{spacing.md}` (16px).
- Tab content top padding below the tab header: `{spacing.xl}`.

### Structure

- **Sidebar navigation**, 220px wide, `{colors.canvas}`, hairline right border — Mac-app convention. Nav items are pill-highlighted on active (`{colors.surface-elevated}` pill behind the label). Order: Dashboard · Zone 2 · Sessions · Recovery · Insights · Chat.
- **Content area** max-width 1200px, centered when the window exceeds it.
- **Card grid**: 12-column. Hero metric card spans 12; standard metric cards span 4 (3-up); charts span 6, 8, or 12 depending on density. Collapse to 2-up below 1100px window width, 1-up below 760px.

### Whitespace Philosophy

Generous but denser than the marketing source: this is a working surface. Sections breathe at 48–64px; inside cards everything aligns to the 4px grid. Hairlines replace shadows for separation. If a card feels crowded, remove a stat rather than shrinking type.

## Elevation & Depth

| Level | Treatment | Use |
| --- | --- | --- |
| 0 — canvas | `{colors.canvas}`, flat | App background, sidebar. |
| 1 — inset | `{colors.surface}` | Chart plot areas, code/chat input wells. |
| 2 — card | `{colors.surface-elevated}` | All cards. |
| 3 — hover | `{colors.surface-hover}` | Interactive card/row hover. |
| 4 — flag | `{colors.flag-dim}` background + `{colors.flag}` 1px left border | Warning banners only. |

**No drop shadows anywhere.** Depth is luminance. The surface ladder has exactly the steps above — never invent an intermediate gray.

## Shapes

| Token | Value | Use |
| --- | --- | --- |
| `{rounded.sm}` | 8px | Calendar heatmap cells, small tags. |
| `{rounded.md}` | 12px | Inputs, chart containers, chat bubbles. |
| `{rounded.lg}` | 20px | Cards. |
| `{rounded.full}` | 9999px | Buttons, pills, nav highlight, badges, filter chips. |

## Components

### Buttons (neutral chrome only — never accent-colored)

**`button-primary`** — white pill on dark
- Background `{colors.text}` (#FFFFFF), label `#000000`, `{typography.button-md}`, padding `12px 24px`, `{rounded.full}`, height 44px. The loudest element on screen; at most one per view. Pressed: background `#C9C9CD`.

**`button-soft`** — secondary
- Background `{colors.surface-elevated}`, label `{colors.text}`, `{rounded.full}`, height 44px. Default secondary action ("Export", "Refresh").

**`button-outline`** — tertiary
- Transparent, 1px solid `{colors.hairline}`, label `{colors.text-secondary}`, `{rounded.full}`, height 44px.

**`chip-filter`** — range/filter pill
- Background `{colors.surface-elevated}` (active: `{colors.text}` with black label), `{typography.button-sm}`, `{rounded.full}`, padding `6px 14px`, height 32px. Used for 7d / 30d / 90d / 1y range switchers on every chart.

### Data display

**`hero-metric`**
- One per tab, top of content. Eyebrow `{typography.label}` in the tab's domain accent, digit in `{typography.hero-metric}` `{colors.text}`, unit + delta in `{typography.body-sm}` `{colors.text-tertiary}`. Delta arrow takes the domain accent when positive-for-the-user, `{colors.text-tertiary}` otherwise — never red (red is for flags, and a down week is information, not an alarm).

**`metric-card`**
- `{colors.surface-elevated}`, `{rounded.lg}`, padding 24px. Structure: eyebrow label → value in `{typography.heading-lg}` → optional sparkline (1.5px domain-accent line, `-dim` area fill) → caption. 3-up grid.

**`chart-card`**
- `{colors.surface-elevated}`, `{rounded.lg}`; plot area inset on `{colors.surface}` `{rounded.md}`. Grid lines `{colors.divider-soft}`, axis text `{typography.caption}` `{colors.text-tertiary}`. Series in domain accent(s); reference bands (e.g. Zone 2 HR corridor) in the domain `-dim` fill. Tooltip: `{colors.surface-hover}`, `{rounded.md}`, `{typography.body-sm}`, tabular figures.

**`calendar-heatmap`** (Sessions tab)
- Month grid of `{rounded.sm}` cells, 4px gap. Empty day: `{colors.surface}`. Workout day: `{colors.sessions-dim}` background scaling to `{colors.sessions}` with session duration; multi-modality days show a 3px dot row in each modality's domain accent inside the cell. Today: 1px `{colors.hairline}` outline.

**`flag-banner`**
- Full-width above tab content. `{colors.flag-dim}` background, 3px `{colors.flag}` left border, `{rounded.md}`, icon + `{typography.body-md}` text + dismiss. The only red element in the app. Examples: "Ramp rate high: last 7 days = 1.6× your 28-day average", "Resting HR +5 bpm above baseline for 3 days".

**`badge-domain`**
- Pill, `{typography.caption}` 600, padding `3px 10px`, domain `-dim` background, domain accent text. Marks a stat or list row with its domain ("ZONE 2", "RECOVERY").

**`stat-table`**
- Rows separated by `{colors.divider-soft}`, labels `{typography.body-sm}` `{colors.text-secondary}`, values `{typography.body-sm}` `{colors.text}` tabular, right-aligned.

### Chat (AI tab)

**`chat-workspace`** — continuous analysis canvas with a 208px history rail, a centered 760px reading column, and an optional 248px work-log rail. A single `{colors.hairline}` outline contains the workspace; internal regions use hairlines and the neutral surface ladder rather than cards, shadows, or accent color.
- Compact header: conversation title + mode/status on one row. It replaces the normal tab billboard so long answers own the available height.
- Assistant messages: no bubble — plain `{typography.body-md}` on canvas, 1.68 line-height, maximum 72ch. Headings use Space Grotesk at weight 500. Tables and code use bordered `{colors.surface}` insets and scroll horizontally instead of widening the reading measure.
- User messages: `{colors.surface-elevated}` bubble, `{rounded.md}`, padding `12px 16px`, right-aligned, max-width 80%.
- Work in progress: the partial answer remains in the document while a compact work-log summary links to chronological tool/status details. Internal reasoning is never presented as prose. Interrupted work keeps its partial answer and offers `Continue` or `Retry` in place.
- Composer: anchored below the document, `{colors.surface}` well, 1px `{colors.hairline}`, `{rounded.md}`, min-height 52px, and a 36px white circular send button. Draft, mode, and attachments belong to the selected conversation and survive navigation between app tabs. The composer remains editable while a response runs; the send button becomes Stop.
- Empty state: left-aligned editorial introduction followed by prompt rows separated with hairlines. Offline state keeps past conversations accessible and offers `button-soft` "Retry Connection."
- At narrow widths, history becomes a left drawer before the reading column is compressed; the work log then becomes a right drawer. Both close with Escape, restore trigger focus, and sit above a neutral scrim.

### Inputs

**`text-input`** — background `{colors.surface}`, 1px `{colors.hairline}`, `{rounded.md}`, padding `12px 16px`, height 48px, text `{typography.body-md}`. Focus: border brightens to `rgba(255,255,255,0.3)`. No accent-colored focus rings.

## Do's and Don'ts

### Do

- Keep all UI chrome (buttons, nav, inputs, borders) strictly neutral. If a screenshot in grayscale loses only chart/metric color, the system is being used correctly.
- Bind every accent use to its domain, everywhere, forever. A teal element means aerobic. No exceptions for variety's sake.
- Use one `{typography.hero-metric}` number per tab — the tab's single most important figure, in giant tight digits.
- Use tabular figures for every metric, table, and axis.
- Use `-dim` variants for any accent area larger than a line or a digit (fills, cell backgrounds, badges).
- Let empty states instruct: "No swims this week yet — your last was Tue 3 Mar, 1,000m."

### Don't

- Don't use `{colors.flag}` red for anything except the three defined flag types. A bad trend is shown in neutral gray with a caption, not in red.
- Don't color buttons with domain accents. The primary CTA is the white pill; that is the brand's loudest element.
- Don't add drop shadows, glows, or gradients. Elevation is luminance only. (One exception: chart area fills may fade the `-dim` color to transparent vertically.)
- Don't use near-black for the canvas. It is `#000000`.
- Don't set display type in bold; weight 500 always. Don't set body Inter at 500; 400 or 600 only.
- Don't exceed 72px type anywhere. The billboard sizes of the source system are out of scope.
- Don't put two hero metrics on one tab. One number owns each view.
- Don't introduce a sixth accent family without retiring one; five domains is the ceiling for glanceable color-coding.

## Responsive Behavior (window resizing)

| Window width | Changes |
| --- | --- |
| ≥ 1440px | Sidebar 220px; content max 1200px; cards 3-up. |
| 1100–1439px | Cards 3-up; charts that spanned 6 may go 12. |
| 760–1099px | Sidebar collapses to 64px icon rail; cards 2-up; hero metric clamps to 56px. |
| < 760px | Icon rail; cards 1-up; hero metric 48px. |

Touch targets are irrelevant (desktop pointer app), but all interactive elements keep ≥ 32px hit areas and visible keyboard focus (1px `rgba(255,255,255,0.4)` outline, 2px offset).

## Iteration Guide

1. Reference tokens directly (`{colors.aerobic}`, `{component.hero-metric}`, `{rounded.lg}`) — never paraphrase.
2. New component variants get their own entries (`-active`, `-disabled`) — don't bury states in prose.
3. Changing the palette = editing the five accent hexes and their `-dim` variants in the Colors section only; nothing else references raw hex values.
4. If a view starts accumulating accent colors, audit domain bindings — the fix is removing an element, not adding a hue.
5. Default any new text to `{typography.body-md}`; reach for Space Grotesk only when the element is a heading or a metric.

## Light theme

The app ships both themes. Dark is the default and the design's home; light is a faithful inversion for bright rooms, reached by the Sun/Moon toggle (a `button-soft` icon button, 40px, in the top-bar toolbar beside Refresh). The choice persists to `localStorage('theme')` and is applied to `document.documentElement` (`data-theme='light'`) before first paint — an inline script in `index.html` reads the stored value ahead of the bundle, so there is no flash on launch.

Light inverts the surface ladder onto a true-white canvas. The two laws that define the system hold unchanged in both themes: **no drop shadows** (elevation is luminance + hairline only) and **grayscale-clean chrome** (desaturate a screenshot and only data elements lose color).

### Derived palette (`[data-theme='light']` overrides)

| Token | Light value | Note |
| --- | --- | --- |
| `{colors.canvas}` | `#FFFFFF` | True white. |
| `{colors.surface}` | `#F4F5F7` | Subtle inset well (chart plots, chat input). |
| `{colors.surface-elevated}` | `#FBFBFC` | Cards — near-white, set apart from canvas by luminance **and** a hairline, never a shadow. |
| `{colors.surface-hover}` | `#EEF0F2` | Interactive hover. |
| `{colors.hairline}` | `rgba(0,0,0,0.10)` | 1px dividers, card outlines. |
| `{colors.divider-soft}` | `rgba(0,0,0,0.06)` | Grid lines, row separators. |
| `{colors.text}` | `#000000` | Primary text, hero digits. |
| `{colors.text-secondary}` | `rgba(0,0,0,0.66)` | |
| `{colors.text-tertiary}` | `rgba(0,0,0,0.46)` | Axis labels, captions. |
| `{colors.text-disabled}` | `rgba(0,0,0,0.30)` | |

The five accent **hues are unchanged** — teal still means aerobic. Their `-dim` fill variants drop to **12% opacity on white** (dark uses 15%): `aerobic-dim rgba(45,212,191,0.12)`, `load-dim rgba(99,102,241,0.12)`, `recovery-dim rgba(91,141,239,0.12)`, `sessions-dim rgba(251,146,60,0.12)`, `flag-dim rgba(239,68,68,0.12)`.

### `-text` accent variants (the contrast rule)

The base accent hues are tuned for a black canvas; several are too light to read as small text on white. So every place an accent paints **text or small digits** — hero eyebrow, hero delta, `metric-card` value, `badge-domain` label, dashboard stat values, flag icon/text — references a `{colors.<domain>-text}` variable instead of the base accent. In dark these equal the base accent; in light they darken enough to clear ~4.5:1 on white while keeping the hue:

| Token | Light value |
| --- | --- |
| `{colors.aerobic-text}` | `#0F766E` (teal-700) |
| `{colors.load-text}` | `#4F46E5` (indigo-600) |
| `{colors.recovery-text}` | `#2563EB` (blue-600) |
| `{colors.sessions-text}` | `#C2410C` (orange-700) |
| `{colors.flag-text}` | `#DC2626` (red-600) |

**Chart geometry keeps the base accent** — lines, bars, scatter dots, calendar cells and area fills sit on inset `{colors.surface}`, not raw white, and stay vivid. Only text switches to the `-text` variant. Two more neutral-surface labels use `{colors.on-emphasis}` (the inverse of `{colors.text}`: black in dark, white in light) for the label painted on the loudest neutral surface — `button-primary`, `chip-filter` active, chat send. `{colors.text-on-accent}` stays a dark digit in both themes for text sitting on a solid domain-accent fill (heatmap step-3).

The keyboard focus ring is theme-aware: `rgba(255,255,255,0.4)` on dark, `rgba(0,0,0,0.45)` on light, 1px / 2px offset in both.

## Known Gaps

- Print/export styling for AI reports is undefined.
- Animation is intentionally minimal: 150ms ease-out on hover/active surface changes, 300ms ease on chart range transitions; nothing else. Chart-drawing animations are permitted but must respect `prefers-reduced-motion`.
- Icon set undefined: use Lucide, 1.5px stroke, sized 16/20px, `{colors.text-secondary}` default, domain accent only when marking domain-bound data.
