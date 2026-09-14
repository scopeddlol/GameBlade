import type { DuplicateCandidate, DuplicateGroup } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, HardDrive, Layers, Link2Off } from 'lucide-react';
import { useState } from 'react';
import { StatTile } from '../../components/charts.js';
import { Badge, RowSkeleton } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { formatBytes, formatRelative } from '../../lib/format.js';

interface DuplicateResponse {
  groups: DuplicateGroup[];
  /** Entries already held as several copies, newest merge first. */
  mergedGroups: DuplicateGroup[];
  merged: number;
}

/** What each rule actually proves, in the order it proves it. */
const REASON_COPY: Record<string, { label: string; tone: 'success' | 'info' | 'warning' }> = {
  content: { label: 'Identical bytes', tone: 'success' },
  package: { label: 'Same package, same size', tone: 'success' },
  metadata: { label: 'Same game, different file', tone: 'warning' },
  manual: { label: 'Merged by hand', tone: 'info' },
};

/**
 * Catalog entries that look like the same game held on two machines.
 *
 * Most of this work never reaches this page. Copies with identical bytes, and
 * copies with the same package name at exactly the same size, are folded
 * together as the reports arrive — that is the ordinary case of moving a
 * library to a second host, and stopping to ask about each of two thousand
 * games would not be a feature.
 *
 * What is left here is the genuinely ambiguous: the same identified game at two
 * different sizes. That is either two builds worth keeping apart or one bad
 * copy, and nothing in the file says which. So it is shown with the evidence —
 * sizes, paths, which machine is holding each — and somebody decides.
 */
export function AdminDuplicatesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const duplicatesQuery = useQuery({
    queryKey: ['admin', 'duplicates'],
    queryFn: () => api.get<DuplicateResponse>('/admin/duplicates'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'duplicates'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
  };

  const unmergeMutation = useMutation({
    mutationFn: (gameId: string) => api.post('/admin/duplicates/unmerge', { gameId }),
    onSuccess: invalidate,
    onError: (caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
  });

  const mergeMutation = useMutation({
    mutationFn: (input: { primaryId: string; duplicateIds: string[] }) =>
      api.post('/admin/duplicates/merge', input),
    onSuccess: invalidate,
    onError: (caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
  });

  const groups = duplicatesQuery.data?.groups ?? [];
  const merged = duplicatesQuery.data?.mergedGroups ?? [];

  return (
    <div className="gb-page">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          label="Held on more than one host"
          value={(duplicatesQuery.data?.merged ?? 0).toLocaleString('en')}
          hint="copies folded into an entry"
        />
        <StatTile
          label="Waiting on a decision"
          value={groups.length.toLocaleString('en')}
          hint={groups.length === 0 ? 'nothing ambiguous' : 'listed below'}
        />
      </div>

      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">Possible duplicates</h2>
        <p className="text-ink-400 mb-4 text-sm">
          One game on two machines is one entry with two copies behind it, and downloads use
          whichever host is up and quickest. Copies that agree byte for byte are folded together
          automatically; these did not agree, so they are left as separate entries until somebody
          says otherwise.
        </p>

        {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}
        {duplicatesQuery.isLoading ? <RowSkeleton rows={3} /> : null}

        {!duplicatesQuery.isLoading && groups.length === 0 ? (
          <p className="text-ink-400 text-sm">
            Nothing ambiguous. Every copy this archive holds has either been matched to an entry or
            is the only copy of it.
          </p>
        ) : null}

        <div className="space-y-3">
          {groups.map((group) => (
            <GroupCard
              key={group.key}
              group={group}
              busy={mergeMutation.isPending}
              onMerge={(primaryId, duplicateIds) => {
                setError(null);
                mergeMutation.mutate({ primaryId, duplicateIds });
              }}
            />
          ))}
        </div>
      </section>

      {merged.length > 0 ? (
        <section className="gb-card p-5">
          <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">
            Held on several hosts
          </h2>
          <p className="text-ink-400 mb-4 text-sm">
            One entry each, with the machines behind it. This is what a mirrored library looks like
            when it is working. If one of these is actually two different games, separate it and
            both come back as entries of their own.
          </p>

          <div className="space-y-3">
            {merged.map((group) => (
              <MergedCard
                key={group.key}
                group={group}
                busy={unmergeMutation.isPending}
                onUnmerge={(gameId) => {
                  setError(null);
                  unmergeMutation.mutate(gameId);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** One entry and the copies folded into it, each separable on its own. */
function MergedCard({
  group,
  busy,
  onUnmerge,
}: {
  group: DuplicateGroup;
  busy: boolean;
  onUnmerge: (gameId: string) => void;
}) {
  const reason = REASON_COPY[group.reason] ?? REASON_COPY.manual!;
  const live = [group.primary, ...group.duplicates].filter((member) => member.online).length;

  return (
    <div className="bg-ink-800 rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="text-ink-500 h-4 w-4" aria-hidden />
        <span className="font-medium">{group.primary.title}</span>
        <Badge tone={reason.tone}>{reason.label}</Badge>
        <Badge tone={live > 0 ? 'success' : 'neutral'}>
          {live} of {group.duplicates.length + 1} online
        </Badge>
      </div>

      <ul className="mt-3 space-y-2">
        {[group.primary, ...group.duplicates].map((member) => (
          <li
            key={member.gameId}
            className="border-ink-700 flex flex-wrap items-center gap-3 rounded-md border p-2.5 text-sm"
          >
            <HardDrive className="text-ink-500 h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{member.libraryName}</span>
              <span className="text-ink-500 block truncate text-xs">{member.relPath}</span>
            </span>
            <span className="text-ink-400 tabular-nums">{formatBytes(member.sizeBytes)}</span>
            <Badge tone={member.online ? 'success' : 'neutral'}>
              {member.online ? 'online' : 'offline'}
            </Badge>
            {member.gameId === group.primary.gameId ? (
              <span className="text-ink-500 text-xs">the entry</span>
            ) : (
              <button
                type="button"
                className="gb-btn-ghost text-xs"
                disabled={busy}
                onClick={() => onUnmerge(member.gameId)}
                title="Make this copy an entry of its own again"
              >
                <Link2Off className="h-3.5 w-3.5" aria-hidden />
                Separate
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One group, with the row that would survive the merge chosen and changeable.
 *
 * Which row survives is the whole decision: it keeps its id, and with it every
 * achievement, save, collection entry and hour of playtime anybody has against
 * this game. The other rows keep their files so their machines can go on
 * serving them, and stop being entries of their own.
 */
function GroupCard({
  group,
  busy,
  onMerge,
}: {
  group: DuplicateGroup;
  busy: boolean;
  onMerge: (primaryId: string, duplicateIds: string[]) => void;
}) {
  const members = [group.primary, ...group.duplicates];
  const [primaryId, setPrimaryId] = useState(group.primary.gameId);
  const reason = REASON_COPY[group.reason] ?? REASON_COPY.metadata!;

  const sizes = new Set(members.map((member) => member.sizeBytes));
  const sameSize = sizes.size === 1;

  return (
    <div className="bg-ink-800 rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Layers className="text-ink-500 h-4 w-4" aria-hidden />
          <span className="font-medium">{group.primary.title}</span>
          <Badge tone={reason.tone}>{reason.label}</Badge>
          {sameSize ? null : (
            // The thing that made this ambiguous in the first place, said out
            // loud rather than left for somebody to spot in the table.
            <Badge tone="warning">Different sizes</Badge>
          )}
        </div>
        <button
          type="button"
          className="gb-btn text-xs"
          disabled={busy}
          onClick={() =>
            onMerge(
              primaryId,
              members
                .filter((member) => member.gameId !== primaryId)
                .map((member) => member.gameId),
            )
          }
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          Merge into the selected entry
        </button>
      </div>

      <ul className="mt-3 space-y-2">
        {members.map((member) => (
          <MemberRow
            key={member.gameId}
            member={member}
            selected={member.gameId === primaryId}
            onSelect={() => setPrimaryId(member.gameId)}
          />
        ))}
      </ul>

      <p className="text-ink-500 mt-2 text-[11px]">
        The selected entry keeps its achievements, saves, collections and playtime. The others keep
        their own files, so the machines holding them go on serving them, and stop appearing as
        separate games.
      </p>
    </div>
  );
}

function MemberRow({
  member,
  selected,
  onSelect,
}: {
  member: DuplicateCandidate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <label
        className={`flex cursor-pointer flex-wrap items-center gap-3 rounded-md border p-2.5 text-sm transition ${
          selected ? 'border-blade-500 bg-blade-500/5' : 'border-ink-700 hover:border-ink-600'
        }`}
      >
        <input
          type="radio"
          className="accent-blade-500"
          checked={selected}
          onChange={onSelect}
          aria-label={`Keep the copy in ${member.libraryName}`}
        />
        <HardDrive className="text-ink-500 h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{member.libraryName}</span>
          <span className="text-ink-500 block truncate text-xs">{member.relPath}</span>
        </span>
        <span className="text-ink-400 tabular-nums">{formatBytes(member.sizeBytes)}</span>
        <Badge tone={member.online ? 'success' : 'neutral'}>
          {member.online ? 'online' : 'offline'}
        </Badge>
        <span className="text-ink-500 text-xs">added {formatRelative(member.addedAt)}</span>
      </label>
    </li>
  );
}
