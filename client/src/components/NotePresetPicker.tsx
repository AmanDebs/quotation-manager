import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Settings } from '../types';
import { Select } from './ui';

/**
 * Inserts a predefined note/term into an editable textarea. Presets are
 * templates — once inserted the text is fully editable on this document.
 */
export default function NotePresetPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const presets = settings?.note_presets ?? [];
  if (presets.length === 0) return null;

  return (
    <Select
      className="max-w-56"
      value=""
      onChange={(e) => {
        const preset = presets.find((p) => p.label === e.target.value);
        if (!preset) return;
        onChange(value ? `${value.replace(/\s*$/, '')}\n${preset.body}` : preset.body);
      }}
    >
      <option value="">+ Insert preset…</option>
      {presets.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
    </Select>
  );
}
