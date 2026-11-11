'use client';

import { ChevronDown, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { BrandMark } from '@/components/layout/brand-mark';
import { Container } from '@/components/layout/container';
import { SkipLink } from '@/components/layout/skip-link';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { isActiveNavItem, isActivePath, type NavItem } from '@/lib/navigation';
import { cn } from '@/lib/utils';

type NavbarProps = {
  items: NavItem[];
  /** Primary call to action (e.g. "Login / Register"). */
  cta?: { label: string; href: string };
  /** Secondary link-button before the CTA (e.g. "Login"). Also shown in the mobile drawer. */
  secondaryCta?: { label: string; href: string };
  /**
   * Extra actions on the right (e.g. a signed-in user menu). Rendered as given; session-aware
   * content must come from a component inside the auth provider.
   */
  actions?: React.ReactNode;
  brandHref?: string;
  /** Disable the sticky behaviour (e.g. inside previews). */
  sticky?: boolean;
  className?: string;
};

const desktopLinkClasses =
  'relative inline-flex h-control-sm items-center gap-1 rounded-full px-3.5 type-label transition-colors outline-none hover:bg-secondary hover:text-secondary-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50';
const desktopActiveClasses =
  'text-primary after:absolute after:inset-x-3.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-asra-gold-500';

/**
 * Public site header. Desktop: inline links; items with `children` open a disclosure menu
 * (button + list of links — the WAI-ARIA disclosure navigation pattern, not an application menu).
 * Below `lg`: a menu button opens a focus-trapped drawer (Escape closes it and focus returns to
 * the button). Active links use `aria-current`.
 */
export function Navbar({
  items,
  cta,
  secondaryCta,
  actions,
  brandHref = '/',
  sticky = true,
  className,
}: NavbarProps) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // Close the drawer when a link inside it is followed.
  function closeOnLink(event: React.MouseEvent) {
    if ((event.target as Element).closest('a')) setOpen(false);
  }

  return (
    <header
      data-slot="navbar"
      className={cn('z-40 border-b bg-asra-warm-white', sticky && 'sticky top-0', className)}
    >
      <SkipLink />
      <Container className="flex h-topbar items-center gap-4">
        <BrandMark href={brandHref} />

        <nav aria-label="Main" className="ml-auto hidden lg:block">
          <ul className="flex items-center gap-1">
            {items.map((item) => {
              const active = isActiveNavItem(pathname, item);
              return (
                <li key={item.href} className="relative">
                  {item.children?.length ? (
                    <NavDisclosure item={item} active={active} pathname={pathname} />
                  ) : (
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        desktopLinkClasses,
                        active ? desktopActiveClasses : 'text-foreground',
                      )}
                    >
                      {item.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-2">
          {actions}
          {secondaryCta ? (
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link href={secondaryCta.href}>{secondaryCta.label}</Link>
            </Button>
          ) : null}
          {cta ? (
            <Button asChild variant="accent" size="sm" className="hidden sm:inline-flex">
              <Link href={cta.href}>{cta.label}</Link>
            </Button>
          ) : null}

          <Drawer open={open} onOpenChange={setOpen}>
            <DrawerTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu className="size-5" aria-hidden />
              </Button>
            </DrawerTrigger>
            <DrawerContent side="right" onClick={closeOnLink}>
              <DrawerHeader>
                <DrawerTitle>Menu</DrawerTitle>
                <DrawerDescription className="sr-only">Site navigation</DrawerDescription>
              </DrawerHeader>
              <DrawerBody>
                <nav aria-label="Main">
                  <ul className="grid gap-1">
                    {items.map((item) => (
                      <li key={item.href}>
                        {item.children?.length ? (
                          <>
                            <p className="px-3 pt-3 pb-1 type-eyebrow text-asra-gold-800">
                              {item.label}
                            </p>
                            <ul className="grid gap-0.5">
                              {item.children.map((child) => (
                                <li key={`${child.href}-${child.label}`}>
                                  <DrawerLink item={child} pathname={pathname} nested />
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : (
                          <DrawerLink item={item} pathname={pathname} />
                        )}
                      </li>
                    ))}
                  </ul>
                </nav>
              </DrawerBody>
              {cta || secondaryCta ? (
                <DrawerFooter>
                  {secondaryCta ? (
                    <Button asChild variant="outline" className="w-full">
                      <Link href={secondaryCta.href}>{secondaryCta.label}</Link>
                    </Button>
                  ) : null}
                  {cta ? (
                    <Button asChild variant="accent" className="w-full">
                      <Link href={cta.href}>{cta.label}</Link>
                    </Button>
                  ) : null}
                </DrawerFooter>
              ) : null}
            </DrawerContent>
          </Drawer>
        </div>
      </Container>
    </header>
  );
}

function DrawerLink({
  item,
  pathname,
  nested = false,
}: {
  item: NavItem;
  pathname: string | null;
  nested?: boolean;
}) {
  const active = isActivePath(pathname, item.href, item.exact);
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-control items-center rounded-lg border-l-4 px-3 font-medium transition-colors outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50',
        nested ? 'type-body-sm' : 'type-body',
        active
          ? 'border-asra-gold-500 bg-secondary text-primary'
          : 'border-transparent text-foreground',
      )}
    >
      {item.label}
    </Link>
  );
}

/**
 * Desktop disclosure for a nav item with children. Opens on click / Enter / Space; closes on
 * Escape (focus returns to the button), on a click outside, when focus leaves it, or when one of
 * its links is followed.
 */
function NavDisclosure({
  item,
  active,
  pathname,
}: {
  item: NavItem;
  active: boolean;
  pathname: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const lastHoverOpenAt = React.useRef(0);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = React.useId();

  const clearCloseTimer = React.useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  React.useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const compact = (item.children?.length ?? 0) <= 4;

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => {
        clearCloseTimer();
        if (!open) {
          lastHoverOpenAt.current = Date.now();
          setOpen(true);
        }
      }}
      onMouseLeave={() => {
        clearCloseTimer();
        closeTimer.current = setTimeout(() => setOpen(false), 120);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={(event) => {
          // If pointer hover opened the menu right before click, keep it open rather than immediately closing.
          if (open && event.detail > 0 && Date.now() - lastHoverOpenAt.current < 300) {
            return;
          }
          setOpen((value) => !value);
        }}
        className={cn(
          desktopLinkClasses,
          'cursor-pointer',
          active ? desktopActiveClasses : 'text-foreground',
        )}
      >
        {item.label}
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 transition-transform duration-150 ease-standard',
            open && 'rotate-180',
          )}
        />
      </button>
      <div
        id={panelId}
        hidden={!open}
        onClick={(event) => {
          if ((event.target as Element).closest('a')) setOpen(false);
        }}
        className={cn(
          'absolute top-full left-1/2 z-50 -translate-x-1/2 pt-2',
          compact ? 'w-56' : 'w-[min(34rem,calc(100vw-2rem))]',
        )}
      >
        <div className="rounded-xl border bg-popover p-2 shadow-raised motion-safe:animate-scale-in">
          <ul className={cn('grid gap-0.5', !compact && 'sm:grid-cols-2')}>
            {item.children?.map((child) => {
              const childActive = isActivePath(pathname, child.href, child.exact);
              return (
                <li key={`${child.href}-${child.label}`}>
                  <Link
                    href={child.href}
                    aria-current={childActive ? 'page' : undefined}
                    className={cn(
                      'flex min-h-control-sm items-center rounded-lg px-3 py-2 type-body-sm font-medium transition-colors outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      childActive ? 'bg-secondary text-primary' : 'text-foreground',
                    )}
                  >
                    {child.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
