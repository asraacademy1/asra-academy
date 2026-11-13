# ASRA QUIZORA 2026 — Certificate of Participation (Design 2) assets

Runtime assets of Template 2 (`QUIZORA_PARTICIPATION_DESIGN_2`), rendered by the shared artwork
renderer (`src/modules/certificates/quizora-renderer.ts`) from `QUIZORA_2026_DESIGN_2_DEFINITION`
(`packages/validation/src/certificate-artwork.ts`). Byte-identical copies are served to the web
live preview from `apps/web/public/certificates/quizora-2026-design-2/`.

| File                           | Purpose                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `artwork.jpg`                  | Approved Design 2 reference image, unmodified (1536 × 1024, SHA-256 `94bfdce1bb6a55742adc6608f7185aacc884cb67fc548268a2017e8f3e83fccf`).                                                         |
| `statement-patch.png`          | Transparent overlay (840 × 432 at x 360, y 484) hiding the sample name, statement, sample signatures and static QR. Regenerate with `npx tsx scripts/build-quizora-statement-patch.ts design-2`. |
| `fonts/parisienne-regular.ttf` | Parisienne (SIL Open Font License 1.1, see `fonts/OFL-Parisienne.txt`) — script face for the recipient name.                                                                                     |

The statement uses TeX Gyre Pagella Bold Italic and the metadata Pagella Regular/Bold, shared
from `../quizora-2026/fonts/` (Design 1 assets are not modified).
