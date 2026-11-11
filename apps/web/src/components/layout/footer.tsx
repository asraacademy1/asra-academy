import * as React from 'react';
import { Mail } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

import { Container } from '@/components/layout/container';
import { siteConfig } from '@/config/site';
import type { NavItem } from '@/lib/navigation';
import { cn } from '@/lib/utils';

export type CareerCategoryLink = {
  category: string;
  label: string;
  count?: number;
};

export type ParticipateFooterAvailability = {
  hasCompetitions?: boolean;
  hasAssessments?: boolean;
};

type FooterProps = {
  columns?: { title: string; href?: string; links: NavItem[] }[];
  careerCategories?: CareerCategoryLink[];
  participate?: ParticipateFooterAvailability;
  /** Only pass legal links whose pages exist. */
  legalLinks?: NavItem[];
  className?: string;
};

const linkClasses =
  'rounded-sm text-muted-foreground transition-colors hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

/**
 * Builds the effective footer columns, dynamically expanding the CAREERS section with active
 * categories and the PARTICIPATE section with live/upcoming quizzes and available activities.
 */
export function buildFooterColumns(
  columns: { title: string; href?: string; links: NavItem[] }[],
  careerCategories: CareerCategoryLink[] = [],
  participate: ParticipateFooterAvailability = {},
): { title: string; href?: string; links: NavItem[] }[] {
  let hasCareersColumn = false;
  let hasParticipateColumn = false;

  const participateLinks = (): NavItem[] => [
    { label: 'Live Quizzes', href: '/participate/quizzes?status=live' },
    { label: 'Upcoming Quizzes', href: '/participate/quizzes?status=upcoming' },
    ...(participate.hasCompetitions
      ? [{ label: 'Competitions', href: '/participate/competitions' }]
      : []),
    ...(participate.hasAssessments
      ? [{ label: 'Assessments', href: '/participate/assessments' }]
      : []),
  ];

  const mapped = columns.map((column) => {
    const titleLower = column.title.toLowerCase();
    if (titleLower === 'participate') {
      hasParticipateColumn = true;
      return {
        ...column,
        href: column.href ?? '/participate',
        links: participateLinks(),
      };
    }

    if (titleLower !== 'careers') {
      // Strip any legacy /careers link from other columns so it only lives in the dedicated CAREERS section
      return {
        ...column,
        links: column.links.filter((l) => l.href !== '/careers'),
      };
    }

    hasCareersColumn = true;

    // Base link: "Careers" when no categories, or "All openings" when categories exist
    const baseLink: NavItem =
      careerCategories && careerCategories.length > 0
        ? { label: 'All openings', href: '/careers' }
        : { label: 'Careers', href: '/careers' };

    const categoryLinks: NavItem[] = (careerCategories ?? []).map((c) => ({
      label: c.label,
      href: `/careers?category=${encodeURIComponent(c.category.toLowerCase())}`,
    }));

    return {
      ...column,
      href: column.href ?? '/careers',
      links: [baseLink, ...categoryLinks],
    };
  });

  if (!hasCareersColumn) {
    const baseLink: NavItem =
      careerCategories && careerCategories.length > 0
        ? { label: 'All openings', href: '/careers' }
        : { label: 'Careers', href: '/careers' };

    const categoryLinks: NavItem[] = (careerCategories ?? []).map((c) => ({
      label: c.label,
      href: `/careers?category=${encodeURIComponent(c.category.toLowerCase())}`,
    }));

    mapped.push({
      title: 'Careers',
      href: '/careers',
      links: [baseLink, ...categoryLinks],
    });
  }

  if (!hasParticipateColumn) {
    mapped.push({
      title: 'Participate',
      href: '/participate',
      links: participateLinks(),
    });
  }

  return mapped;
}

/**
 * Site footer: brand, link columns, the confirmed contact email and legal links. Contact details
 * come only from `siteConfig` (client-confirmed) — no invented addresses, phones or socials.
 *
 * Uses a light surface: the supplied logo is dark-on-light only. A dark green footer like the
 * visual reference needs a reversed logo variant (CLIENT-CLARIFICATIONS V-01).
 */
export function Footer({
  columns = [],
  careerCategories = [],
  participate = {},
  legalLinks = [],
  className,
}: FooterProps) {
  const year = new Date().getFullYear();

  const displayColumns = React.useMemo(
    () => buildFooterColumns(columns, careerCategories, participate),
    [columns, careerCategories, participate],
  );

  return (
    <footer data-slot="footer" className={cn('border-t bg-asra-ivory-200', className)}>
      <Container className="grid gap-10 py-12 md:grid-cols-[minmax(0,1.2fr)_repeat(auto-fit,minmax(10rem,1fr))] md:py-16">
        <div className="grid content-start justify-items-start gap-4">
          <Image
            src={siteConfig.logo.full.src}
            width={siteConfig.logo.full.width}
            height={siteConfig.logo.full.height}
            alt={siteConfig.logo.alt}
            // Rendered at w-28 (7rem). Without `sizes` the 1007px intrinsic width produced a
            // 1x/2x srcset and phones fetched the 2048px variant (~160 KB) on every page.
            sizes="7rem"
            className="h-auto w-28"
          />
          <p className="max-w-xs type-body-sm text-muted-foreground">{siteConfig.description}</p>
          <p className="type-body-sm font-medium text-asra-green-700">{siteConfig.foundedBy}</p>
          <a
            href={`mailto:${siteConfig.contact.email}`}
            className={cn('inline-flex items-center gap-2 type-body-sm', linkClasses)}
          >
            <Mail className="size-4" aria-hidden />
            {siteConfig.contact.email}
          </a>
        </div>

        {displayColumns.map((column) => (
          <nav key={column.title} aria-label={column.title} className="grid content-start gap-3">
            <h2 className="type-eyebrow text-asra-gold-800">
              {column.href ? (
                <Link
                  href={column.href}
                  className="rounded-sm transition-colors hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {column.title}
                </Link>
              ) : (
                column.title
              )}
            </h2>
            <ul className="grid gap-2 type-body-sm">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={linkClasses}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </Container>

      <div className="border-t">
        <Container className="flex flex-col gap-3 py-5 type-caption text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {siteConfig.name}. {siteConfig.tagline}
          </p>
          {legalLinks.length > 0 ? (
            <nav aria-label="Legal">
              <ul className="flex flex-wrap gap-x-5 gap-y-2">
                {legalLinks.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className={linkClasses}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </Container>
      </div>
    </footer>
  );
}
