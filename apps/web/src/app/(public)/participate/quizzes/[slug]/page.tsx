import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicQuizDetailView } from '@/components/public/participate/public-quiz-detail-view';
import { getPublicQuizDetail } from '@/lib/participate';
import { buildPageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ slug: string }> };

/** Rendered per request so unpublishing or switching to PRIVATE removes public access immediately. */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPublicQuizDetail(slug);
  if (!result.ok) return { title: 'Quiz', robots: { index: false, follow: true } };
  const quiz = result.data;
  return buildPageMetadata({
    title: quiz.title,
    description:
      quiz.summary ??
      quiz.description?.slice(0, 160) ??
      `${quiz.title} — academic quiz at ASRA Academy.`,
    path: `/participate/quizzes/${quiz.slug}`,
    ...(quiz.banner ? { image: { url: quiz.banner.url, alt: `${quiz.title} banner` } } : {}),
  });
}

export default async function PublicQuizPage({ params }: Props) {
  const { slug } = await params;
  const result = await getPublicQuizDetail(slug);
  if (!result.ok) {
    if (result.reason === 'not-found') notFound();
    throw new Error(result.message);
  }
  return <PublicQuizDetailView quiz={result.data} />;
}
