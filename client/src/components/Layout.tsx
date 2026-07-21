import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api/client';
import type { User } from '../types';

const nav = [
  { to: '/', label: 'Dashboard', icon: '📊' },
  { to: '/enquiries', label: 'Enquiries', icon: '📩' },
  { to: '/quotations', label: 'Quotations', icon: '📄' },
  { to: '/proformas', label: 'Proforma Invoices', icon: '🧾' },
  { to: '/invoices', label: 'Commercial Invoices', icon: '💰' },
  { to: '/packing-lists', label: 'Packing Lists', icon: '📦' },
  { to: '/followups', label: 'Follow-ups', icon: '🔔' },
  { to: '/customers', label: 'Customers', icon: '🏢' },
  { to: '/products', label: 'Products', icon: '🏷️' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

export default function Layout({ user, onLogout, children }: { user: User; onLogout: () => void; children: ReactNode }) {
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
          {nav.map((item) => (
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
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-3 text-sm">
          <div className="mb-1 truncate text-white/80">{user.name}</div>
          <button onClick={logout} className="text-xs text-white/50 hover:text-white">Sign out</button>
        </div>
      </aside>
      <main className="ml-56 flex-1 p-6">{children}</main>
    </div>
  );
}
