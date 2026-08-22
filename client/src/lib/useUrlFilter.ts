import { useSearchParams } from 'react-router-dom';

/**
 * A list filter that lives in the URL instead of in component state.
 *
 * Drop-in for `useState('')` — same `[value, setValue]` shape — so a page
 * adopts it one filter at a time. Two things follow from the move: a filtered
 * list can be linked to (which is what lets the dashboard drill through to
 * "the four quotations awaiting approval" rather than to the whole list), and
 * the back button undoes a filter instead of leaving the page.
 *
 * `replace` rather than push: typing in a search box would otherwise stack one
 * history entry per keystroke, and Back would walk them one character at a
 * time. The trade is that a filter change is not itself undoable — the same
 * call the Orders page already made when it put `?view=` in the URL.
 *
 * Blank deletes the key, so an unfiltered list has a clean URL and `?status=`
 * never appears empty.
 *
 * **Changing a filter drops the page number.** Narrowing a list to four rows
 * while sitting on page seven shows an empty table, which reads as a fault
 * rather than as a filter. Handling it here means no list page has to remember
 * to — the page number is itself stored through this hook, and skips the reset
 * so that turning to page 3 does not immediately undo itself.
 */
export function useUrlFilter(key: string, fallback = ''): [string, (value: string) => void] {
  const [search, setSearch] = useSearchParams();
  const value = search.get(key) ?? fallback;
  const set = (next: string) => {
    const params = new URLSearchParams(search);
    if (next) params.set(key, next); else params.delete(key);
    if (key !== 'page') params.delete('page');
    setSearch(params, { replace: true });
  };
  return [value, set];
}
