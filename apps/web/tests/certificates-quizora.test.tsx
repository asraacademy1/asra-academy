/**
 * ASRA QUIZORA 2026 — Certificate of Participation: live preview rendering tests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCertificateStatementRuns,
  formatCertificateLongDate,
  formatCertificateOrdinalDate,
  layoutCertificateMetadata,
  QUIZORA_2026_DEFAULT_BODY_TEXT,
  QUIZORA_2026_DEFINITION,
  QUIZORA_2026_DESIGN_2_DEFINITION,
} from '@asra/validation';
import QRCode from 'qrcode';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CertificatePreview,
  DEFAULT_CERTIFICATE_PREVIEW_CONFIG,
} from '@/components/certificates/certificate-preview';

const VERIFY_URL = 'https://www.asraacademy.in/verify/ASRA-2026-PX7B-M4GS';

function render(signatures: { key: string; fullName: string; imageSrc: string | null }[]) {
  return renderToStaticMarkup(
    <CertificatePreview
      style="QUIZORA_PARTICIPATION"
      config={DEFAULT_CERTIFICATE_PREVIEW_CONFIG}
      issuingAuthority="ASRA Academy"
      certificateTitle="Certificate of Participation"
      recipientName="Fatima Zahra Al-Khatib"
      bodyText={QUIZORA_2026_DEFAULT_BODY_TEXT}
      subjectTitle="ASRA QUIZORA – 2026"
      achievementDetails="Academy Quiz Participant · Score: 96% · Rank #1"
      completedAt="2026-11-14T05:00:00.000Z"
      issuedAt="2026-11-14T10:00:00.000Z"
      certificateNumber="ASRA-2026-PX7B-M4GS"
      verificationUrl={VERIFY_URL}
      signatures={signatures.map((s) => ({
        ...s,
        designation: '',
        showName: true,
        showDesignation: true,
      }))}
    />,
  );
}

describe('QUIZORA certificate preview', () => {
  it('renders the reference artwork, statement patch, signature slots and verification QR — never scores', () => {
    const html = render([
      { key: 'a', fullName: 'Coordinator', imageSrc: 'data:image/png;base64,iVBORw0KGgo=' },
      { key: 'b', fullName: 'Director', imageSrc: 'data:image/png;base64,iVBORw0KGgo=' },
    ]);
    assert.match(html, /data-template-style="QUIZORA_PARTICIPATION"/);
    assert.match(html, /aspect-\[3\/2\]/);
    assert.match(html, /viewBox="0 0 1536 1024"/);
    assert.match(html, /href="\/certificates\/quizora-2026\/artwork\.jpg"/);
    assert.match(html, /href="\/certificates\/quizora-2026\/statement-patch\.png"/);
    assert.equal((html.match(/preserveAspectRatio="xMidYMax meet"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /signature required/);
    assert.match(html, /SCAN TO VERIFY/);
    // QR matrix encodes the verification URL (one rect per horizontal run of dark modules)
    const modules = QRCode.create(VERIFY_URL, { errorCorrectionLevel: 'M' }).modules;
    let runs = 0;
    for (let r = 0; r < modules.size; r++) {
      for (let c = 0; c < modules.size; c++) {
        if (modules.get(r, c) && (c === 0 || !modules.get(r, c - 1))) runs++;
      }
    }
    const qrGroup = /shape-rendering="crispEdges">(.*?)<\/g>/.exec(html)?.[1] ?? '';
    assert.equal((qrGroup.match(/<rect /g) ?? []).length, runs);
    assert.doesNotMatch(html, /96%|Score|Rank #1/);
  });

  it('flags missing mandatory signatures in the preview', () => {
    const html = render([{ key: 'a', fullName: 'Coordinator', imageSrc: null }]);
    assert.match(html, /Event Coordinator signature required/);
    assert.match(html, /Director signature required/);
  });

  it('shares the statement, date and metadata logic with the server renderer', () => {
    const runs = buildCertificateStatementRuns(QUIZORA_2026_DEFAULT_BODY_TEXT, {
      title: 'ASRA QUIZORA – 2026',
      date: '2026-11-13T20:00:00.000Z', // 01:30 IST on 14 Nov
    });
    assert.deepEqual(
      runs.map((p) => p.map((r) => `${r.variant}:${r.text}`)),
      [
        [
          'body:has successfully attempted the ',
          'title:ASRA QUIZORA – 2026',
          'body:, a National Level Quiz Competition organized by ',
          'emphasis:ASRA Academy',
        ],
        ['body:on ', 'date:14', 'dateSuffix:th', 'date: November 2026', 'body:.'],
      ],
    );
    assert.deepEqual(formatCertificateOrdinalDate('2026-11-01T00:00:00Z'), {
      day: '1',
      suffix: 'st',
      rest: ' November 2026',
    });
    assert.equal(formatCertificateLongDate('2026-11-13T20:00:00.000Z'), 'November 14, 2026');
    const meta = layoutCertificateMetadata(
      {
        completedAt: '2026-11-14T05:00:00Z',
        issuedAt: '2026-11-14T05:00:00Z',
        certificateNumber: 'ASRA-2026-PX7B-M4GS',
        verificationUrl: VERIFY_URL,
      },
      (text, _variant, size) => text.length * size * 0.5,
    );
    assert.deepEqual(
      meta.map((l) => l.segments.map((s) => s.text).join(' ')),
      [
        'COMPLETION DATE: November 14, 2026',
        'ISSUED DATE: November 14, 2026',
        'CERTIFICATE ID: ASRA-2026-PX7B-M4GS',
        'VERIFY AT:',
        VERIFY_URL,
      ],
    );
  });

  it('ships the same artwork bytes and fonts as the API renderer', () => {
    const webDir = path.resolve(import.meta.dirname, '../public/certificates/quizora-2026');
    const apiDir = path.resolve(import.meta.dirname, '../../api/assets/certificates/quizora-2026');
    for (const file of [
      'artwork.jpg',
      'statement-patch.png',
      'fonts/texgyrepagella-regular.otf',
      'fonts/texgyrepagella-italic.otf',
      'fonts/texgyrepagella-bold.otf',
      'fonts/texgyrepagella-bolditalic.otf',
      '../quizora-2026-design-2/artwork.jpg',
      '../quizora-2026-design-2/statement-patch.png',
      '../quizora-2026-design-2/fonts/parisienne-regular.ttf',
    ]) {
      assert.ok(
        fs.readFileSync(path.join(webDir, file)).equals(fs.readFileSync(path.join(apiDir, file))),
        `${file} differs between web preview and API renderer`,
      );
    }
    // Every font file referenced by either design definition is served to the web preview
    for (const def of [QUIZORA_2026_DEFINITION, QUIZORA_2026_DESIGN_2_DEFINITION]) {
      for (const file of Object.values(def.fonts)) {
        assert.ok(fs.existsSync(path.join(webDir, '..', file)), `${file} missing from web public`);
      }
    }
  });

  it('renders Design 2 with its own artwork, plain bottom-centre QR and no Design 1 carry-over', () => {
    const html = renderToStaticMarkup(
      <CertificatePreview
        style="QUIZORA_PARTICIPATION_DESIGN_2"
        config={DEFAULT_CERTIFICATE_PREVIEW_CONFIG}
        issuingAuthority="ASRA Academy"
        certificateTitle="Certificate of Participation"
        recipientName="Fatima Zahra Al-Khatib"
        bodyText={QUIZORA_2026_DESIGN_2_DEFINITION.defaultBodyText}
        subjectTitle="ASRA QUIZORA – 2026"
        achievementDetails="Score: 96% · Rank #1"
        completedAt="2026-11-14T05:00:00.000Z"
        issuedAt="2026-11-14T10:00:00.000Z"
        certificateNumber="ASRA-2026-PX7B-M4GS"
        verificationUrl={VERIFY_URL}
        signatures={[]}
      />,
    );
    assert.match(html, /data-template-style="QUIZORA_PARTICIPATION_DESIGN_2"/);
    assert.match(html, /href="\/certificates\/quizora-2026-design-2\/artwork\.jpg"/);
    assert.match(html, /href="\/certificates\/quizora-2026-design-2\/statement-patch\.png"/);
    assert.doesNotMatch(html, /quizora-2026\/artwork\.jpg/);
    assert.doesNotMatch(html, /SCAN TO VERIFY/);
    assert.match(html, /Event Coordinator signature required/);
    assert.match(html, /Director signature required/);
    const qr = QUIZORA_2026_DESIGN_2_DEFINITION.layout.qr;
    assert.ok(Math.abs(qr.x + qr.size / 2 - 768) < 10, 'bottom-centre QR');
    assert.doesNotMatch(html, /96%|Score|Rank #1/);
  });
});
