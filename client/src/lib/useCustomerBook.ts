import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer } from '../types';

/**
 * The whole customer book, for a control that chooses who a document is **for**.
 *
 * `GET /api/customers` is scoped by default and widens on `?all=1`, and which
 * of the two a caller wants turns out to be decided by one question: is this
 * control picking the **subject** of a document, or **filtering** documents?
 *
 * A picker that names the customer a quotation, proforma, order, invoice,
 * packing list or enquiry is *for* offers the whole book, because since
 * 2026-10-07 a document may be raised for any customer on file (*"Sales user
 * still cannot raise a document for a customer they don't own, allow them"*) —
 * the picker has to offer what the save accepts, which is the invariant that
 * kept these scoped until the save itself opened up. It also has to contain the
 * customer a saved document already names, or opening one would show a blank
 * select and an ordinary Save would send nothing.
 *
 * A dropdown that **filters** a list of documents stays scoped and deliberately
 * does not use this: the despatch, payment, follow-up, proforma and tracker
 * filters offer the customers whose documents you read, and offering any other
 * would be a filter that can only ever return nothing.
 *
 * One hook rather than six copies of the query, and a key of its own — the
 * scoped callers share `['customers', '']`, so widening in place would have
 * handed them the whole book out of the cache.
 */
export function useCustomerBook(): Customer[] {
  const { data } = useQuery({
    queryKey: ['customers', 'book'],
    queryFn: () => api.get<Customer[]>('/api/customers?all=1'),
  });
  return data ?? [];
}
