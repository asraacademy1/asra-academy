import { programmes } from '@/content/programmes';
import type { NavItem } from '@/lib/navigation';

/**
 * Public website navigation (REQUIREMENTS REQ-PUB-001…015). The brand mark links home, so "Home"
 * is not repeated. Programme links are generated from the catalogue so they never drift from the
 * pages that exist.
 */
const programmeLinks: NavItem[] = programmes.map((programme) => ({
  label: programme.title,
  href: programme.href,
}));

export const publicNavigation: NavItem[] = [
  { label: 'About', href: '/about' },
  {
    label: 'Courses',
    href: '/courses',
    children: [{ label: 'All courses', href: '/courses', exact: true }, ...programmeLinks],
  },
  { label: 'Faculty', href: '/faculty' },
  { label: 'Admission', href: '/admission' },
  {
    label: 'Participate',
    href: '/participate',
    children: [
      { label: 'Quizzes', href: '/participate/quizzes' },
      { label: 'Competitions', href: '/participate/competitions' },
      { label: 'Assessments', href: '/participate/assessments' },
    ],
  },
  { label: 'Careers', href: '/careers' },
  { label: 'Contact', href: '/contact' },
];

/** Header actions: sign-in for existing students, enquiry for visitors. */
export const publicHeaderActions = {
  login: { label: 'Login', href: '/login' },
  cta: { label: 'Enquire now', href: '/contact' },
} as const;

export const footerNavigation: { title: string; href?: string; links: NavItem[] }[] = [
  {
    title: 'Learn',
    links: [{ label: 'All courses', href: '/courses' }, ...programmeLinks],
  },
  {
    title: 'Academy',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Faculty', href: '/faculty' },
      { label: 'Admission', href: '/admission' },
      { label: 'Blog', href: '/blog' },
      { label: 'Contact', href: '/contact' },
      { label: 'Student login', href: '/login' },
    ],
  },
  {
    title: 'Careers',
    href: '/careers',
    links: [{ label: 'All openings', href: '/careers' }],
  },
  {
    title: 'Participate',
    href: '/participate',
    links: [
      { label: 'Live Quizzes', href: '/participate/quizzes?status=live' },
      { label: 'Upcoming Quizzes', href: '/participate/quizzes?status=upcoming' },
    ],
  },
];

/** Legal pages are mandatory (REQ-PUB-013…015); their text is pending from the client (U-01). */
export const legalNavigation: NavItem[] = [
  { label: 'Privacy Policy', href: '/privacy-policy' },
  { label: 'Terms and Conditions', href: '/terms' },
  { label: 'Refund Policy', href: '/refund-policy' },
];
