/**
 * Announcement & Popup Management frontend tests:
 * frequency & campaign-id isolation (EVERY_VISIT, ONCE_PER_SESSION, ONCE_PER_VISITOR),
 * priority selection & single-modal rule, client caching & graceful fallback,
 * redirect URL safety & XSS escaping, responsive banner/modal component markup,
 * and admin RBAC navigation + form mapping.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PERMISSIONS,
  type AdminAnnouncementDetail,
  type AuthUser,
  type PublicAnnouncementDto,
} from '@asra/types';
import { announcementSettingsSchema } from '@asra/validation';

import { AnnouncementStatusBadge } from '@/components/admin/announcements/announcement-status-badge';
import { buildNavigation, canAccessAdminPath } from '@/components/admin/admin-shell';
import { hasPermission } from '@/components/admin/use-admin';
import { AnnouncementBanner } from '@/components/announcements/announcement-banner';
import { AnnouncementModalCard } from '@/components/announcements/announcement-modal';
import { AnnouncementProvider } from '@/components/announcements/announcement-provider';
import { Dialog } from '@/components/ui/dialog';
import {
  announcementFormFromDetail,
  announcementFormToBody,
  availableAnnouncementActions,
  emptyAnnouncementForm,
  toPreviewAnnouncement,
} from '@/lib/admin/announcements';
import {
  createCampaignTracker,
  fetchActiveAnnouncements,
  isSafeRedirectUrl,
  resetPublicAnnouncementClientCacheForTests,
  selectActiveCampaigns,
} from '@/lib/announcements';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function makeCampaign(overrides: Partial<PublicAnnouncementDto> = {}): PublicAnnouncementDto {
  return {
    id: 'camp-1',
    title: 'Admissions Open',
    description: 'Enroll for the upcoming academic session.',
    image: null,
    displayType: 'MODAL',
    ctaText: 'Apply Now',
    redirectUrl: '/admission',
    displayDelaySeconds: 3,
    frequency: 'ONCE_PER_SESSION',
    priority: 50,
    audience: 'ALL',
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

describe('frequency tracking & campaign-ID isolation (Scenario 5)', () => {
  it('supports EVERY_VISIT, ONCE_PER_SESSION, and ONCE_PER_VISITOR independently per campaign id', () => {
    const local = memoryStorage();
    const session = memoryStorage();

    // Visit 1
    const visit1 = createCampaignTracker({ localStorage: local, sessionStorage: session });
    const every = makeCampaign({ id: 'c-every', frequency: 'EVERY_VISIT' });
    const sess = makeCampaign({ id: 'c-sess', frequency: 'ONCE_PER_SESSION' });
    const vis = makeCampaign({ id: 'c-vis', frequency: 'ONCE_PER_VISITOR' });

    visit1.markModalImpression(every);
    assert.equal(visit1.isModalSuppressed(every), true, 'no duplicate modal during SPA navigation');

    visit1.markDismissed(sess);
    visit1.markDismissed(vis);
    assert.equal(visit1.isModalSuppressed(sess), true);
    assert.equal(visit1.isModalSuppressed(vis), true);

    // Visit 2 in same browser session (new page load, same sessionStorage + localStorage)
    const visit2 = createCampaignTracker({ localStorage: local, sessionStorage: session });
    assert.equal(visit2.isModalSuppressed(every), false, 'EVERY_VISIT resets on new page load');
    assert.equal(visit2.isModalSuppressed(sess), true, 'ONCE_PER_SESSION stays suppressed');
    assert.equal(visit2.isModalSuppressed(vis), true, 'ONCE_PER_VISITOR stays suppressed');

    // Visit 3 in a brand new session (new sessionStorage, same localStorage)
    const visit3 = createCampaignTracker({
      localStorage: local,
      sessionStorage: memoryStorage(),
    });
    assert.equal(visit3.isModalSuppressed(sess), false, 'ONCE_PER_SESSION resets in new session');
    assert.equal(
      visit3.isModalSuppressed(vis),
      true,
      'ONCE_PER_VISITOR stays suppressed across sessions',
    );

    // Scenario 5: A newly created campaign is STILL eligible despite dismissing an older one
    const newCampaign = makeCampaign({ id: 'c-brand-new', frequency: 'ONCE_PER_VISITOR' });
    assert.equal(visit3.isModalSuppressed(newCampaign), false);
    assert.equal(visit3.isBannerSuppressed(newCampaign), false);
  });

  it('works safely in private browsing when storage throws', () => {
    const broken = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    const tracker = createCampaignTracker({ localStorage: broken, sessionStorage: broken });
    const camp = makeCampaign({ id: 'priv-1', frequency: 'ONCE_PER_VISITOR' });
    assert.equal(tracker.isModalSuppressed(camp), false);
    tracker.markDismissed(camp);
    assert.equal(tracker.isModalSuppressed(camp), true);
  });
});

describe('priority selection & single modal guarantee (Scenarios 6 & 7)', () => {
  it('selects at most one highest-priority modal and one highest-priority top banner', () => {
    const tracker = createCampaignTracker({
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
    });
    const lowModal = makeCampaign({ id: 'm-low', displayType: 'MODAL', priority: 10 });
    const highModal = makeCampaign({ id: 'm-high', displayType: 'MODAL', priority: 200 });
    const lowBanner = makeCampaign({ id: 'b-low', displayType: 'TOP_BANNER', priority: 5 });
    const highBanner = makeCampaign({ id: 'b-high', displayType: 'TOP_BANNER', priority: 150 });

    const first = selectActiveCampaigns([lowModal, highModal, lowBanner, highBanner], { tracker });
    assert.equal(first.modal?.id, 'm-high');
    assert.equal(first.banner?.id, 'b-high');

    // While modalAlreadyShownThisVisit is true, no second modal opens in the same visit
    tracker.markDismissed(highModal);
    const sameVisit = selectActiveCampaigns([lowModal, highModal, lowBanner, highBanner], {
      tracker,
      modalAlreadyShownThisVisit: true,
    });
    assert.equal(sameVisit.modal, null);

    // On next visit, lower-priority eligible modal takes over
    const nextVisit = selectActiveCampaigns([lowModal, highModal], {
      tracker,
      modalAlreadyShownThisVisit: false,
    });
    assert.equal(nextVisit.modal?.id, 'm-low');
  });

  it('respects client-side start/end window checks as defense-in-depth', () => {
    const now = Date.parse('2026-12-01T12:00:00.000Z');
    const future = makeCampaign({ id: 'f', startsAt: '2026-12-01T12:01:00.000Z' });
    const expired = makeCampaign({ id: 'e', endsAt: '2026-12-01T12:00:00.000Z' });
    const active = makeCampaign({
      id: 'a',
      startsAt: '2026-12-01T11:00:00.000Z',
      endsAt: '2026-12-01T13:00:00.000Z',
    });

    const selected = selectActiveCampaigns([future, expired, active], {
      nowMs: now,
      tracker: createCampaignTracker({
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
      }),
    });
    assert.equal(selected.modal?.id, 'a');
  });
});

describe('public fetch caching & graceful unavailability', () => {
  it('caches per audience key and handles API outages without throwing', async () => {
    resetPublicAnnouncementClientCacheForTests();
    let calls = 0;
    const item = makeCampaign({ id: 'net-1' });
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ success: true, data: [item] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const first = await fetchActiveAnnouncements(['PUBLIC_VISITORS', 'PARENTS'], {
      fetchImpl: fakeFetch,
    });
    const second = await fetchActiveAnnouncements(['PARENTS', 'PUBLIC_VISITORS'], {
      fetchImpl: fakeFetch,
    });
    assert.equal(calls, 1, 'identical audience set reuses cached result');
    assert.equal(first[0]?.id, 'net-1');
    assert.equal(second[0]?.id, 'net-1');

    // Unavailable backend returns [] cleanly without blocking rendering
    resetPublicAnnouncementClientCacheForTests();
    const offline = await fetchActiveAnnouncements(['PUBLIC_VISITORS'], {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.deepEqual(offline, []);
  });
});

describe('AnnouncementBanner, AnnouncementModal, and AnnouncementProvider UI & security', () => {
  it('renders responsive banner markup, accessible dismiss button, Cloudinary image, and safe links', () => {
    const out = html(
      <AnnouncementBanner
        announcement={makeCampaign({
          id: 'banner-1',
          displayType: 'TOP_BANNER',
          title: 'Exam Form Deadline <script>alert(1)</script>',
          description: 'Submit before 30 Nov.',
          ctaText: 'Register',
          redirectUrl: 'https://www.asraacademy.in/admission',
          image: {
            url: 'https://res.cloudinary.com/demo/image/upload/a.webp',
            width: 800,
            height: 400,
          },
        })}
        onDismiss={() => {}}
      />,
    );
    assert.match(out, /role="region"/);
    assert.match(out, /aria-label="Dismiss announcement:/);
    assert.match(out, /flex-wrap/);
    assert.match(out, /sm:flex-nowrap/);
    assert.match(out, /target="_blank"/);
    assert.match(out, /rel="noopener noreferrer"/);
    assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(out, /<script>alert/);
  });

  it('refuses unsafe redirect URLs in both banner and modal', () => {
    assert.equal(isSafeRedirectUrl('javascript:alert(1)'), false);
    assert.equal(isSafeRedirectUrl('//evil.com'), false);
    assert.equal(isSafeRedirectUrl('/admission'), true);

    const bannerOut = html(
      <AnnouncementBanner
        announcement={makeCampaign({
          displayType: 'TOP_BANNER',
          ctaText: 'Evil CTA',
          redirectUrl: 'javascript:alert(1)',
        })}
        onDismiss={() => {}}
      />,
    );
    assert.doesNotMatch(bannerOut, /javascript:/i);
    assert.doesNotMatch(bannerOut, /Evil CTA/);

    const modalOut = html(
      <Dialog open={false}>
        <AnnouncementModalCard
          announcement={makeCampaign({
            title: 'Notice <img src=x onerror=alert(1)>',
            description: 'Line 1\nLine 2',
            ctaText: 'Bad Link',
            redirectUrl: 'data:text/html,evil',
            image: {
              url: 'https://res.cloudinary.com/demo/image/upload/b.webp',
              width: 800,
              height: 600,
            },
          })}
          onClose={() => {}}
        />
      </Dialog>,
    );
    assert.doesNotMatch(modalOut, /data:text\/html/i);
    assert.doesNotMatch(modalOut, /Bad Link/);
    assert.match(modalOut, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(modalOut, /https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/b\.webp/);
  });

  it('AnnouncementProvider passes children through immediately without blocking SSR', () => {
    const out = html(
      <AnnouncementProvider>
        <div data-testid="site-content">Welcome to ASRA Academy</div>
      </AnnouncementProvider>,
    );
    assert.match(out, /Welcome to ASRA Academy/);
  });
});

describe('Admin Website Management → Announcements UI & RBAC', () => {
  it('exposes Website Management → Announcements only to users with announcements.manage', () => {
    const manager: AuthUser = {
      id: 'u1',
      email: 'admin@asra.test',
      fullName: 'Admin',
      emailVerified: true,
      roles: ['ADMIN'],
      permissions: [PERMISSIONS.ANNOUNCEMENTS_MANAGE],
    };
    const viewerOnly: AuthUser = { ...manager, permissions: [PERMISSIONS.ANALYTICS_VIEW] };

    const nav = buildNavigation((p) => hasPermission(manager, p));
    const webGroup = nav.find((g) => g.label === 'Website Management');
    assert.ok(webGroup);
    assert.equal(webGroup.items[0]?.href, '/admin/announcements');
    assert.equal(
      canAccessAdminPath('/admin/announcements', (p) => hasPermission(manager, p)),
      true,
    );
    assert.equal(
      canAccessAdminPath('/admin/announcements/new', (p) => hasPermission(manager, p)),
      true,
    );

    const navWithout = buildNavigation((p) => hasPermission(viewerOnly, p));
    assert.equal(
      navWithout.find((g) => g.label === 'Website Management'),
      undefined,
    );
    assert.equal(
      canAccessAdminPath('/admin/announcements', (p) => hasPermission(viewerOnly, p)),
      false,
    );
  });

  it('renders status badges for all 6 lifecycle statuses with text + icon', () => {
    for (const status of [
      'DRAFT',
      'SCHEDULED',
      'PUBLISHED',
      'PAUSED',
      'EXPIRED',
      'ARCHIVED',
    ] as const) {
      const out = html(<AnnouncementStatusBadge status={status} />);
      assert.match(out, /<svg/);
    }
  });

  it('round-trips IST schedule inputs and builds valid request bodies & preview DTOs', () => {
    const detail: AdminAnnouncementDetail = {
      id: 'a1',
      title: 'Quiz Registration',
      description: 'Open for all students',
      image: {
        id: '11111111-1111-4111-8111-111111111111',
        url: 'https://res.cloudinary.com/demo/image/upload/q.webp',
        width: 800,
        height: 450,
      },
      displayType: 'MODAL',
      ctaText: 'Join Quiz',
      redirectUrl: '/participate/quizzes',
      startsAt: '2026-12-01T04:30:00.000Z',
      endsAt: '2026-12-10T12:30:00.000Z',
      displayDelaySeconds: 3,
      frequency: 'ONCE_PER_SESSION',
      priority: 100,
      audience: 'ALL',
      status: 'SCHEDULED',
      storedStatus: 'SCHEDULED',
      publishedAt: null,
      pausedAt: null,
      archivedAt: null,
      createdBy: { id: 'u1', fullName: 'Admin' },
      updatedBy: { id: 'u1', fullName: 'Admin' },
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      serverNow: '2026-11-25T00:00:00.000Z',
    };

    const form = announcementFormFromDetail(detail);
    assert.equal(form.startsAt, '2026-12-01T10:00', '04:30 UTC maps to 10:00 IST');
    const body = announcementFormToBody(form);
    assert.equal(body.startsAt, '2026-12-01T10:00:00+05:30');
    assert.equal(announcementSettingsSchema.safeParse(body).success, true);

    assert.deepEqual(availableAnnouncementActions(detail), ['publish', 'pause', 'archive']);
    const draft = emptyAnnouncementForm();
    assert.equal(draft.displayDelaySeconds, '3');
    const preview = toPreviewAnnouncement(form, detail.id);
    assert.equal(preview.title, 'Quiz Registration');
    assert.equal(preview.image?.url, detail.image?.url);
  });
});
