import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
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

export default function App() {
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

  const managerOnly = (element: JSX.Element) =>
    user.role === 'manager' ? element : <Navigate to="/" replace />;

  return (
    <UserContext.Provider value={user}>
      <Layout user={user} onLogout={() => setUser(null)}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/container-planner" element={<ContainerPlannerPage />} />
          <Route path="/enquiries" element={<EnquiriesPage />} />
          <Route path="/quotations" element={<QuotationsPage />} />
          <Route path="/quotations/new" element={<QuotationFormPage />} />
          <Route path="/quotations/:id" element={<QuotationFormPage />} />
          <Route path="/proformas" element={<ProformasPage />} />
          <Route path="/proformas/new" element={<ProformaFormPage />} />
          <Route path="/proformas/:id" element={<ProformaFormPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/orders/new" element={<OrderFormPage />} />
          <Route path="/orders/:id" element={<OrderFormPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/new" element={<InvoiceFormPage />} />
          <Route path="/invoices/:id" element={<InvoiceFormPage />} />
          <Route path="/packing-lists" element={<PackingListsPage />} />
          <Route path="/packing-lists/new" element={<PackingListFormPage />} />
          <Route path="/packing-lists/:id" element={<PackingListFormPage />} />
          <Route path="/followups" element={<FollowupsPage />} />
          <Route path="/work-orders" element={<WorkOrdersPage />} />
          <Route path="/despatches" element={<DespatchesPage />} />
          <Route path="/stock" element={<StockPage />} />
          <Route path="/purchase-orders" element={managerOnly(<PurchaseOrdersPage />)} />
          <Route path="/masters" element={managerOnly(<MastersPage />)} />
          <Route path="/approvals" element={managerOnly(<ApprovalsPage />)} />
          <Route path="/activity" element={managerOnly(<ActivityPage />)} />
          <Route path="/team" element={managerOnly(<TeamPage />)} />
          <Route path="/settings" element={managerOnly(<SettingsPage />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </UserContext.Provider>
  );
}
