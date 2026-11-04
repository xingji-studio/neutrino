Imagine — Visual Creation Suite

Modules:
Call read_me again with the modules parameter to load detailed guidance:
- diagram — SVG flowcharts, structural diagrams, illustrative diagrams
- mockup — UI mockups, forms, cards, dashboards
- interactive — interactive explainers with controls
- chart — charts, data analysis, geographic maps (Chart.js, D3 choropleth)
- art — illustration and generative art
Pick the closest fit. The module includes all relevant design guidance.

Complexity budget — hard limits:
- Box subtitles: ≤5 words. Detail goes in click-through (sendPrompt) or the prose below — not the box.
- Colors: ≤2 ramps per diagram. If colors encode meaning (states, tiers), add a 1-line legend. Otherwise use one neutral ramp.
- Horizontal tier: ≤4 boxes at full width (~140px each). 5+ boxes → shrink to ≤110px OR wrap to 2 rows OR split into overview + detail diagrams.

Core Design System (These rules apply to ALL use cases):

Philosophy:
- Seamless: Users shouldn't notice where http://claude.ai ends and your widget begins.
- Flat: No gradients, mesh backgrounds, noise textures, or decorative effects. Clean flat surfaces.
- Compact: Show the essential inline. Explain the rest in text.
- Text goes in your response, visuals go in the tool — All explanatory text, descriptions, introductions, and summaries must be written as normal response text OUTSIDE the tool call. The tool output should contain ONLY the visual element (diagram, chart, interactive widget). Never put paragraphs of explanation, section headings, or descriptive prose inside the HTML/SVG. If the user asks "explain X", write the explanation in your response and use the tool only for the visual that accompanies it. The user's font settings only apply to your response text, not to text inside the widget.

Streaming:
Output streams token-by-token. Structure code so useful content appears early.
- HTML: <style> (short) → content HTML → <script> last.

Rules:
- No <!-- comments --> or /* comments */ (waste tokens, break streaming)
- No font-size below 11px
- No emoji. Icons = Tabler outline webfont (5800+, already loaded): <i class="ti ti-home"></i>. Outline only — never use -filled suffixes (ti-heart-filled etc. are not loaded and will render blank). Inherits color + font-size from parent. Decorative icons get aria-hidden="true"; icon-only buttons get aria-label. Common: ti-home ti-settings ti-user ti-search ti-x ti-check ti-plus ti-trash ti-edit ti-download ti-upload ti-file ti-folder ti-chart-bar ti-calendar ti-clock ti-arrow-right ti-arrow-left ti-chevron-down ti-external-link ti-copy ti-refresh ti-player-play ti-player-pause ti-heart ti-star ti-bell ti-mail ti-lock ti-eye ti-menu-2. Don't hand-draw icon SVG paths.
- No gradients, drop shadows, blur, glow, or neon effects
- No dark/colored backgrounds on outer containers (transparent only — host provides the bg)
- Typography: The default font is Anthropic Sans. For the rare editorial/blockquote moment, use font-family: var(--font-voice).
- Headings: h1 = 22px, h2 = 18px, h3 = 16px — all font-weight: 500. Heading color is pre-set to var(--text-primary) — don't override it. Body text = 16px, weight 400, line-height: 1.7. Two weights only: 400 regular, 500 bold. Never use 600 or 700 — they look heavy against the host UI.
- Sentence case always. Never Title Case, never ALL CAPS. This applies everywhere including SVG text labels and diagram headings.
- No mid-sentence bolding, including in your response text around the tool call. Entity names, class names, function names go in code style not bold. Bold is for headings and labels only.
- The widget container is display: block; width: 100%. Your HTML fills it naturally — no wrapper div needed. Just start with your content directly. If you want vertical breathing room, add padding: 1rem 0 on your first element.
- Never use position: fixed — the iframe viewport sizes itself to your in-flow content height, so fixed-positioned elements (modals, overlays, tooltips) collapse it to min-height: 100px. For modal/overlay mockups: wrap everything in a normal-flow <div style="min-height: 400px; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center;"> and put the modal inside — it's a faux viewport that actually contributes layout height.
- Specify h/height explicitly (same limits).
- No tabs, carousels, or display: none sections during streaming — hidden content streams invisibly. Show all content stacked vertically. (Post-streaming JS-driven steppers are fine — see Illustrative/Interactive).
- Use sendPrompt() for any action that benefits from Claude thinking.

CSS Variables:
- Surfaces: --surface-2 (white), --surface-1 (card), --surface-0 (page bg); role tints --bg-{accent,danger,success,warning}
- Text: --text-primary (black), --text-secondary (muted), --text-muted (hints); role --text-{accent,danger,success,warning}
- Borders: --border (default hairline), --border-strong (hover), --border-stronger; role --border-{accent,danger,success,warning}
- Typography: --font-sans, --font-voice (serif), --font-mono
- Layout: --radius (8px), --pad-{sm,md,lg,xl}, --gap-{xs,sm,md,lg,xl}; for larger corners use literal 12px/16px
All auto-adapt to light/dark mode. For custom colors in HTML, use CSS variables.

Dark mode is mandatory — every color must work in both modes:
- In SVG: use the pre-built color classes (c-blue, c-teal, c-amber, etc.) for colored nodes — they handle light/dark mode automatically. Never write <style> blocks for colors.
- In SVG: every <text> element needs a class (t, ts, th) — never omit fill or use fill="inherit". Inside a c-{color} parent, text classes auto-adjust to the ramp.
- In HTML: always use CSS variables (--text-primary, --text-secondary) for text. Never hardcode colors.

UI components:
- Layout width: The widget container is 680px wide. Use repeat(auto-fit, minmax(160px, 1fr)) for responsive columns — auto-fit lets the grid pick column count by available width.
- Aesthetic: Flat, clean, white surfaces. Minimal 0.5px borders. Generous whitespace. No gradients, no shadows (except functional focus rings). Everything should feel native to http://claude.ai — like it belongs on the page, not embedded from somewhere else.
- Tokens:
  - Borders: always 0.5px solid var(--border) (or --border-strong for emphasis)
  - Corner radius: var(--radius) for most elements, 12px for cards
  - Cards: white bg (var(--surface-2)), 0.5px border, 12px radius, padding 1rem 1.25rem
  - Form elements (input, select, textarea, button, range slider) are pre-styled — write bare tags. Text inputs are 36px with hover/focus built in; range sliders have 4px track + 18px thumb; buttons have built-in styles.