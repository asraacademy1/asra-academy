import { AnnouncementProvider } from '@/components/announcements/announcement-provider';
import { Footer } from '@/components/layout/footer';
import { Navbar } from '@/components/layout/navbar';
import {
  footerNavigation,
  legalNavigation,
  publicHeaderActions,
  publicNavigation,
} from '@/config/navigation';
import { getPublicCareerCategories } from '@/lib/careers';
import { getPublicParticipateSummary } from '@/lib/participate';

/**
 * Shared shell for every public page: header, `<main id="main-content">` (the skip link's target)
 * and footer. Deliberately has NO auth provider or session check — public pages never call the
 * refresh endpoint and are fully usable without signing in. Sign-in lives at /login.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const [careerCategories, participateSummary] = await Promise.all([
    getPublicCareerCategories().catch(() => []),
    getPublicParticipateSummary(),
  ]);

  return (
    <div className="flex min-h-dvh flex-col">
      <AnnouncementProvider audiences={['PUBLIC_VISITORS', 'PARENTS']}>
        <Navbar
          items={publicNavigation}
          secondaryCta={publicHeaderActions.login}
          cta={publicHeaderActions.cta}
        />
        <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
        <Footer
          columns={footerNavigation}
          careerCategories={careerCategories}
          participate={{
            hasCompetitions: participateSummary.competitionsCount > 0,
            hasAssessments: participateSummary.assessmentsCount > 0,
          }}
          legalLinks={legalNavigation}
        />
      </AnnouncementProvider>
    </div>
  );
}
