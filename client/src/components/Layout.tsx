import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { User } from '../types';

interface NavItem { to: string; label: string; icon: string; managerOnly?: boolean }

/**
 * The sidebar, in four groups.
 *
 * It reached seventeen entries as one flat list and stopped being scannable —
 * the paperwork, the shop floor and the once-a-year setup pages all read as
 * equally important. Grouping them costs nothing (everything is still one
 * click) and lets the eye skip three quarters of the list.
 *
 * Each group folds. Two things keep a folded page from being a forgotten one:
 * the group holding the current page is always open whatever the stored state
 * says, and a closed group shows how many entries are inside it.
 *
 * Dashboard sits outside any group: it is the landing page, not a category.
 */
const NAV: { heading: string; items: NavItem[] }[] = [
  {
    // Quotation -> Proforma -> Order -> Invoice: the order the desk works in.
    // The proforma is what the buyer confirms against, so it comes before the
    // order it produces, even though a proforma can also be raised from one.
    heading: 'Sales',
    items: [
      { to: '/quotations', label: 'Quotations', icon: '📄' },
      { to: '/proformas', label: 'Proforma Invoices', icon: '🧾' },
      { to: '/orders', label: 'Orders', icon: '📋' },
      // No Packing Lists entry: the commercial invoice owns its packing list,
      // so it is created and edited on the invoice. The pages remain routed for
      // any bookmarked link, but they are no longer a place you navigate to.
      { to: '/invoices', label: 'Commercial Invoices', icon: '💰' },
      { to: '/followups', label: 'Follow-ups', icon: '🔔' },
    ],
  },
  {
    heading: 'Factory',
    items: [
      { to: '/work-orders', label: 'Work Orders', icon: '🔧' },
      { to: '/despatches', label: 'Despatches', icon: '🚚' },
      { to: '/stock', label: 'Stock', icon: '📦' },
      // Supplier rates are not everyone's business, and committing a spend is
      // not a shop-floor action — so purchasing is manager-only, front and back.
      { to: '/purchase-orders', label: 'Purchase Orders', icon: '🛒', managerOnly: true },
    ],
  },
  {
    // The things documents are built *from*, rather than documents themselves.
    heading: 'Records',
    items: [
      { to: '/customers', label: 'Customers', icon: '🏢' },
      { to: '/products', label: 'Products', icon: '🏷️' },
      { to: '/container-planner', label: 'Container Planner', icon: '🚢' },
    ],
  },
  {
    // Set up once and then rarely touched — which is why it sits last, not
    // because it matters least.
    heading: 'Setup',
    items: [
      { to: '/masters', label: 'Production Masters', icon: '🏭', managerOnly: true },
      { to: '/approvals', label: 'Approvals', icon: '✅', managerOnly: true },
      { to: '/team', label: 'Team', icon: '👥', managerOnly: true },
      { to: '/settings', label: 'Settings', icon: '⚙️', managerOnly: true },
    ],
  },
];

const DASHBOARD: NavItem = { to: '/', label: 'Dashboard', icon: '📊' };

/**
 * Which groups are open, remembered between visits.
 *
 * Stored rather than reset each load because the group you work in is a
 * property of your job, not of this page view — a despatch clerk should not
 * have to reopen Factory every morning.
 */
const OPEN_KEY = 'qm.nav.open';

function readOpen(): string[] | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    // A blocked or corrupt localStorage must not take the sidebar down with it.
    return null;
  }
}

export default function Layout({ user, onLogout, children }: { user: User; onLogout: () => void; children: ReactNode }) {
  const isManager = user.role === 'manager';
  const { pathname } = useLocation();

  // The group holding the current page is always open: navigating somewhere and
  // not being able to see where you are would be worse than a long list.
  const activeHeading = NAV.find((g) =>
    g.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))
  )?.heading;

  const [open, setOpen] = useState<string[]>(() => readOpen() ?? [NAV[0].heading]);
  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* not worth failing over */ }
  }, [open]);

  const toggle = (heading: string) =>
    setOpen((prev) => (prev.includes(heading) ? prev.filter((h) => h !== heading) : [...prev, heading]));
  const { data: approvals } = useQuery({
    queryKey: ['approval-count'],
    queryFn: () => api.get<{ pending: number }>('/api/approvals/count'),
    enabled: isManager,
    refetchInterval: 60_000,
  });

  const logout = async () => {
    await api.post('/api/auth/logout');
    onLogout();
  };

  const link = (item: NavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-4 py-1.5 text-sm transition-colors ${
          isActive ? 'bg-white/15 font-medium text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      <span className="text-base leading-none">{item.icon}</span>
      <span className="flex-1">{item.label}</span>
      {item.to === '/approvals' && !!approvals?.pending && (
        <span className="rounded-full bg-amber-400 px-1.5 text-xs font-bold text-slate-900">{approvals.pending}</span>
      )}
    </NavLink>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-56 flex-col bg-brand-800 text-white">
        <div className="border-b border-white/10 px-4 py-4">
          <div className="text-lg font-bold">Quotation Manager</div>
          <div className="text-xs text-white/50">Order-to-Dispatch</div>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {link(DASHBOARD)}
          {NAV.map((group) => {
            const items = group.items.filter((item) => !item.managerOnly || isManager);
            // A group an employee may see nothing in takes no space at all —
            // a heading over an empty list is worse than no heading.
            if (items.length === 0) return null;
            const expanded = open.includes(group.heading) || group.heading === activeHeading;
            return (
              <div key={group.heading} className="mt-2">
                <button
                  type="button"
                  onClick={() => toggle(group.heading)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-1.5 px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-white/40 transition-colors hover:text-white/80"
                >
                  <span className={`inline-block text-[9px] transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
                  <span className="flex-1 text-left">{group.heading}</span>
                  {/* Closed groups say how much is inside, so folding one away
                      does not make you forget what it held. */}
                  {!expanded && <span className="font-normal text-white/30">{items.length}</span>}
                </button>
                {expanded && items.map(link)}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-white/10 px-4 py-3 text-sm">
          <div className="mb-0.5 truncate text-white/80">{user.name}</div>
          <div className="mb-1 text-xs capitalize text-white/40">{user.role}</div>
          <button onClick={logout} className="text-xs text-white/50 hover:text-white">Sign out</button>
        </div>
      </aside>
      <main className="ml-56 flex-1 p-6">{children}</main>
    </div>
  );
}
