import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer, Product, QcParam, QcKind, QcSpecResponse } from '../types';
import { Button, Input, Select, SearchSelect, Modal, ErrorText, EmptyState, TH_CLASS } from './ui';

/**
 * What to check on this product, and what passes.
 *
 * The recipe's twin: a short list, rewritten whole, in its own dialog rather
 * than as more fields on the catalogue row — "what it is made of" and "what
 * makes it good" are different questions from "what it sells for".
 *
 * Editing this does **not** disturb inspections already recorded. Each result
 * carries its own copy of the tolerance it was judged against, so tightening a
 * spec cannot retroactively fail a batch that met the spec of the day.
 *
 * **A customer may have their own**, asked for on 2026-09-05: the same part is
 * genuinely measured to different tolerances for different buyers. The picker
 * chooses whose list is being edited, and a customer's rows **replace** the
 * default rather than merging with it — one list on screen, one list on the
 * report, and it says whose. A customer with none falls back to the default,
 * so nothing changes for anybody until somebody writes an override.
 */

const emptyParam = (): QcParam =>
  ({ name: '', kind: 'numeric', section: '', ranged: 0, unit: '', min_value: null, max_value: null, notes: '' });

/*
 * How the characteristic is observed, as one control.
 *
 * *Range* stores `kind: 'numeric'` with `ranged: 1` rather than a third kind,
 * because `product_qc_params.kind` carries a CHECK and SQLite cannot ALTER one
 * — the reason `users.team_role` is a column of its own. It is also the truer
 * shape: a range is a numeric characteristic observed differently.
 */
const KINDS: { value: string; label: string; kind: QcKind; ranged: number }[] = [
  { value: 'numeric', label: 'Measurement', kind: 'numeric', ranged: 0 },
  { value: 'range', label: 'Measurement (min–max across the batch)', kind: 'numeric', ranged: 1 },
  { value: 'boolean', label: 'Pass / fail', kind: 'boolean', ranged: 0 },
];
const kindValue = (p: QcParam) => (p.kind === 'boolean' ? 'boolean' : p.ranged ? 'range' : 'numeric');

/**
 * Which block of the certificate this check prints under.
 *
 * From Aglo's own cap certificate (2026-10-21), which prints three tables of
 * different shapes rather than one list. **Blank is the honest default and
 * not a fourth block**: a specification where nothing is set prints the
 * single table it always did, so nothing already issued changes and a product
 * is sectioned when somebody sections it.
 */
const SECTIONS: { value: string; label: string }[] = [
  { value: '', label: '— not sectioned —' },
  { value: 'visual', label: 'Visual' },
  { value: 'dimensional', label: 'Dimensional' },
  { value: 'fitment', label: 'Fitment' },
];

/** Blank must persist as null, not 0 — an open-ended tolerance is not "zero". */
const numOrNull = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

export default function QcSpecModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<QcParam[]>([]);
  /*
   * **Copied from another product** (2026-10-27, from a review the client
   * approved). This is the real reason the live catalogue has almost no
   * specifications in it: a preform's runs to nineteen-odd characteristics and
   * the next size's is the same list with a few numbers moved, so every product
   * meant typing the whole thing again. And an empty specification is not
   * harmless — `has_spec: false` means the QC gate holds nothing up for that
   * product, and the sectioned certificate their own paper uses only draws
   * where the specification carries sections.
   *
   * It copies the **default** list, never a customer's override: an override is
   * a statement about one buyer and carrying it onto another product would say
   * something nobody said. And it is **a fill of the editor, not a save** — the
   * numbers are what differ between sizes, so the point is to arrive with
   * nineteen rows to correct rather than nineteen rows to type.
   */
  const [copyFrom, setCopyFrom] = useState('');
  /*
   * And the same question one axis over: **this product's list as another
   * buyer has it**. Held apart from `copyFrom` because the two pickers are
   * two different questions, and picking in one clears the other so the row
   * never shows two sources for one set of rows.
   */
  const [copyWho, setCopyWho] = useState('');
  const [copyNote, setCopyNote] = useState('');
  // Empty string is the product's default spec, which is what NULL means in
  // the column — not "no customer chosen yet".
  const [customerId, setCustomerId] = useState('');

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', ''],
    queryFn: () => api.get<Customer[]>('/api/customers'),
  });
  /* The catalogue is the one list long enough to need a searchable picker. */
  const { data: products = [] } = useQuery({
    queryKey: ['products', ''],
    queryFn: () => api.get<Product[]>('/api/products'),
  });

  const { data: saved, isLoading } = useQuery({
    queryKey: ['qc-params', String(product.id), customerId],
    queryFn: () => api.get<QcSpecResponse>(
      `/api/products/${product.id}/qc-params${customerId ? `?customer_id=${customerId}` : ''}`
    ),
  });

  /*
   * What is shown when a customer has no override is the **default**, so the
   * dialog opens on the spec actually in force and saving it makes that
   * customer's own copy — which is how an override is written in the first
   * place. `owner` is what tells the two apart on screen.
   */
  useEffect(() => {
    if (saved) setLines(saved.items.length ? saved.items : [emptyParam()]);
  }, [saved]);

  const save = useMutation({
    mutationFn: () => api.put<QcSpecResponse>(`/api/products/${product.id}/qc-params`, {
      items: lines,
      customer_id: customerId ? Number(customerId) : null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['qc-params', String(product.id)] });
      // A job's screen shows the live spec beside its checks.
      queryClient.invalidateQueries({ queryKey: ['work-order-details'] });
      onClose();
    },
  });

  const inherited = !!customerId && saved?.owner === 'default';

  /*
   * What this product's list could be filled from, besides another product:
   * **the default**, where a buyer's own list is being written, and **every
   * buyer who holds one**, which the server sends rather than the client
   * guessing from the customer book — only real answers, with their length
   * beside each so the pick can be judged before it is made.
   *
   * The list being edited is never offered to itself.
   */
  const copySources = [
    ...(customerId ? [{ value: 'default', label: 'Every customer (the default)' }] : []),
    ...(saved?.overrides ?? [])
      .filter((o) => String(o.customer_id) !== customerId)
      .map((o) => ({
        value: String(o.customer_id),
        label: `${o.customer_name} — ${o.count} characteristic${o.count === 1 ? '' : 's'}`,
      })),
  ];

  /*
   * Fetched on the press rather than held for every product in the catalogue,
   * and **nothing is replaced when the source has none**: silently emptying
   * the editor would read as the copy having worked.
   *
   * One mutation over both pickers, because what differs between them is the
   * URL and the name in the note — two would be two ways of filling one
   * editor, waiting to come to disagree about what a copy does.
   */
  const copy = useMutation({
    mutationFn: ({ kind, id }: { kind: 'product' | 'customer'; id: string }) =>
      api.get<QcSpecResponse>(
        kind === 'product'
          ? `/api/products/${id}/qc-params`
          // This product, as that buyer holds it. The default is `id` of
          // `default`, which is the same route with nobody named.
          : `/api/products/${product.id}/qc-params${id === 'default' ? '' : `?customer_id=${id}`}`
      ),
    onSuccess: (res, { kind, id }) => {
      const from = kind === 'product'
        ? products.find((pr) => String(pr.id) === id)?.name ?? 'That product'
        : id === 'default'
          ? 'the default list'
          // Named from the answer that offered them rather than from the
          // customer book, which is scoped and need not carry that buyer.
          : (saved?.overrides ?? []).find((o) => String(o.customer_id) === id)?.customer_name
            ?? 'that customer';
      const items = res.items ?? [];
      if (!items.length) {
        setCopyNote(`${from === 'the default list' ? 'The default list' : from} has no specification to copy.`);
        return;
      }
      // The id is the source row's, so it is dropped: these are new rows on
      // this list until Save writes them.
      setLines(items.map(({ name, kind: k, section, ranged, unit, min_value, max_value, notes }) => ({
        name, kind: k, section, ranged, unit, min_value, max_value, notes,
      })));
      setCopyNote(`${items.length} characteristic${items.length === 1 ? '' : 's'} copied from ${from} — correct them and Save.`);
    },
  });

  const set = (i: number, patch: Partial<QcParam>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <Modal title={`Quality specification — ${product.name}`} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Specification for</span>
        <Select
          className="w-64"
          value={customerId}
          onChange={(e) => {
            // Switching whose list is being edited reloads the rows from the
            // server, so a copy that filled them is discarded — and a note
            // still describing it would be the page saying something untrue
            // about what is on screen.
            setCustomerId(e.target.value);
            setCopyFrom('');
            setCopyWho('');
            setCopyNote('');
          }}
        >
          <option value="">Every customer (the default)</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {inherited && (
          <span className="text-xs text-slate-500">
            No specification of their own — showing the default. Saving makes this their own copy.
          </span>
        )}
        {customerId && saved?.owner === 'customer' && (
          <span className="text-xs text-slate-500">
            Their own. Removing every row puts them back on the default.
          </span>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Copy from</span>
        <SearchSelect
          className="w-72"
          value={copyFrom}
          placeholder="Another product…"
          title="Fills the rows below with that product's default specification, for you to correct"
          onChange={(v) => {
            setCopyFrom(v);
            setCopyWho('');
            setCopyNote('');
            if (v) copy.mutate({ kind: 'product', id: v });
          }}
          options={products
            .filter((pr) => pr.id !== product.id)
            .map((pr) => ({
              value: String(pr.id),
              label: pr.name,
              hint: [pr.color, pr.product_type].filter(Boolean).join(' · '),
            }))}
        />
        {/*
          **Or this product's own list for another buyer** (2026-11-16, the
          client: *"Add option to copy from customer like there is option to
          copy from another product"*). The same need one axis over: a buyer's
          override is the default with a few numbers moved, so writing a second
          buyer's meant typing all nineteen rows again — and it reads the other
          way too, a list that has become what the plant actually works to
          being copied onto the default.

          Drawn only where there is something to copy, the rule a column of
          em-dashes follows: on a product nobody has overridden, and with no
          default to offer, this is a control whose every answer would be
          *nothing to copy*.
        */}
        {copySources.length > 0 && (
          <>
            <span className="text-xs text-slate-400">or</span>
            <Select
              className="w-64"
              value={copyWho}
              title="Fills the rows below with that list, for you to correct"
              onChange={(e) => {
                const v = e.target.value;
                setCopyWho(v);
                setCopyFrom('');
                setCopyNote('');
                if (v) copy.mutate({ kind: 'customer', id: v });
              }}
            >
              <option value="">Another customer’s list…</option>
              {copySources.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </>
        )}
        {copy.isPending && <span className="text-xs text-slate-400">Reading…</span>}
        {!!copyNote && <span className="text-xs text-slate-500">{copyNote}</span>}
        {!copy.isPending && !copyNote && (
          <span className="text-xs text-slate-400">
            Replaces the rows below. Nothing is saved until you press Save.
          </span>
        )}
      </div>

      {isLoading ? (
        <EmptyState message="Loading…" />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-2">Characteristic</th>
                <th className="w-32 pb-2 pr-2">Type</th>
                <th className="w-36 pb-2 pr-2">Section</th>
                <th className="w-20 pb-2 pr-2">Unit</th>
                <th className="w-24 pb-2 pr-2 text-right">Min</th>
                <th className="w-24 pb-2 pr-2 text-right">Max</th>
                <th className="w-8 pb-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-2">
                    <Input
                      value={line.name}
                      onChange={(e) => set(i, { name: e.target.value })}
                      placeholder="e.g. Neck diameter"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Select
                      value={kindValue(line)}
                      onChange={(e) => {
                        const k = KINDS.find((x) => x.value === e.target.value)!;
                        // A pass/fail check has no tolerance to hold, so the
                        // fields are cleared rather than left to be ignored.
                        set(i, k.kind === 'boolean'
                          ? { kind: k.kind, ranged: 0, min_value: null, max_value: null, unit: '' }
                          : { kind: k.kind, ranged: k.ranged });
                      }}
                    >
                      {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </Select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Select
                      value={line.section ?? ''}
                      onChange={(e) => set(i, { section: e.target.value as QcParam['section'] })}
                      title="Which block of the certificate this characteristic prints under"
                    >
                      {SECTIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                    </Select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      value={line.unit}
                      onChange={(e) => set(i, { unit: e.target.value })}
                      placeholder="mm"
                      disabled={line.kind === 'boolean'}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      type="number"
                      className="text-right"
                      value={line.min_value ?? ''}
                      onChange={(e) => set(i, { min_value: numOrNull(e.target.value) })}
                      disabled={line.kind === 'boolean'}
                      placeholder="—"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      type="number"
                      className="text-right"
                      value={line.max_value ?? ''}
                      onChange={(e) => set(i, { max_value: numOrNull(e.target.value) })}
                      disabled={line.kind === 'boolean'}
                      placeholder="—"
                    />
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                      className="px-1 text-slate-400 hover:text-red-600"
                      title="Remove this characteristic"
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-2 text-xs text-slate-400">
            A <span className="font-medium">min–max</span> characteristic is recorded as the lowest and
            highest piece seen in the batch, and passes when both ends clear the tolerance.{' '}
            Leave Min or Max empty for a one-sided tolerance — a wall thickness can have a floor and no
            ceiling. A <b>Pass / fail</b> characteristic is the eye: colour match, flash, short shot.
          </p>

          <div className="mt-3 flex items-center justify-between">
            <Button variant="secondary" onClick={() => setLines((prev) => [...prev, emptyParam()])}>
              + Add characteristic
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
          <ErrorText error={save.error || copy.error} />
          <p className="mt-2 text-xs text-slate-400">
            Changing this leaves inspections already recorded exactly as they were — each one keeps the
            tolerance it was judged against.
          </p>
        </>
      )}
    </Modal>
  );
}
