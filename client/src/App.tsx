import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Outlet, Navigate, type RouteObject } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setUnauthorizedHandler } from './api/client';
import type { User, Level } from './types';
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
import QualityPage from './pages/Quality';
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
/** Still means "is the super admin" — kept so the screens that read it work. */
export const useIsManager = () => useContext(UserContext)?.role === 'manager';

const RANK: Record<string, number> = { none: 0, view: 1, full: 2 };

/**
 * What this user may do.
 *
 * Returns a **function** rather than a boolean, because `Layout` filters a
 * whole nav array and some screens ask about two functions — neither of which
 * a `useCan(fn, level)` hook could do from inside a callback.
 *
 * The map comes from the server with `/auth/me`; the server enforces every one
 * of these anyway, so this only ever decides what to draw.
 */
export function useCan() {
  const caps = useContext(UserContext)?.can;
  return (fn: string, need: Level = 'view') => RANK[caps?.[fn] ?? 'none'] >= RANK[need];
}

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


/*
 * Where a team lands.
 *
 * The dashboard is the front door, but not every team has it — Quality does
 * not, on the client's own matrix — and a team without it would otherwise open
 * on a page whose every figure answers 403. So the first screen they can
 * actually use stands in. It cannot be `Needs` doing this: that sends people
 * home, and home is this.
 */
const LANDING: [string, string][] = [
  ['qc', '/quality'],
  ['work_order', '/work-orders'],
  ['dispatch', '/despatches'],
  ['quotation', '/quotations'],
  ['order', '/orders'],
  ['material', '/stock'],
  ['customer', '/customers'],
];

function Home() {
  const can = useCan();
  if (can('dashboard')) return <DashboardPage />;
  const first = LANDING.find(([fn]) => can(fn));
  return first ? <Navigate to={first[1]} replace /> : <DashboardPage />;
}

/** A page this team may not open at all. Sends them home rather than to a 403. */
function Needs({ fn, level = 'view', children }: { fn: string; level?: Level; children: JSX.Element }) {
  return useCan()(fn, level) ? children : <Navigate to="/" replace />;
}

export const routes: RouteObject[] = [
  {
    element: <App />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/customers', element: <Needs fn="customer"><CustomersPage /></Needs> },
      { path: '/products', element: <Needs fn="product"><ProductsPage /></Needs> },
      { path: '/container-planner', element: <Needs fn="product"><ContainerPlannerPage /></Needs> },
      { path: '/enquiries', element: <Needs fn="enquiry"><EnquiriesPage /></Needs> },
      { path: '/quotations', element: <Needs fn="quotation"><QuotationsPage /></Needs> },
      { path: '/quotations/new', element: <Needs fn="quotation"><QuotationFormPage /></Needs> },
      { path: '/quotations/:id', element: <Needs fn="quotation"><QuotationFormPage /></Needs> },
      { path: '/proformas', element: <Needs fn="proforma"><ProformasPage /></Needs> },
      { path: '/proformas/new', element: <Needs fn="proforma"><ProformaFormPage /></Needs> },
      { path: '/proformas/:id', element: <Needs fn="proforma"><ProformaFormPage /></Needs> },
      { path: '/orders', element: <Needs fn="order"><OrdersPage /></Needs> },
      { path: '/orders/new', element: <Needs fn="order"><OrderFormPage /></Needs> },
      { path: '/orders/:id', element: <Needs fn="order"><OrderFormPage /></Needs> },
      { path: '/invoices', element: <Needs fn="invoice"><InvoicesPage /></Needs> },
      { path: '/invoices/new', element: <Needs fn="invoice"><InvoiceFormPage /></Needs> },
      { path: '/invoices/:id', element: <Needs fn="invoice"><InvoiceFormPage /></Needs> },
      { path: '/packing-lists', element: <Needs fn="packing_list"><PackingListsPage /></Needs> },
      { path: '/packing-lists/new', element: <Needs fn="packing_list"><PackingListFormPage /></Needs> },
      { path: '/packing-lists/:id', element: <Needs fn="packing_list"><PackingListFormPage /></Needs> },
      { path: '/followups', element: <Needs fn="followup"><FollowupsPage /></Needs> },
      { path: '/work-orders', element: <Needs fn="work_order"><WorkOrdersPage /></Needs> },
      { path: '/quality', element: <Needs fn="qc"><QualityPage /></Needs> },
      { path: '/despatches', element: <Needs fn="dispatch"><DespatchesPage /></Needs> },
      { path: '/stock', element: <Needs fn="material"><StockPage /></Needs> },
      { path: '/purchase-orders', element: <Needs fn="purchasing"><PurchaseOrdersPage /></Needs> },
      { path: '/masters', element: <Needs fn="master"><MastersPage /></Needs> },
      { path: '/approvals', element: <Needs fn="approval"><ApprovalsPage /></Needs> },
      { path: '/activity', element: <Needs fn="audit"><ActivityPage /></Needs> },
      { path: '/team', element: <Needs fn="team"><TeamPage /></Needs> },
      { path: '/settings', element: <Needs fn="settings"><SettingsPage /></Needs> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];
