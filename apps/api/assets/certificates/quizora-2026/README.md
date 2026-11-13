# ASRA QUIZORA 2026 — Certificate of Participation assets

Runtime assets of the artwork-based certificate template (`QUIZORA_PARTICIPATION`). Rendered on
demand by `src/modules/certificates/quizora-renderer.ts`; nothing here is stored in PostgreSQL.
The web live preview serves byte-identical copies from `apps/web/public/certificates/quizora-2026/`
(enforced by `apps/web/tests/certificates-quizora.test.tsx`).

| File                         | Purpose                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artwork.jpg`                | Approved reference design, unmodified (1536 × 1024, SHA-256 `178913bcbd6267c94e4302c8abb028c7b298d4754ab1fd74a93aa7d8f799ee46`).                                                                                                                  |
| `statement-patch.png`        | Transparent overlay (1042 × 146 at x 250, y 608) that hides the artwork's baked-in statement so it can be rendered from the template text. Regenerate with `npx tsx scripts/build-quizora-statement-patch.ts`.                                    |
| `fonts/texgyrepagella-*.otf` | TeX Gyre Pagella (Palatino-metric serif matching the artwork typography), licensed under the GUST Font License — see `fonts/GUST-FONT-LICENSE.txt`. Embedded in PDFs and converted to glyph outlines for PNGs so both formats render identically. |

Replacing the artwork: keep the 1536 × 1024 size (or update `QUIZORA_2026_LAYOUT` in
`packages/validation/src/certificate-artwork.ts`), regenerate the statement patch, copy the files
to the web public folder, and re-check the layout coordinates.
