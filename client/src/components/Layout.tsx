import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { teamRoleLabel, type User } from '../types';
import { useCan } from '../App';
import { Icon, type IconName } from './icons';

/**
 * `needs` is the function this entry belongs to. Every entry carries one — an
 * entry with none would be visible to every team, which is the wrong default
 * for a nav that now differs per person.
 *
 * `null` is that default declined **on purpose**, and it is written as a value
 * rather than as a missing key so it cannot happen by forgetting. Exactly one
 * entry takes it: *My Access*, which tells you what your team may do and so
 * has to reach the team that may do least. There is no function to gate it on
 * that would work — since the matrix became editable, any cell can be unticked
 * — and a page explaining a refusal that is itself refused explains nothing.
 */
interface NavItem { to: string; label: string; icon: IconName; needs: string | null }

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
      // Before quotations: an enquiry is what arrives first, and the desk
      // works down this list in the order the work happens.
      { to: '/enquiries', label: 'Enquiries', icon: 'enquiry', needs: 'enquiry' },
      { to: '/quotations', label: 'Quotations', icon: 'document', needs: 'quotation' },
      { to: '/proformas', label: 'Proforma Invoices', icon: 'receipt', needs: 'proforma' },
      { to: '/orders', label: 'Sales Orders', icon: 'clipboard', needs: 'order' },
      // Between the order and the invoice, which is where a dispatch sits in
      // the chain (2026-09-14, at the client's word). It is also where a trip
      // is recorded now that the order's own tab is read-only.
      { to: '/despatches', label: 'Dispatches', icon: 'truck', needs: 'dispatch' },
      // No Packing Lists entry: the commercial invoice owns its packing list,
      // so it is created and edited on the invoice. The pages remain routed for
      // any bookmarked link, but they are no longer a place you navigate to.
      { to: '/invoices', label: 'Commercial Invoices', icon: 'invoice', needs: 'invoice' },
      // The invoice being partly taken back — a return, or a rate settled
      // down after the fact — so it sits with the invoice and on its function.
      // Credit Notes left the sidebar on 2026-09-20 at the client's word
      // ("Remove credit note"); the routes stay so a note on file still
      // opens from the invoice it credits, the approvals queue and Activity.
      // Money in, beside the documents it is banked against. Sales and the
      // super admin hold `payment`; nobody on the floor does.
      { to: '/payments', label: 'Payments', icon: 'coins', needs: 'payment' },
      { to: '/followups', label: 'Follow-ups', icon: 'bell', needs: 'followup' },
      // What the open jobs will consume, by start date — asked for under Sales
      // (2026-09-14), where the desk plans buying against the order book. The
      // figure is the material function's, so it shows for whoever holds it.
      { to: '/material-required', label: 'Raw Material Required', icon: 'box', needs: 'material' },
      // The desk's own pivot sheets — planned for production, yet to be
      // scheduled, dispatch by month, and what is due — as linked tables
      // (2026-09-15). Three of the four are proforma figures, hence the cell.
      { to: '/reports', label: 'Reports', icon: 'chart', needs: 'proforma' },
    ],
  },
  {
    heading: 'Factory',
    items: [
      { to: '/work-orders', label: 'Work Orders', icon: 'wrench', needs: 'work_order' },
      { to: '/quality', label: 'Quality', icon: 'gauge', needs: 'qc' },
      { to: '/stock', label: 'Stock', icon: 'box', needs: 'material' },
      // Finished goods on the shelf — its own function, since Logistics holds
      // it and holds no `material`.
      { to: '/finished-goods', label: 'Finished Goods', icon: 'box', needs: 'fg' },
      // Supplier rates are not everyone's business, and committing a spend is
      // not a shop-floor action — so purchasing is the super admin's, front and back.
      { to: '/purchase-orders', label: 'Purchase Orders', icon: 'cart', needs: 'purchasing' },
    ],
  },
  {
    // The things documents are built *from*, rather than documents themselves.
    heading: 'Records',
    items: [
      { to: '/customers', label: 'Customers', icon: 'building', needs: 'customer' },
      { to: '/products', label: 'Products', icon: 'tag', needs: 'product' },
      { to: '/container-planner', label: 'Container Planner', icon: 'ship', needs: 'product' },
    ],
  },
  {
    // Set up once and then rarely touched — which is why it sits last, not
    // because it matters least.
    heading: 'Setup',
    items: [
      // Read by every team, changed by the super admin — so the page is shown
      // wherever it is useful and its controls are what differ.
      { to: '/masters', label: 'Production Masters', icon: 'factory', needs: 'master' },
      { to: '/approvals', label: 'Approvals', icon: 'check', needs: 'approval' },
      // The whole trail. A document's own history sits on the document, where
      // whoever owns it can read it without being a manager.
      { to: '/activity', label: 'Activity', icon: 'clock', needs: 'audit' },
      { to: '/team', label: 'Team', icon: 'users', needs: 'team' },
      // Who may do what. Beside the accounts it governs, and on the same cell.
      { to: '/permissions', label: 'User Permissions', icon: 'lock', needs: 'team' },
      { to: '/settings', label: 'Settings', icon: 'cog', needs: 'settings' },
      // Last, and the one entry with no gate: what your own team may do, for
      // whoever has just been refused something and wants to know why.
      { to: '/my-access', label: 'My Access', icon: 'key', needs: null },
    ],
  },
];

const DASHBOARD: NavItem = { to: '/', label: 'Dashboard', icon: 'dashboard', needs: 'dashboard' };

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

/**
 * Whether the sidebar is folded down to a rail of icons.
 *
 * Remembered for the same reason the open groups are: somebody working across
 * a wide order-lines table wants the width back on every page, not once.
 *
 * **A rail, not a disappearance.** Every nav entry already carries an icon, so
 * folding to 56px gives back 168px of table while leaving every page one click
 * away; hiding the sidebar outright would trade navigation for space and leave
 * nothing to click but the button that brings it back.
 *
 * **Desktop only.** Below `md` the sidebar is already a drawer that takes no
 * width at all, so there is nothing to reclaim — every class below is `md:`
 * scoped, and the drawer opens at full width whatever this says.
 */
const RAIL_KEY = 'qm.nav.rail';

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

export default function Layout({ user, onLogout, children }: { user: User; onLogout: () => void; children: ReactNode }) {
  const can = useCan();
  /** Drawn for this team? Stated once, since both the rail and the groups ask. */
  const visible = (item: NavItem) => item.needs === null || can(item.needs);
  const { pathname } = useLocation();

  // The group holding the current page is always open: navigating somewhere and
  // not being able to see where you are would be worse than a long list.
  const activeHeading = NAV.find((g) =>
    g.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))
  )?.heading;

  /**
   * The sidebar is a drawer below `md` and a fixed column above it.
   *
   * One piece of state, not two layouts: the same markup slides in and out on
   * a phone and sits still on a laptop. Closing on every navigation is the
   * part that is easy to forget — tapping a link and being left staring at the
   * menu you tapped it in is the classic version of this bug.
   */
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [pathname]);

  const [open, setOpen] = useState<string[]>(() => readOpen() ?? [NAV[0].heading]);
  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* not worth failing over */ }
  }, [open]);

  const toggle = (heading: string) =>
    setOpen((prev) => (prev.includes(heading) ? prev.filter((h) => h !== heading) : [...prev, heading]));

  const [rail, setRail] = useState<boolean>(readRail);
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, rail ? '1' : '0'); } catch { /* not worth failing over */ }
  }, [rail]);
  const { data: approvals } = useQuery({
    queryKey: ['approval-count'],
    queryFn: () => api.get<{ pending: number }>('/api/approvals/count'),
    enabled: can('approval'),
    refetchInterval: 60_000,
  });
  /*
   * Follow-ups due today or overdue (2026-09-20, the client: "if a customer
   * ask to follow up the user gets a notification"). The dashboard has
   * always listed them, but only the dashboard; this puts the count on the
   * sidebar entry on every page, refreshed each minute so a chase that
   * turns due while the app sits open shows up without a reload. Keyed
   * under `['followups', …]` so scheduling or closing one anywhere refreshes
   * it by prefix.
   */
  const { data: chases } = useQuery({
    queryKey: ['followups', 'count'],
    queryFn: () => api.get<{ due: number; overdue: number }>('/api/followups/count'),
    enabled: can('followup'),
    refetchInterval: 60_000,
  });
  /** What each entry's badge says, and how urgently: only the two that have one. */
  const badge = (to: string): { count: number; tone: string; title: string } | null => {
    if (to === '/approvals' && approvals?.pending) {
      return { count: approvals.pending, tone: 'bg-amber-400 text-slate-900', title: `${approvals.pending} awaiting approval` };
    }
    if (to === '/followups' && chases?.due) {
      return chases.overdue
        ? { count: chases.due, tone: 'bg-red-500 text-white', title: `${chases.due} follow-ups due, ${chases.overdue} overdue` }
        : { count: chases.due, tone: 'bg-amber-400 text-slate-900', title: `${chases.due} follow-ups due today` };
    }
    return null;
  };
  const headerBadges = [badge('/approvals'), badge('/followups')].filter((b): b is NonNullable<typeof b> => !!b);

  const logout = async () => {
    await api.post('/api/auth/logout');
    onLogout();
  };

  /**
   * `extra` carries the one case the rail changes: an item in a *folded* group.
   * On the rail there is no heading to unfold, so those items still have to be
   * reachable — they render `hidden md:flex`, which shows them in the rail and
   * keeps the phone drawer honouring the fold the user actually chose.
   */
  const link = (item: NavItem, extra = '') => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === '/'}
      // The label is the tooltip on the rail, where it is the only thing left.
      title={item.label}
      className={({ isActive }) =>
        `relative mx-2 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${extra} ${
          rail ? 'md:mx-1.5 md:justify-center md:gap-0 md:px-0' : ''
        } ${isActive ? 'bg-white/12 font-medium text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}`
      }
    >
      {({ isActive }) => (
        <>
          {/* The accent that says which row you are on, and the only thing
              that still says it once the pill is dimmed by a hover next door. */}
          {isActive && <span className="absolute inset-y-1.5 -left-1 w-0.5 rounded-full bg-brand-400" aria-hidden="true" />}
          <Icon name={item.icon} />
          <span className={`flex-1 ${rail ? 'md:hidden' : ''}`}>{item.label}</span>
          {(() => {
            const b = badge(item.to);
            if (!b) return null;
            return (
              <>
                <span className={`rounded-full px-1.5 text-xs font-bold ${b.tone} ${rail ? 'md:hidden' : ''}`} title={b.title}>
                  {b.count}
                </span>
                {/* The count will not fit on the rail, but "there is something
                    waiting" still has to survive the fold. */}
                {rail && <span className={`ml-0.5 hidden h-1.5 w-1.5 shrink-0 rounded-full md:block ${b.tone.split(' ')[0]}`} aria-hidden="true" />}
              </>
            );
          })()}
        </>
      )}
    </NavLink>
  );

  return (
    <div className="flex min-h-screen">
      {/*
        The bar that only exists on a phone. It carries the menu button and the
        app's name, and it is `sticky` rather than `fixed` so it scrolls out of
        the way on a long list instead of eating 44px of a 660px screen for
        ever.
      */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-12 items-center gap-3 bg-brand-800 px-3 text-white md:hidden">
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-label="Open the menu"
          aria-expanded={drawer}
          className="rounded-lg p-1.5 hover:bg-white/10"
        >
          <Icon name="menu" size={18} />
        </button>
        <span className="font-semibold">ERP Tool</span>
        {headerBadges.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            {headerBadges.map((b) => (
              <span key={b.title} className={`rounded-full px-1.5 text-xs font-bold ${b.tone}`} title={b.title}>{b.count}</span>
            ))}
          </span>
        )}
      </header>

      {/*
        Tapping beside the drawer closes it. Only rendered while it is open, so
        it cannot swallow a click on the page the rest of the time.
      */}
      {drawer && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setDrawer(false)}
          aria-hidden="true"
        />
      )}

      {/*
        Shown or hidden, not slid.
        `-translate-x-full` / `translate-x-0` was the first attempt and it did
        not work: Tailwind v4 routes those through `--tw-translate-x` and the
        `translate` property, and with a `md:` variant of the same utility on
        the element the custom property resolved to `0px` while the computed
        `translate` stayed `-100%`. The panel never moved. Toggling `flex`
        against `hidden` has no such indirection — the cost is the slide
        animation, which is not worth an hour of cascade archaeology.
      */}
      <aside
        className={`nav-ground fixed inset-y-0 left-0 z-40 w-56 flex-col text-white md:flex ${
          drawer ? 'flex' : 'hidden'
        } ${rail ? 'md:w-14' : 'md:w-56'}`}
      >
        <div className={`flex items-center gap-2 border-b border-white/10 px-4 py-4 ${rail ? 'md:px-0' : ''}`}>
          <div className={`min-w-0 flex-1 ${rail ? 'md:hidden' : ''}`}>
            <div className="text-lg font-bold">ERP Tool</div>
            <div className="text-xs text-white/50">Order-to-Dispatch</div>
          </div>
          {/* Desktop only: below md the sidebar is a drawer and takes no width,
              so there is nothing to reclaim and nothing to fold. */}
          <button
            type="button"
            onClick={() => setRail((r) => !r)}
            aria-label={rail ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-expanded={!rail}
            title={rail ? 'Expand the sidebar' : 'Collapse the sidebar'}
            className={`hidden shrink-0 rounded p-1 text-white/50 transition-colors hover:bg-white/10 hover:text-white md:block ${
              rail ? 'md:mx-auto' : ''
            }`}
          >
            <Icon name={rail ? 'chevron-right' : 'chevron-left'} />
          </button>
        </div>
        <nav className="nav-scroll flex-1 overflow-y-auto py-2">
          {visible(DASHBOARD) && link(DASHBOARD)}
          {NAV.map((group) => {
            const items = group.items.filter(visible);
            // A group this team may see nothing in takes no space at all — a
            // heading over an empty list is worse than no heading, and with
            // five teams most of them have one.
            if (items.length === 0) return null;
            const expanded = open.includes(group.heading) || group.heading === activeHeading;
            return (
              <div key={group.heading} className="mt-2">
                <button
                  type="button"
                  onClick={() => toggle(group.heading)}
                  aria-expanded={expanded}
                  className={`flex w-full items-center gap-1.5 px-4 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-white/40 transition-colors hover:text-white/80 ${
                    rail ? 'md:hidden' : ''
                  }`}
                >
                  <Icon name="chevron-right" size={12} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
                  <span className="flex-1 text-left">{group.heading}</span>
                  {/* Closed groups say how much is inside, so folding one away
                      does not make you forget what it held. */}
                  {!expanded && <span className="font-normal text-white/30">{items.length}</span>}
                </button>
                {expanded
                  ? items.map((item) => link(item))
                  // Folded. The rail is the one place a folded item still has
                  // to show: there is no heading left to unfold there, so
                  // hiding it would put the page out of reach. Everywhere else
                  // — the drawer and the full-width sidebar — folded means
                  // gone. Every folded item carried the rail's rule at every
                  // desktop width, so collapsing a group on a laptop moved the
                  // chevron and left the list exactly where it was.
                  : items.map((item) => link(item, rail ? 'hidden md:flex' : 'hidden'))}
              </div>
            );
          })}
        </nav>
        <div className={`border-t border-white/10 px-4 py-3 text-sm ${rail ? 'md:px-0 md:text-center' : ''}`}>
          <div className={`mb-0.5 truncate text-white/80 ${rail ? 'md:hidden' : ''}`}>{user.name}</div>
          {/*
            The team, not the legacy `role`. That column is derived and says
            *manager* or *employee*, which is two words for six teams — and it
            read *Manager* under a Team page and a My Access page both saying
            *Super Admin*. A blank team_role falls back to the old word rather
            than to nothing, since a row the backfill never reached still has one.
          */}
          <div className={`mb-1 text-xs capitalize text-white/40 ${rail ? 'md:hidden' : ''}`}>
            {user.team_role ? teamRoleLabel(user.team_role) : user.role}
          </div>
          <button
            onClick={logout}
            title={rail ? `Sign out (${user.name})` : undefined}
            className="flex items-center gap-1 text-xs text-white/50 transition-colors hover:text-white"
          >
            <span className={rail ? 'md:hidden' : ''}>Sign out</span>
            <span className={rail ? 'hidden md:inline' : 'hidden'}><Icon name="power" /></span>
          </button>
        </div>
      </aside>
      {/*
        `min-w-0` matters on every width. A flex item defaults to
        `min-width: auto`, so it will not shrink below its own content — main
        stayed wider than the window and the whole app scrolled sideways.
        Measured at 768px: 815px wide with `auto`, exactly 753 with `0`. Tables
        still scroll inside their own cards, which is where it belongs.

        The left margin is for the fixed sidebar and so only applies once the
        sidebar is fixed; the top padding is for the phone header, which does
        not exist above `md`.
      */}
      <main className={`min-w-0 flex-1 p-4 pt-16 md:p-6 md:pt-6 ${rail ? 'md:ml-14' : 'md:ml-56'}`}>{children}</main>
    </div>
  );
}
