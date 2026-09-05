import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useCan } from '../App';
import type { Location, Supplier, Transporter, Material, Machine, Mould } from '../types';
import { PageHeader, Tabs } from '../components/ui';
import MasterList, { type MasterSpec } from '../components/MasterList';

/**
 * The lists the factory side is built on.
 *
 * Kept on one page behind tabs rather than six sidebar entries: they are set up
 * once and then rarely touched, and six near-empty pages would bury the daily
 * screens. The shapes mirror `MASTERS` in server/src/routes/masters.ts.
 */

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

const locations: MasterSpec<Location> = {
  path: 'locations',
  title: 'Locations',
  singular: 'Location',
  blurb: 'Plants and godowns. Stock is held per location, never pooled — the order desk despatches from more than one.',
  columns: [
    { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'code', label: 'Code', render: (r) => dash(r.code) },
    { key: 'address', label: 'Address', render: (r) => dash(r.address) },
  ],
  fields: [
    { key: 'name', label: 'Name *', wide: true, placeholder: 'e.g. Jungalpur' },
    { key: 'code', label: 'Short code', placeholder: 'e.g. JGP' },
    { key: 'address', label: 'Address', wide: true },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  empty: { name: '', code: '', address: '', notes: '', active: 1 },
};

const suppliers: MasterSpec<Supplier> = {
  path: 'suppliers',
  title: 'Suppliers',
  singular: 'Supplier',
  blurb: 'Who raw material is bought from. Purchase orders point here.',
  columns: [
    { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'contact_person', label: 'Contact', render: (r) => dash(r.contact_person) },
    { key: 'phone', label: 'Phone', render: (r) => dash(r.phone) },
    { key: 'gstin', label: 'GSTIN', render: (r) => dash(r.gstin) },
    { key: 'payment_terms', label: 'Terms', render: (r) => dash(r.payment_terms) },
  ],
  fields: [
    { key: 'name', label: 'Name *', wide: true },
    { key: 'contact_person', label: 'Contact person' },
    { key: 'phone', label: 'Phone' },
    { key: 'email', label: 'Email' },
    { key: 'gstin', label: 'GSTIN' },
    { key: 'address', label: 'Address', type: 'textarea', wide: true },
    { key: 'payment_terms', label: 'Payment terms', wide: true, placeholder: 'e.g. 30 days from invoice' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  empty: { name: '', contact_person: '', phone: '', email: '', address: '', gstin: '', payment_terms: '', notes: '', active: 1 },
};

const transporters: MasterSpec<Transporter> = {
  path: 'transporters',
  title: 'Transporters',
  singular: 'Transporter',
  blurb: 'Who carries the goods. "Self" is already here — an own-vehicle delivery is still a delivery.',
  columns: [
    { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'phone', label: 'Phone', render: (r) => dash(r.phone) },
    { key: 'notes', label: 'Notes', render: (r) => dash(r.notes) },
  ],
  fields: [
    { key: 'name', label: 'Name *', wide: true },
    { key: 'phone', label: 'Phone' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  empty: { name: '', phone: '', notes: '', active: 1 },
};

const CATEGORIES = [
  { value: 'resin', label: 'Resin' },
  { value: 'masterbatch', label: 'Masterbatch / colour' },
  { value: 'packing', label: 'Packing' },
  { value: 'other', label: 'Other' },
];

const materials: MasterSpec<Material> = {
  path: 'materials',
  title: 'Materials',
  singular: 'Material',
  blurb: 'Raw material and packing. The unit here is the stock unit — kg for resin, pieces for cartons — and every figure for this material is read in it.',
  columns: [
    { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'category', label: 'Category', render: (r) => <span className="capitalize">{r.category}</span> },
    { key: 'unit', label: 'Unit', render: (r) => r.unit },
    { key: 'hsn_code', label: 'HSN', render: (r) => dash(r.hsn_code) },
    { key: 'reorder_level', label: 'Reorder at', align: 'right', render: (r) => (r.reorder_level ? r.reorder_level.toLocaleString('en-IN') : '—') },
  ],
  fields: [
    { key: 'name', label: 'Name *', wide: true, placeholder: 'e.g. PET Resin — bottle grade' },
    { key: 'category', label: 'Category', type: 'select', options: CATEGORIES },
    { key: 'unit', label: 'Stock unit', placeholder: 'kg / pcs' },
    { key: 'hsn_code', label: 'HSN code' },
    { key: 'reorder_level', label: 'Reorder level', type: 'number', placeholder: 'Blank = no level' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  empty: { name: '', category: 'resin', unit: 'kg', hsn_code: '', reorder_level: 0, notes: '', active: 1 },
};

const MACHINE_TYPES = [
  { value: 'moulding', label: 'Moulding' },
  { value: 'assembly', label: 'Assembly' },
  { value: 'other', label: 'Other' },
];

const moulds: MasterSpec<Mould> = {
  path: 'moulds',
  title: 'Moulds',
  singular: 'Mould',
  blurb: 'Cavity count is recorded because it is worth knowing — nothing computes a cycle time from it.',
  columns: [
    { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'code', label: 'Code', render: (r) => dash(r.code) },
    { key: 'cavities', label: 'Cavities', align: 'right', render: (r) => dash(r.cavities) },
    { key: 'notes', label: 'Notes', render: (r) => dash(r.notes) },
  ],
  fields: [
    { key: 'name', label: 'Name *', wide: true },
    { key: 'code', label: 'Code' },
    { key: 'cavities', label: 'Cavities', type: 'number' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  empty: { name: '', code: '', cavities: null, notes: '', active: 1 },
};

type TabKey = 'locations' | 'suppliers' | 'transporters' | 'materials' | 'machines' | 'moulds';

export default function MastersPage() {
  const [tab, setTab] = useState<TabKey>('locations');
  const can = useCan();
  // canEdit on the six lists
  const isManager = can('master','full');

  // Machines belong to a plant, so their picker needs the location list.
  const { data: locationRows = [] } = useQuery({
    queryKey: ['master', 'locations', false],
    queryFn: () => api.get<Location[]>('/api/locations'),
  });
  const byId = new Map(locationRows.map((l) => [l.id, l.name]));

  const machines: MasterSpec<Machine> = {
    path: 'machines',
    title: 'Machines',
    singular: 'Machine',
    blurb: 'What runs where. A work order picks one; nothing schedules capacity.',
    columns: [
      { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
      { key: 'code', label: 'Code', render: (r) => dash(r.code) },
      { key: 'location_id', label: 'Plant', render: (r) => (r.location_id ? byId.get(r.location_id) ?? '—' : '—') },
      { key: 'type', label: 'Type', render: (r) => <span className="capitalize">{r.type}</span> },
    ],
    fields: [
      { key: 'name', label: 'Name *', wide: true },
      { key: 'code', label: 'Code' },
      {
        key: 'location_id',
        label: 'Plant',
        type: 'select',
        options: locationRows.map((l) => ({ value: l.id, label: l.name })),
      },
      { key: 'type', label: 'Type', type: 'select', options: MACHINE_TYPES },
      { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
    ],
    empty: { name: '', code: '', location_id: null, type: 'moulding', notes: '', active: 1 },
  };

  return (
    <div>
      <PageHeader
        title="Production Masters"
        subtitle="The lists the shop floor is built on — set them up once, then pick from them"
      />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'locations', label: 'Locations' },
          { key: 'materials', label: 'Materials' },
          { key: 'machines', label: 'Machines' },
          { key: 'moulds', label: 'Moulds' },
          { key: 'suppliers', label: 'Suppliers' },
          { key: 'transporters', label: 'Transporters' },
        ]}
      />
      {tab === 'locations' && <MasterList spec={locations} canEdit={isManager} />}
      {tab === 'materials' && <MasterList spec={materials} canEdit={isManager} />}
      {tab === 'machines' && <MasterList spec={machines} canEdit={isManager} />}
      {tab === 'moulds' && <MasterList spec={moulds} canEdit={isManager} />}
      {tab === 'suppliers' && <MasterList spec={suppliers} canEdit={isManager} />}
      {tab === 'transporters' && <MasterList spec={transporters} canEdit={isManager} />}
    </div>
  );
}
