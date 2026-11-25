---
name: product-design
description: Canonical product-design standard for researching, designing, auditing, and improving user interfaces without defaulting to generic templates.
---

# Product design

The product's users and work define its interface. This skill owns the design direction, information architecture, hierarchy, interaction patterns, visual system, and experience-level critique. It applies across products; a project profile supplies that product's brand, platform, conventions, and constraints.

It is the canonical design authority when generic or imported skills prescribe an aesthetic that conflicts with the user-approved brief or the project's design profile. It does not replace specialist evidence: accessibility requirements, measured color contrast, localization, platform semantics, security, and functional correctness remain binding. Keep upstream/vendor skill copies intact; resolve conflicts in the project instructions and index, not by silently editing their sources.

## Research basis

Use established systems as evidence about how mature products make interfaces coherent, not as templates to copy. Useful public references include:

- [Microsoft Fluent UI](https://github.com/microsoft/fluentui): theming and shared foundational APIs, with accessibility described as a default rather than an add-on.
- [IBM Carbon](https://github.com/carbon-design-system/carbon): a product system that separates reusable components from color, layout, spacing, typography, and motion foundations.
- [GitHub Primer](https://github.com/primer/design): foundations, components, and UI patterns documented as distinct but connected layers.
- [Modrinth's UI system](https://github.com/modrinth/code/tree/main/packages/ui): semantic surface levels, reusable component roles, and a restrained, task-focused interface.

Extract the practice, not the look: consistent foundations, task-shaped patterns, predictable states, accessible defaults, and rules that hold across an entire product. For Line, Modrinth is a reference for clear hierarchy, surface discipline, and calm accents—not a palette or component skin to copy. Do not adopt glossy or glowing button treatments; interaction feedback should remain legible, restrained, and functional. Never make a product look like “enterprise software” by adding generic cards, badges, muted gray panels, or extra labels.

## Design principles

### Start with the user's task

- State who is using the surface, what they are trying to do, and what a successful result looks like.
- Organize by user goals and decisions, not by the component tree or implementation layers.
- Put the next useful action and the information needed to choose near each other. Explain consequences before irreversible or expensive actions.
- Prefer progressive disclosure over showing every option at once. Keep direct access to reference material when people need to jump to a known topic.
- Treat empty, loading, success, error, stale, disabled, and recovery states as first-class parts of the flow.

### Build hierarchy from meaning

- One dominant heading describes the current task or destination. Supporting text is short, concrete, and adds information rather than paraphrasing the heading.
- Make controls recognizable as controls; keep status and decoration visually subordinate.
- Group related content with alignment and deliberate space. Add a divider or container only when it communicates a real relationship, boundary, or interaction.
- Do not stack generic framing: progress eyebrow + title + framed inset + duplicate caption + dots + repeated next/back controls. Each element must answer a distinct user need.
- Use numbering only for a meaningful sequence. Do not combine two progress indicators for the same sequence.
- Avoid an application screenshot nested inside a tiny “browser in a card” when a real, readable crop or direct control example can teach the task more clearly.

### Establish a coherent system

Before adding one-off styling, inspect the project's design profile, tokens, shared primitives, platform, and supported window sizes. Use them consistently for color roles, type roles, spacing, density, shapes, elevation, icons, and state feedback.

A design system is a set of decisions, not a large token count. Add a token only when a real recurring role needs it. Use the same component for the same job; do not copy a recipe's literal radius, duration, shadow, or color into a product whose established system uses different values.

For nested surfaces that share a visible, evenly inset contour, derive the inner corner radius by subtraction: `innerRadius = max(0, outerRadius - insetDistance)`. The inset distance is measured from the outer contour to the inner contour; in a bordered, padded parent it is the border width plus the padding. For example, an 18px outer radius with a 4px inset gives a 14px inner radius. Do not repeat the outer radius unchanged on the inner surface. If the inset is asymmetric, the contours are not parallel, or the layers read as separate surfaces rather than concentric shapes, keep their radii independent instead of forcing the formula.

Keep semantic colors meaningful and pair color with text, shape, or icon. Use borders, surfaces, and shadows only to express structure or elevation; do not add one to every group. Use decoration only when it supports recognition, orientation, or comprehension.

### Motion explains change

Motion should make a user-triggered state change easier to follow, not decorate idle time. Keep hover, focus, selection, and frequent feedback immediate. Respect reduced-motion preferences, provide pause/replay for meaningful autoplay, and leave a static cue for every animated state.

### Write for action

Use direct, localized language. Name a control by its result. Tell users what to do, what will happen, and how to recover; avoid filler, slogans, redundant captions, and implementation vocabulary. Keep terminology consistent throughout the flow and across locales.

## Workflow

1. **Resolve and confirm scope.** Read the user's request, project instructions, current design profile, and relevant skill sources. For consequential design changes, use the repository's Grill Me workflow and wait for explicit confirmation before implementation.
2. **Learn before proposing.** Inspect real product behavior, representative screens, data constraints, and existing empty/loading/error states. Research official platform or design-system sources when useful. Separate observed facts from design judgments; cite sources in the project skill or decision note.
3. **Audit the whole affected task.** Map entry points, decisions, actions, feedback, recovery, and exits. Expand a shared token or primitive to the screens it affects. Do not infer the quality of unseen states from one screenshot.
4. **Propose the information architecture and visual direction.** Describe the audience, hierarchy, page/frame structure, component roles, responsive behavior, and what will deliberately be removed. Use a short wireframe or annotated screenshot when it makes the proposal clearer. Avoid choosing colors or decorative style before the task structure is clear.
5. **Implement in the product's idiom.** Reuse its components and tokens; keep functionality and copy truthful. Do not introduce a new visual subsystem for one screen unless the user-approved design needs it.
6. **Review the rendered result.** Compare real browser captures at the product's minimum supported size and a normal desktop size, then check zoom/text resizing, keyboard navigation, visible focus, reduced motion, all supported locales, and interactive states. Inspect the interface itself; source code alone cannot prove visual quality.
7. **Verify and report.** Run relevant type, unit, UI, and visual-evidence checks. State exactly what was checked, what could not be checked, and any remaining issues. Never mark an unverified state as good.

## Conflict resolution

Use this order for design decisions:

1. The user's explicit, current brief and confirmed scope.
2. Applicable platform, accessibility, legal, safety, and domain constraints.
3. The product's documented design profile and existing intentional system.
4. This product-design skill's general principles.
5. Generic or imported aesthetic recipes and personal preference.

A specialist skill may own _how to measure or implement_ a rule, but its generic aesthetic suggestion does not override a deliberate product decision. Accessibility and other measurable requirements do not become optional because a design is branded. When a conflict remains, name it and ask rather than silently choosing.

## Line Launcher profile

When this skill is used in Line Launcher, the product code and `docs/DESIGN.md` are the starting point, not a request to clone Fluent, Carbon, Primer, or another application. Use the existing React/Tailwind/Base UI/Framer Motion stack, semantic CSS tokens in `src/index.css`, four shipped locales (`ru`, `en`, `de`, `fr`), and Tauri's minimum window size. The app's animated backdrop and side rail are brand assets unless the user explicitly changes that decision. Keep full real-browser screenshots, guidebook GIF/poster capture, README and verification updates aligned under `launcher-guidebook-maintenance` and `AGENTS.md`.

## Before finishing

- Can a first-time user tell what this surface is for, what to do next, and what will happen?
- Is the information architecture organized around tasks, with a clear way to leave, recover, or jump to a known section?
- Is every label useful, non-duplicated, and translated?
- Does each surface and accent have a purpose in the established design system?
- Have the important states, minimum supported window, zoom, keyboard, focus, and reduced-motion behavior been inspected in the rendered UI?
- Are screenshots and animated demonstrations authentic, legible, current, and generated from the real browser?
- Have you named remaining uncertainty instead of polishing around it?
