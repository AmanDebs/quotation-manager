import { useCan } from '../App';
import { PageHeader } from '../components/ui';
import MasterList from '../components/MasterList';
import { suppliersSpec } from './Masters';

/**
 * The supplier book, under **Records** beside Customers and Products
 * (2026-10-08, the client: *"Add PO supplier master creation in Records like
 * Customers and Products"*).
 *
 * A supplier is a **party** — a name, a GSTIN, an address and the terms you
 * buy on — which is what Customers and Products are and what the lists left on
 * the Production Masters page are not: a plant, a machine, a mould and a
 * process are configuration of the factory. It was a tab there and is a page
 * here, and that is the whole of the change: **the spec, the renderer, the
 * route and the permission are the ones it already had**, so this cannot come
 * to disagree with what it replaced.
 *
 * `MasterList` is reused rather than a Customers-shaped page written out — it
 * already draws the count, the blurb, *Show retired*, *+ New Supplier*, the
 * table and the modal, which is what the screenshot shows. Two renderers for
 * one list is how the two come to look different from each other.
 *
 * **Gated on `master`, unchanged.** Every team holds at least `view`, so the
 * entry is drawn for everybody and the controls are what differ — the rule the
 * Production Masters page already states about itself. Who may *edit* a
 * supplier is a separate decision and is one tick on the User Permissions
 * page, not something this move settles quietly.
 */
export default function SuppliersPage() {
  const can = useCan();
  return (
    <div>
      <PageHeader
        title="Suppliers"
        subtitle="Who raw material and bought-in goods come from — purchase orders point here"
      />
      <MasterList spec={suppliersSpec} canEdit={can('master', 'full')} />
    </div>
  );
}
