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
 */
export function useUrlFilter(key: string, fallback = ''): [string, (value: string) => void] {
  const [search, setSearch] = useSearchParams();
  const value = search.get(key) ?? fallback;
  const set = (next: string) => {
    const params = new URLSearchParams(search);
    if (next) params.set(key, next); else params.delete(key);
    setSearch(params, { replace: true });
  };
  return [value, set];
}
