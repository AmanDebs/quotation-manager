import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api, ApiError } from './api/client';
import type { User } from './types';
import Layout from './components/Layout';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import CustomersPage from './pages/Customers';
import ProductsPage from './pages/Products';
import EnquiriesPage from './pages/Enquiries';
import QuotationsPage from './pages/Quotations';
import QuotationFormPage from './pages/QuotationForm';
import ProformasPage from './pages/Proformas';
import ProformaFormPage from './pages/ProformaForm';
import InvoicesPage from './pages/Invoices';
import InvoiceFormPage from './pages/InvoiceForm';
import PackingListsPage from './pages/PackingLists';
import PackingListFormPage from './pages/PackingListForm';
import FollowupsPage from './pages/Followups';
import SettingsPage from './pages/Settings';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<User>('/api/auth/me')
      .then(setUser)
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-400">Loading…</div>;
  }

  if (!user) return <LoginPage onLogin={setUser} />;

  return (
    <Layout user={user} onLogout={() => setUser(null)}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/enquiries" element={<EnquiriesPage />} />
        <Route path="/quotations" element={<QuotationsPage />} />
        <Route path="/quotations/new" element={<QuotationFormPage />} />
        <Route path="/quotations/:id" element={<QuotationFormPage />} />
        <Route path="/proformas" element={<ProformasPage />} />
        <Route path="/proformas/new" element={<ProformaFormPage />} />
        <Route path="/proformas/:id" element={<ProformaFormPage />} />
        <Route path="/invoices" element={<InvoicesPage />} />
        <Route path="/invoices/new" element={<InvoiceFormPage />} />
        <Route path="/invoices/:id" element={<InvoiceFormPage />} />
        <Route path="/packing-lists" element={<PackingListsPage />} />
        <Route path="/packing-lists/new" element={<PackingListFormPage />} />
        <Route path="/packing-lists/:id" element={<PackingListFormPage />} />
        <Route path="/followups" element={<FollowupsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
