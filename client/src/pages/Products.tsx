import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useIsManager } from '../App';
import type { Product } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, EmptyState, ErrorText, Modal, Card , Pagination} from '../components/ui';
import ProductImportModal from '../components/ProductImportModal';
import RecipeModal from '../components/RecipeModal';
import QcSpecModal from '../components/QcSpecModal';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

export const UNITS = ['unit', 'kg', 'tonne', 'per 1000', 'box'];

/**
 * The list to offer, with whatever the row already says kept on it. Units the
 * catalogue no longer offers (meter, litre, set) still sit on documents raised
 * before they were dropped; without this the select would show blank and the
 * next save would silently rewrite the line's basis.
 */
export const unitOptions = (current: string | undefined | null): string[] =>
  current && !UNITS.includes(current) ? [...UNITS, current] : UNITS;

const empty: Omit<Product, 'id'> = {
  name: '', description: '', hsn_code: '', unit: 'unit', unit_price: 0, country_of_origin: 'India',
  image: '', color: '', pcs_per_pack: null, qty_20ft: null, qty_40ft: null,
};

/** Blank must stay blank — 0 boxes per container is a real, different claim. */
const numOrNull = (v: string) => (v === '' ? null : Number(v));

function ProductImage({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-3">
      {value ? (
        <img src={value} alt="" className="h-16 w-16 rounded border border-slate-200 object-cover" />
      ) : (
        <div className="flex h-16 w-16 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-400">None</div>
      )}
      <input
        type="file"
        accept="image/*"
        className="text-xs"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > 300 * 1024) { alert('Please use an image under 300 KB'); return; }
          const reader = new FileReader();
          reader.onload = () => onChange(String(reader.result));
          reader.readAsDataURL(file);
        }}
      />
      {value && <Button type="button" variant="danger" onClick={() => onChange('')}>Remove</Button>}
    </div>
  );
}

export default function ProductsPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Product | Omit<Product, 'id'> | null>(null);
  const [recipeFor, setRecipeFor] = useState<Product | null>(null);
  const [qcFor, setQcFor] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  // Anyone may add a product mid-quotation, but changing or bulk-replacing the
  // shared catalogue moves everyone's prices — that stays with the manager.
  const isManager = useIsManager();
  const list = usePagedList<Product>(['products', q], `/api/products?q=${encodeURIComponent(q)}`);
  const products = list.rows;

  const save = useMutation({
    mutationFn: (p: Product | Omit<Product, 'id'>) =>
      'id' in p ? api.put<Product>(`/api/products/${p.id}`, p) : api.post<Product>('/api/products', p),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setEditing(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/products/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });

  const set = (patch: Partial<Product>) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div>
      <PageHeader
        title="Products"
        subtitle={`${list.total} product${list.total === 1 ? '' : 's'} in catalog`}
        actions={
          <>
            {isManager && <Button variant="secondary" onClick={() => setImporting(true)}>⬆ Import from Excel</Button>}
            <Button onClick={() => { save.reset(); setEditing({ ...empty }); }}>+ New Product</Button>
          </>
        }
      />
      <div className="mb-3 max-w-xs">
        <Input placeholder="Search by name or HSN…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorText error={remove.error} />
      <Card className="overflow-x-auto">
        {products.length === 0 ? (
          <EmptyState message="No products yet. Add products to pick them quickly when building documents." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3 w-14" />
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Colour</th>
                <th className="pb-2 pr-3">HSN</th>
                <th className="pb-2 pr-3">Unit</th>
                <th className="pb-2 pr-3 text-right">Default Price</th>
                <th className="pb-2 pr-3 text-right">Pcs / Box</th>
                <th className="pb-2 pr-3 text-right">20ft</th>
                <th className="pb-2 pr-3 text-right">40ft</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3">
                    {p.image
                      ? <img src={p.image} alt="" className="h-10 w-10 rounded border border-slate-200 object-cover" />
                      : <div className="h-10 w-10 rounded border border-dashed border-slate-200" />}
                  </td>
                  <td className="py-2 pr-3 font-medium">{p.name}</td>
                  <td className="py-2 pr-3">{p.color || '—'}</td>
                  <td className="py-2 pr-3">{p.hsn_code || '—'}</td>
                  <td className="py-2 pr-3">{p.unit}</td>
                  <td className="py-2 pr-3 text-right">{p.unit_price ? p.unit_price.toLocaleString('en-IN') : '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p.pcs_per_pack?.toLocaleString('en-IN') ?? '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p.qty_20ft?.toLocaleString('en-IN') ?? '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p.qty_40ft?.toLocaleString('en-IN') ?? '—'}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {isManager ? (
                      <>
                        {/* The recipe is a different question from the catalogue
                            entry — what it is made of, not what it sells for —
                            so it gets its own dialog rather than more fields. */}
                        <Button variant="ghost" onClick={() => setRecipeFor(p)}>Recipe</Button>
                        {/* And what makes one good — a different question again. */}
                        <Button variant="ghost" onClick={() => setQcFor(p)}>QC</Button>
                        <Button variant="ghost" onClick={() => { save.reset(); setEditing(p); }}>Edit</Button>
                        <Button
                          variant="danger"
                          className="ml-1 border-0"
                          onClick={() => { if (confirm(`Delete product "${p.name}"?`)) remove.mutate(p.id); }}
                        >
                          Delete
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-slate-300" title="Ask your manager to change a catalogue entry">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="products"
        />
      </Card>

      {editing && (
        <Modal title={'id' in editing ? `Edit ${editing.name}` : 'New Product'} onClose={() => setEditing(null)}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Product Name *" className="col-span-2">
              <Input value={editing.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Description (shown on documents)" className="col-span-2">
              <Textarea rows={2} value={editing.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <Field label="HSN Code"><Input value={editing.hsn_code} onChange={(e) => set({ hsn_code: e.target.value })} /></Field>
            <Field label="Unit of Measure">
              <Select value={editing.unit} onChange={(e) => set({ unit: e.target.value })}>
                {unitOptions(editing.unit).map((u) => <option key={u} value={u}>{u}</option>)}
              </Select>
            </Field>
            <Field label="Default Unit Price">
              <Input type="number" min={0} step="any" value={editing.unit_price || ''} onChange={(e) => set({ unit_price: Number(e.target.value) })} />
            </Field>
            <Field label="Country of Origin"><Input value={editing.country_of_origin} onChange={(e) => set({ country_of_origin: e.target.value })} /></Field>
            <Field label="Default Colour">
              <Input value={editing.color} onChange={(e) => set({ color: e.target.value })} placeholder="e.g. Red-Yellow (Printing)" />
            </Field>
            <div className="col-span-2 rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-xs font-medium text-slate-600">
                Packing & loadability — used by the container planner
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Pcs / Box">
                  <Input type="number" min={0} step="any" value={editing.pcs_per_pack ?? ''} onChange={(e) => set({ pcs_per_pack: numOrNull(e.target.value) })} />
                </Field>
                <Field label="Boxes per 20ft">
                  <Input type="number" min={0} step="any" value={editing.qty_20ft ?? ''} onChange={(e) => set({ qty_20ft: numOrNull(e.target.value) })} />
                </Field>
                <Field label="Boxes per 40ft">
                  <Input type="number" min={0} step="any" value={editing.qty_40ft ?? ''} onChange={(e) => set({ qty_40ft: numOrNull(e.target.value) })} />
                </Field>
              </div>
            </div>
            <Field label="Product Photo" className="col-span-2">
              <ProductImage value={editing.image} onChange={(v) => set({ image: v })} />
            </Field>
          </div>
          <div className="mt-4 space-y-2">
            <ErrorText error={save.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={() => save.mutate(editing)} disabled={save.isPending || !editing.name.trim()}>
                {'id' in editing ? 'Save Changes' : 'Create Product'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {importing && <ProductImportModal onClose={() => setImporting(false)} />}
      {recipeFor && <RecipeModal product={recipeFor} onClose={() => setRecipeFor(null)} />}
      {qcFor && <QcSpecModal product={qcFor} onClose={() => setQcFor(null)} />}
    </div>
  );
}
