import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { User } from '../types';

const nav = [
  { to: '/', label: 'Dashboard', icon: '📊' },
  { to: '/quotations', label: 'Quotations', icon: '📄' },
  // Quotation -> Proforma -> Order -> Invoice: the order the desk works in.
  // The proforma is what the buyer confirms against, so it comes before the
  // order it produces, even though a proforma can also be raised from one.
  { to: '/proformas', label: 'Proforma Invoices', icon: '🧾' },
  { to: '/orders', label: 'Orders', icon: '📋' },
  // No Packing Lists entry: the commercial invoice owns its packing list, so it
  // is created and edited on the invoice. The pages remain routed for any
  // bookmarked link, but they are no longer a place you navigate to.
  { to: '/invoices', label: 'Commercial Invoices', icon: '💰' },
  { to: '/followups', label: 'Follow-ups', icon: '🔔' },
  { to: '/customers', label: 'Customers', icon: '🏢' },
  { to: '/products', label: 'Products', icon: '🏷️' },
  { to: '/container-planner', label: 'Container Planner', icon: '🚢' },
  // The factory side. Masters are set up once and rarely touched, so they sit
  // low in the list beside the other manager-only pages.
  { to: '/masters', label: 'Production Masters', icon: '🏭', managerOnly: true },
  { to: '/approvals', label: 'Approvals', icon: '✅', managerOnly: true },
  { to: '/team', label: 'Team', icon: '👥', managerOnly: true },
  { to: '/settings', label: 'Settings', icon: '⚙️', managerOnly: true },
];

export default function Layout({ user, onLogout, children }: { user: User; onLogout: () => void; children: ReactNode }) {
  const isManager = user.role === 'manager';
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

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-56 flex-col bg-brand-800 text-white">
        <div className="border-b border-white/10 px-4 py-4">
          <div className="text-lg font-bold">Quotation Manager</div>
          <div className="text-xs text-white/50">Order-to-Dispatch</div>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {nav.filter((item) => !item.managerOnly || isManager).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
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
          ))}
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
