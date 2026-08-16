import { createContext, useContext, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api, ApiError } from './api/client';
import type { User } from './types';
import Layout from './components/Layout';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import CustomersPage from './pages/Customers';
import ProductsPage from './pages/Products';
import ContainerPlannerPage from './pages/ContainerPlanner';
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
import MastersPage from './pages/Masters';
import ApprovalsPage from './pages/Approvals';
import TeamPage from './pages/Team';
import SettingsPage from './pages/Settings';

const UserContext = createContext<User | null>(null);
/** Current signed-in user; components use this to branch on role. */
export const useUser = () => useContext(UserContext)!;
export const useIsManager = () => useContext(UserContext)?.role === 'manager';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<User>('/api/auth/me')
      .then(setUser)
      .catch((err) => {
        if (!(err instanceof ApiError && (err.status === 401 || err.status === 403))) console.error(err);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-400">Loading…</div>;
  }

  if (!user) return <LoginPage onLogin={setUser} />;

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
          <Route path="/masters" element={managerOnly(<MastersPage />)} />
          <Route path="/approvals" element={managerOnly(<ApprovalsPage />)} />
          <Route path="/team" element={managerOnly(<TeamPage />)} />
          <Route path="/settings" element={managerOnly(<SettingsPage />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </UserContext.Provider>
  );
}
