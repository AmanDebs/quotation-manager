import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Outlet, Navigate, type RouteObject } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setUnauthorizedHandler } from './api/client';
import type { User } from './types';
import Layout from './components/Layout';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import CustomersPage from './pages/Customers';
import ProductsPage from './pages/Products';
import ContainerPlannerPage from './pages/ContainerPlanner';
import EnquiriesPage from './pages/Enquiries';
import QuotationsPage from './pages/Quotations';
import QuotationFormPage from './pages/QuotationForm';
import ProformasPage from './pages/Proformas';
import ProformaFormPage from './pages/ProformaForm';
import OrdersPage from './pages/Orders';
import OrderFormPage from './pages/OrderForm';
import InvoicesPage from './pages/Invoices';
import InvoiceFormPage from './pages/InvoiceForm';
import PackingListsPage from './pages/PackingLists';
import PackingListFormPage from './pages/PackingListForm';
import FollowupsPage from './pages/Followups';
import WorkOrdersPage from './pages/WorkOrders';
import DespatchesPage from './pages/Despatches';
import StockPage from './pages/Stock';
import PurchaseOrdersPage from './pages/PurchaseOrders';
import MastersPage from './pages/Masters';
import ApprovalsPage from './pages/Approvals';
import ActivityPage from './pages/Activity';
import TeamPage from './pages/Team';
import SettingsPage from './pages/Settings';

const UserContext = createContext<User | null>(null);
/** Current signed-in user; components use this to branch on role. */
export const useUser = () => useContext(UserContext)!;
export const useIsManager = () => useContext(UserContext)?.role === 'manager';

/**
 * Update the signed-in user in place.
 *
 * The user is fetched once, on mount, and then held in state — so anything
 * that changes a property of it has to say so here too, or the change is
 * correct on the server and stale on the screen. The dashboard layout is the
 * case that found this: hiding a card worked, and then the card came back the
 * moment you left the page and returned, because remounting re-read the
 * layout from a user object nobody had told.
 */
const PatchUserContext = createContext<(patch: Partial<User>) => void>(() => {});
export const usePatchUser = () => useContext(PatchUserContext);

/**
 * The signed-in shell: auth, the chrome, and a slot for the matched page.
 *
 * It is the root *route* rather than a component wrapping a `<Routes>`, which
 * is what lets `main.tsx` mount a data router — and a data router is the only
 * thing react-router will register a navigation blocker with. See
 * `lib/useUnsavedChanges.ts`, which is the whole reason for the shape.
 */
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const queryClient = useQueryClient();

  // Read by the 401 handler below, which is registered once and would otherwise
  // close over the user as it was on mount — always null.
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  useEffect(() => {
    api.get<User>('/api/auth/me')
      .then(setUser)
      .catch((err) => {
        if (!(err instanceof ApiError && (err.status === 401 || err.status === 403))) console.error(err);
      })
      .finally(() => setLoading(false));
  }, []);

  /**
   * A session can end while the app is open — the cookie expires, or a password
   * is changed elsewhere. `/auth/me` is only asked once, on mount, so nothing
   * noticed: every query on the page simply started failing and the screen
   * looked broken rather than signed out.
   *
   * Any 401 that is not itself an answer (see EXPECTS_401 in the api client)
   * now drops straight back to the login screen, saying why. The cache is
   * cleared with it, or the next person to sign in on this machine would see
   * the previous one's customers until each query refetched.
   */
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!userRef.current) return;
      setUser(null);
      setExpired(true);
      queryClient.clear();
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-400">Loading…</div>;
  }

  if (!user) {
    return <LoginPage onLogin={(u) => { setExpired(false); setUser(u); }} expired={expired} />;
  }

  return (
    <UserContext.Provider value={user}>
      <PatchUserContext.Provider value={(patch) => setUser((u) => (u ? { ...u, ...patch } : u))}>
      <Layout user={user} onLogout={() => setUser(null)}>
        <Outlet />
      </Layout>
      </PatchUserContext.Provider>
    </UserContext.Provider>
  );
}

/**
 * Manager-only pages. This was a closure over `user` inside App; the route
 * table now sits outside it, so the check reads the same context the pages
 * themselves read.
 */
function ManagerOnly({ children }: { children: JSX.Element }) {
  return useIsManager() ? children : <Navigate to="/" replace />;
}

export const routes: RouteObject[] = [
  {
    element: <App />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/customers', element: <CustomersPage /> },
      { path: '/products', element: <ProductsPage /> },
      { path: '/container-planner', element: <ContainerPlannerPage /> },
      { path: '/enquiries', element: <EnquiriesPage /> },
      { path: '/quotations', element: <QuotationsPage /> },
      { path: '/quotations/new', element: <QuotationFormPage /> },
      { path: '/quotations/:id', element: <QuotationFormPage /> },
      { path: '/proformas', element: <ProformasPage /> },
      { path: '/proformas/new', element: <ProformaFormPage /> },
      { path: '/proformas/:id', element: <ProformaFormPage /> },
      { path: '/orders', element: <OrdersPage /> },
      { path: '/orders/new', element: <OrderFormPage /> },
      { path: '/orders/:id', element: <OrderFormPage /> },
      { path: '/invoices', element: <InvoicesPage /> },
      { path: '/invoices/new', element: <InvoiceFormPage /> },
      { path: '/invoices/:id', element: <InvoiceFormPage /> },
      { path: '/packing-lists', element: <PackingListsPage /> },
      { path: '/packing-lists/new', element: <PackingListFormPage /> },
      { path: '/packing-lists/:id', element: <PackingListFormPage /> },
      { path: '/followups', element: <FollowupsPage /> },
      { path: '/work-orders', element: <WorkOrdersPage /> },
      { path: '/despatches', element: <DespatchesPage /> },
      { path: '/stock', element: <StockPage /> },
      { path: '/purchase-orders', element: <ManagerOnly><PurchaseOrdersPage /></ManagerOnly> },
      { path: '/masters', element: <ManagerOnly><MastersPage /></ManagerOnly> },
      { path: '/approvals', element: <ManagerOnly><ApprovalsPage /></ManagerOnly> },
      { path: '/activity', element: <ManagerOnly><ActivityPage /></ManagerOnly> },
      { path: '/team', element: <ManagerOnly><TeamPage /></ManagerOnly> },
      { path: '/settings', element: <ManagerOnly><SettingsPage /></ManagerOnly> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];
