---
version: "1.4.0"
name: "OSAU Warm Technical Editorial"
description: "A content-first operations interface combining precise developer tooling with warm editorial surfaces and explicit trust semantics."
colors:
  canvas: "#F6F4EF"
  surface: "#FFFFFF"
  surface-muted: "#EFEEE9"
  surface-raised: "#FAF9F6"
  sidebar: "#24231F"
  sidebar-muted: "#34322D"
  ink: "#1D1D1B"
  ink-secondary: "#5F5C56"
  ink-tertiary: "#6F6B63"
  border: "#D8D4CC"
  border-strong: "#B8B2A7"
  accent: "#CF3E33"
  accent-on-soft: "#A32F26"
  accent-soft: "#FCE9E7"
  focus: "#1D73E8"
  info: "#285F9E"
  info-soft: "#EAF2FB"
  success: "#1F6A50"
  success-soft: "#E7F4EE"
  warning: "#945A0D"
  warning-soft: "#FFF4DE"
  danger: "#A62F2F"
  danger-soft: "#FCE8E8"
  agent: "#5A50D3"
  agent-soft: "#F0EEFF"
  verified: "#1F6A50"
  review-required: "#8A5A09"
  conflict: "#A62F2F"
  not-required: "#5F5C56"
typography:
  page-title:
    fontFamily: "Pretendard Variable, Noto Sans KR, Apple SD Gothic Neo, Inter, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.25
  section-title:
    fontFamily: "Pretendard Variable, Noto Sans KR, Apple SD Gothic Neo, Inter, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.4
  card-title:
    fontFamily: "Pretendard Variable, Noto Sans KR, Apple SD Gothic Neo, Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.45
  body:
    fontFamily: "Pretendard Variable, Noto Sans KR, Apple SD Gothic Neo, Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.65
  body-comfortable:
    fontFamily: "Pretendard Variable, Noto Sans KR, Apple SD Gothic Neo, Inter, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.75
  control:
    fontFamily: "Pretendard Variable, Noto Sans KR, Apple SD Gothic Neo, Inter, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 650
    lineHeight: 1.4
  metadata:
    fontFamily: "Pretendard Variable, Noto Sans KR, Apple SD Gothic Neo, Inter, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.45
  micro:
    fontFamily: "IBM Plex Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.35
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  pill: "999px"
spacing:
  0: "0px"
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
  12: "48px"
  16: "64px"
components:
  primary-button:
    backgroundColor: "#CF3E33"
    textColor: "#FFFFFF"
    borderColor: "#CF3E33"
    borderRadius: "10px"
    minHeight: "36px"
  secondary-button:
    backgroundColor: "#FFFFFF"
    textColor: "#1D1D1B"
    borderColor: "#D8D4CC"
    borderRadius: "10px"
    minHeight: "36px"
  danger-button:
    backgroundColor: "#A62F2F"
    textColor: "#FFFFFF"
    borderColor: "#A62F2F"
    borderRadius: "10px"
    minHeight: "36px"
  input:
    backgroundColor: "#FFFFFF"
    textColor: "#1D1D1B"
    borderColor: "#B8B2A7"
    borderRadius: "10px"
    minHeight: "40px"
  card:
    backgroundColor: "#FFFFFF"
    textColor: "#1D1D1B"
    borderColor: "#D8D4CC"
    borderRadius: "14px"
  sidebar:
    backgroundColor: "#24231F"
    textColor: "#FFFFFF"
    borderColor: "#34322D"
---

# OSAU Design Contract

This file follows the `DESIGN.md` pattern popularized by getdesign.md: machine-readable frontmatter for stable tokens, followed by human rationale, component behavior, screen contracts, and explicit do/don’t rules. It is normative. When prose, CSS, screenshots, and generated UI disagree, the token source and this contract must be reconciled in the same change.

## 1. Visual theme and atmosphere

**Warm Technical Editorial** is the governing direction.

- From Linear: operational precision, restrained controls, deliberate density.
- From Sanity: content-first hierarchy and editorial workbench behavior.
- From Notion: warm neutral surfaces and calm long-session readability.
- From Cal.com: direct, developer-friendly forms and low-friction navigation.
- From Airtable: structured records, visible state, and useful data density.

The interface should feel like a trusted editorial control room, not an AI toy, marketing dashboard, or generic admin template. AI actions are ordinary operations with provenance, status, and reversible outcomes. Decorative gradients, glowing AI motifs, and empty KPI cards are prohibited.

## 2. Design principles

1. **Source first.** Every derivative remains visibly connected to the source and source version.
2. **Actionable state over decorative metrics.** Counts must open a work queue or explain a next action.
3. **Trust is explicit.** Model claims, automatic checks, human verification, and conflicts never share the same label or color.
4. **Channel structure is real.** Naver, long-form, short video, and newsletter artifacts use distinct schemas and previews.
5. **Progressive disclosure.** Quick settings first; advanced channel and model controls remain one level deeper.
6. **One navigation system.** Use the sidebar for product navigation. Do not duplicate it with a second row of workflow chips.
7. **Korean product language.** User-facing UI is Korean-first. English is reserved for code, API names, and optional technical metadata.
8. **Dense, not tiny.** Density comes from removing redundant labels and tuning spacing—not shrinking text below readable sizes.
9. **Every failure has a recovery.** Error surfaces state what was preserved, what failed, and where retry resumes.
10. **No fake affordances.** Buttons must act; tabs must switch content; filters must change the result set.

## 3. Color roles and contrast

### Primary interaction

- `accent` is reserved for the single primary action and the active product location.
- Use `accent-on-soft` for text on `accent-soft`; never use raw `accent` on `accent-soft`.
- Do not use the accent for errors, risk, agent identity, and navigation simultaneously.

### Semantic colors

- `success`: completed operations and healthy connections.
- `warning`: incomplete data, review-required states, expiring guidance.
- `danger`: destructive actions, failed checks, evidence conflicts.
- `agent`: agent identity, delegated work, and service-principal activity.
- `info`: neutral explanations and system notices.

All semantic states include an icon or text label. Color alone is insufficient.

### Evidence states

| UI | Meaning | Color role | Action |
|---|---|---|---|
| `● 확인됨` | Human compared source and block | verified | Pass or reopen verification |
| `◐ 확인 필요` | Model claim or automatic support only | review-required | Open source and verify |
| `! 불일치` | Source and generated claim conflict | conflict | Fix, regenerate, or hold |
| `○ 근거 불필요` | Hook, transition, or CTA with no factual claim | not-required | Normal editorial review |

Automatic support must never use the success styling of human verification.

## 4. Typography

- Product font stack is local/system-first. Do not bundle proprietary font files.
- `11px` is allowed only for nonessential mono IDs or version labels.
- Meaningful metadata is at least `12px`.
- Controls are at least `13px`.
- Body, object titles, table primary cells, and Korean explanatory text are at least `14px`.
- Long Korean reading surfaces use `14–16px` with line height `1.65–1.8`.
- Avoid all-caps English eyebrows in Korean product screens.
- Page titles name the object or queue: `원본 인박스 · 처리 대기 12건`, not instructional slogans.
- Use separators in multiple timestamps: `00:00 · 14:06`.
- Internal IDs (`atom-4`, `seg-1`) are hidden by default; show human names and source positions.

## 5. Layout principles

### App shell

- Desktop sidebar: `248px` expanded, `72px` collapsed.
- Main canvas max width: `1600px`; operational tables may use full width.
- Page padding: `24px` desktop, `16px` tablet, `12px` mobile.
- Header contains object title, state summary, and one primary action.

### Density by screen

- Inbox, library, runs: high-density tables or lists.
- Planner: medium-density selection cards with a persistent plan summary.
- Review Workbench: high-density three-pane workspace.
- Settings: low-density grouped forms.
- Empty space is not filled with ornamental charts. It is either intentional reading space or a sign that useful records, filters, or next actions are missing.

### Review Workbench

Desktop:

```text
Source & Evidence | Structured Artifact | Preview / Checks / Comments / Versions / Run
```

- Left pane: 28–32%
- Center pane: 38–44%
- Right pane: 28–32%
- Selected block and selected source segment remain synchronized.
- Right pane changes with the selected block; it is not a static legend.
- Evidence-state legend lives in help or onboarding.

Tablet uses two panes with a tabbed third panel. Mobile uses `Source / Edit / Review` tabs and keeps approval actions sticky.

## 6. Component contracts and styling

### Buttons

- One primary button per view or modal.
- Desktop minimum height: `36px`; mobile touch target: `44×44px`.
- Blocked actions are disabled and explain why adjacent to the control.
- Danger actions use the danger palette, never the primary accent.
- Labels describe outcomes: `WordPress 초안 전송`, not `계속`.

### Inputs

- Labels always visible; placeholders never substitute for labels.
- Help text appears below fields, not only in tooltips.
- Validation is inline and summarized at form top after submit.
- Advanced settings live in disclosure panels with persisted open state.

### Cards

- Use cards for selection, recommendation, and compact summaries.
- Use tables/lists for operational records.
- Never place cards inside cards without a hierarchy reason.
- Card titles and descriptions must be block-level elements; no inline title/body concatenation.

### Tables

- Sticky header for long operational lists.
- Primary column remains readable at narrow widths.
- Row actions appear on focus and hover, but remain keyboard reachable.
- Status, reason, last update, and next action are visible without opening a drawer.

### Tabs

- Tabs switch content in place and preserve relevant selection.
- Active state uses accent-on-soft or ink with a border; contrast must pass.
- Tabs are not workflow progress indicators.

### Tooltips and help

- Tooltips are supplemental, never the only location of essential information.
- Support hover, keyboard focus, touch activation, and Escape dismissal.
- Connect with `aria-describedby` only while visible.
- Tooltip text is at least 12px.
- Use an explicit Help Drawer for product concepts such as provenance and stale states.

### Status badges

- Minimum text size 12px.
- Include visible text and an icon or symbol.
- Avoid more than two badges per compact card; roll up secondary context as `컨텍스트 변경 3건`.

## 7. Screen contracts

### Source Inbox

Must include:

- Queue title and count
- Search
- Source and state filters
- New, updated, partial-content, missing-transcript, failed-analysis states
- Reason for appearing in the queue
- Last sync and retry
- Primary action: create or continue plan

### Source Detail

Must include:

- Real source content and snapshot version
- Human-readable source positions
- Content atoms and locked facts
- Creator Identity context
- Existing artifact relationships
- Atom-to-block and block-to-atom navigation

### Planner

Must include editable common context and two explicit channel forms before abstraction:

- Purpose
- Creator Identity and Voice
- Audience
- Language and CTA
- Naver settings
- Short-video settings
- Recommendation reason, source range, missing context, and expected editing effort
- Only selected outputs become persistent artifacts

### Review Workbench

Must include:

- Bidirectional evidence navigation
- Four evidence display states
- Dynamic block checks
- Channel preview
- Edit, hold, regenerate, and human-verify actions
- Approval blocked by unresolved conflicts
- Version and run information

### Change Impact

Must derive impact only from `block_source_refs`.

Actions:

- Patch affected blocks
- Regenerate whole artifact
- Keep current artifact with an explicit acknowledgement state

A source change invalidates all affected human verification and moves the current display to review-required while preserving historical verification.

### Export

- Markdown download
- WordPress draft with idempotency and retry
- Export status and external identifier
- No default publishing

## 8. Depth and elevation

- Use borders as the primary separation mechanism.
- Shadow 1: subtle raised card (`0 1px 2px rgba(29,29,27,.06)`).
- Shadow 2: drawers, popovers (`0 12px 36px rgba(29,29,27,.14)`).
- No ambient glow, glassmorphism, or stacked heavy shadows.
- Modals dim the canvas but preserve context.

## 9. Motion

- Functional transitions: 120–180ms.
- Drawer and modal: 180–240ms.
- Respect `prefers-reduced-motion`.
- Do not animate status changes that need reading; use a short highlight and persistent text.
- AI generation progress shows real run steps, not an indeterminate magical shimmer.

## 10. Responsive behavior

### ≥1280px

Full sidebar and three-pane Workbench.

### 960–1279px

Collapsible sidebar; two-pane Workbench plus right-panel tabs.

### 720–959px

Drawer navigation; list rows stack secondary metadata; planner summary remains sticky.

### <720px

Mobile is for inbox triage, evidence checking, comments, approval, and run recovery. Use a real drawer or bottom navigation; never hide navigation without replacement. All touch targets are at least 44px.

## 11. Accessibility

- WCAG 2.2 AA target.
- Text contrast at least 4.5:1 unless it qualifies as large text.
- UI component boundaries and focus indicators at least 3:1 where required.
- Visible focus ring uses `focus` and a two-pixel outline with offset.
- Keyboard completes every core flow.
- Focus is restored after rerender, modal close, and drawer close.
- Live regions are small and announce only status changes; never put `aria-live` on the entire screen.
- Error summaries link to fields.
- Media has captions/transcripts and images have alt text workflows.

## 12. Content and copy

- Write direct Korean product copy.
- Explain why an item needs attention.
- Avoid vague labels such as `처리`, `진행`, `완료` without an object.
- Do not expose infrastructure terms unless the user opens technical details.
- Separate system fact, recommendation, and experiment in wording.

Examples:

```text
원본 가격 정보가 변경되어 3개 문장을 다시 확인해야 합니다.
자동 검사에서 명백한 충돌은 찾지 못했습니다. 사람이 아직 확인하지 않았습니다.
자막을 가져올 수 없습니다. 파일 업로드, 채널 연결, 보류 중 하나를 선택하세요.
```

## 13. Do and don't

### Do

- Show source position beside factual blocks.
- Preserve user edits across retry and failure.
- Explain disabled states.
- Render actual channel-specific structures.
- Keep operational history available.
- Use exact dependency sets for stale impact.

### Don't

- Do not use a single quality score as a product verdict.
- Do not use fake viral scores.
- Do not fill Home with decorative KPIs.
- Do not render English section eyebrows in Korean UI.
- Do not duplicate navigation.
- Do not put link underlines on non-links.
- Do not use Fixture Provider in production.
- Do not convert every platform into one Rich Text document.

## 14. Agent implementation guide

When generating or changing UI, the agent must answer before coding:

1. What object is the user operating on?
2. What is the single primary action?
3. Which source, verification, freshness, or approval state must remain visible?
4. What real data replaces placeholders?
5. What does the failure and recovery state look like?
6. How is the screen used by keyboard and mobile users?
7. Which design tokens and existing components apply?

Before completion, render the screen at desktop and mobile sizes, run design and accessibility gates, inspect screenshots, and report qualitative issues that tests cannot decide.

## 18. Production implementation rule

This contract applies to the persisted production application, not only screenshots or fixture routes.

- Every visible control is backed by persisted state or an explicitly isolated development provider.
- Inbox, Source Detail, Planner, Review, Change Impact, Runs, and Settings include real loading, empty, partial, error, recovery, and permission states.
- A screenshot-only implementation, hard-coded impact list, fake tab, fake filter, or toast-only action fails design review even if visual regression tests pass.
- Channel settings must affect the generated artifact. Naver and ShortVideo outputs must differ in schema, preview, validation, and editing behavior—not merely length or line breaks.
- The selected block controls the right-hand Preview/Checks/Versions/Run context.
