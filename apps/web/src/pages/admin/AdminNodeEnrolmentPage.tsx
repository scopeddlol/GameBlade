import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Field } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useMeshNodes, type LibraryOption } from './meshData.js';

/**
 * Turning a machine into a node: generate a code, paste it into the node.
 *
 * Its own tab rather than the top of the fleet list, because it is a thing an
 * operator does once per machine and then never again — and it was pushing the
 * list of nodes, which is what they came to look at, below the fold.
 */
export function AdminNodeEnrolmentPage() {
  const queryClient = useQueryClient();
  const nodesQuery = useMeshNodes();

  const [label, setLabel] = useState('');
  const [role, setRole] = useState<'origin' | 'mirror'>('origin');
  /** Empty means "make one for it", which is what a new node wants. */
  const [enrolLibraryId, setEnrolLibraryId] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const librariesQuery = useQuery({
    queryKey: ['admin', 'libraries'],
    queryFn: () => api.get<LibraryOption[]>('/admin/libraries'),
  });

  const enrolMutation = useMutation({
    mutationFn: () =>
      api.post<{ token: string }>('/mesh/enrolments', {
        label,
        role,
        libraryId: enrolLibraryId || null,
      }),
    onSuccess: (result) => {
      // Shown once and never again: only its hash is stored.
      setIssued(result.token);
      setLabel('');
      setEnrolLibraryId('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'mesh'] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenHash: string) => api.delete(`/mesh/enrolments/${tokenHash}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'mesh'] }),
  });

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the code stays on screen to copy by hand.
      setCopied(false);
    }
  };

  const enrolments = nodesQuery.data?.enrolments ?? [];

  return (
    <div className="gb-page">
      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">Enrol a node</h2>
        <p className="text-ink-400 mb-4 text-xs">
          A Node is a machine that holds game files. It sends requested chunks to the Coordinator,
          which streams them to the Desktop over HTTPS. Generate a code here, then open the
          Node&rsquo;s own page &mdash;{' '}
          <code className="bg-ink-800 rounded px-1">http://that-machine:8080</code> &mdash; and
          paste it in along with this server&rsquo;s address. It registers itself, gets a library of
          its own, and the code is spent the moment it does.
        </p>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            enrolMutation.mutate();
          }}
        >
          <Field label="Name" htmlFor="nodeLabel">
            <input
              id="nodeLabel"
              className="gb-input w-64"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Home archive"
              required
            />
          </Field>
          <Field label="Role" htmlFor="nodeRole">
            <select
              id="nodeRole"
              className="gb-input w-auto"
              value={role}
              onChange={(e) => setRole(e.target.value as 'origin' | 'mirror')}
            >
              <option value="origin">Origin — it holds the files</option>
              <option value="mirror">Mirror — it copies another node</option>
            </select>
          </Field>
          <Field label="Reports into" htmlFor="nodeLibrary">
            <select
              id="nodeLibrary"
              className="gb-input w-auto"
              value={enrolLibraryId}
              onChange={(e) => setEnrolLibraryId(e.target.value)}
            >
              <option value="">A new library, named after this node</option>
              {(librariesQuery.data ?? []).map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className="gb-btn" disabled={enrolMutation.isPending}>
            Generate code
          </button>
        </form>

        <p className="text-ink-400 mt-3 text-xs">
          Pick an existing library only when this node is taking over one &mdash; replacing
          hardware, or splitting a single-machine server apart. Choosing it here rather than after
          the node registers is what stops the node reporting into a fresh library first and
          orphaning everything attached to the old one.
        </p>

        {issued ? (
          <div className="bg-ink-800 mt-4 rounded-lg p-3">
            <p className="text-ink-400 mb-2 text-xs">
              Copy this now — it is stored only as a hash, so it cannot be shown again. It expires
              in 24 hours if unused.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-sm break-all">{issued}</code>
              <button type="button" className="gb-btn-ghost" onClick={() => void copy(issued)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">
          One node, several drives
        </h2>
        <p className="text-ink-400 text-xs">
          A node holds as many libraries as it has disks. Mount each one under{' '}
          <code className="bg-ink-800 rounded px-1">/libraries</code> in the node&rsquo;s compose
          file and the directory name becomes the library&rsquo;s name:
        </p>
        <pre className="bg-ink-900 text-ink-200 mt-2 overflow-x-auto rounded p-3 font-mono text-xs">
          {`volumes:
  - /mnt/3TB:/libraries/3TB:ro
  - /mnt/E:/libraries/E:ro`}
        </pre>
        <p className="text-ink-500 mt-2 text-[11px]">
          They all report into the one library assigned to that node here, with each drive&rsquo;s
          name in front of the paths from the second drive onward so two drives holding a folder of
          the same name do not collide. Mounting two drives at the same <code>/library</code> is not
          an error to Docker — it keeps one of them and the other is simply never read.
        </p>
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Enrolment codes</h2>
        <div className="space-y-2">
          {enrolments.map((enrolment) => (
            <div
              key={`${enrolment.label}-${enrolment.createdAt}`}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span className="flex items-center gap-2">
                {enrolment.label}
                <Badge tone={enrolment.usedAt ? 'success' : 'neutral'}>
                  {enrolment.usedAt ? 'used' : 'waiting'}
                </Badge>
              </span>
              <span className="text-ink-400 text-xs">
                {enrolment.usedAt
                  ? `used ${formatDateTime(enrolment.usedAt)}`
                  : `expires ${formatDateTime(enrolment.expiresAt)}`}
              </span>
              <button
                type="button"
                className="gb-btn-ghost text-xs"
                disabled={revokeMutation.isPending}
                onClick={() => revokeMutation.mutate(enrolment.tokenHash)}
                aria-label={`Delete enrolment code for ${enrolment.label}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete
              </button>
            </div>
          ))}
          {enrolments.length === 0 ? (
            <p className="text-ink-400 text-sm">No codes have been generated.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
