import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Database,
  HardDrive,
  Link2,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Server,
  Swords,
  Trash2,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Field, FormError, Notice, PageLoader } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { api, ApiRequestError } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';

interface NodeLibrary {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  games: number;
  chunkedGames: number;
  lastScanAt: string | null;
  lastScanStatus: string | null;
}

interface NodeConnection {
  id: string;
  label: string;
  coordinatorUrl: string;
  libraryId: string;
  enrolled: boolean;
  nodeId: string | null;
  agent: 'stopped' | 'starting' | 'running' | 'error';
  agentError: string | null;
}

interface NodeStatus {
  configured: boolean;
  libraries: NodeLibrary[];
  connections: NodeConnection[];
  syncRunning: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  scan: { state: string; libraryId: string | null };
  chunks: { state: string; currentFile: string | null };
}

export function NodePage() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [libraryName, setLibraryName] = useState('');
  const [libraryPath, setLibraryPath] = useState('');
  const [connectionLabel, setConnectionLabel] = useState('');
  const [coordinatorUrl, setCoordinatorUrl] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [enrolmentToken, setEnrolmentToken] = useState('');

  const statusQuery = useQuery({
    queryKey: ['node', 'status'],
    queryFn: () => api.get<NodeStatus>('/node/status'),
    refetchInterval: 3_000,
  });
  const status = statusQuery.data;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['node', 'status'] });
  const mutationOptions = (message: string) => ({
    onSuccess: () => {
      setNotice(message);
      void refresh();
    },
  });

  const addLibrary = useMutation({
    mutationFn: () =>
      api.post('/node/libraries', { name: libraryName, path: libraryPath, enabled: true }),
    ...mutationOptions('Library added. It is ready to scan.'),
    onSuccess: () => {
      setLibraryName('');
      setLibraryPath('');
      setNotice('Library added. It is ready to scan.');
      void refresh();
    },
  });
  const updateLibrary = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.patch(`/node/libraries/${input.id}`, { enabled: input.enabled }),
    ...mutationOptions('Library updated.'),
  });
  const removeLibrary = useMutation({
    mutationFn: (id: string) => api.delete(`/node/libraries/${id}`),
    ...mutationOptions('Library removed from this Node. Files on disk were not touched.'),
  });
  const addConnection = useMutation({
    mutationFn: () =>
      api.post('/node/connections', {
        label: connectionLabel,
        coordinatorUrl,
        libraryId,
        enrolmentToken,
      }),
    onSuccess: () => {
      setConnectionLabel('');
      setCoordinatorUrl('');
      setEnrolmentToken('');
      setNotice('Coordinator connection added. Enrollment is starting now.');
      void refresh();
    },
  });
  const removeConnection = useMutation({
    mutationFn: (id: string) => api.delete(`/node/connections/${id}`),
    ...mutationOptions('Coordinator connection removed from this Node.'),
  });
  const sync = useMutation({
    mutationFn: (selected?: string) =>
      api.post('/node/sync', selected ? { libraryId: selected } : {}),
    ...mutationOptions('Library sync started. First-time chunk hashing can take a while.'),
  });

  const mutations = [
    addLibrary,
    updateLibrary,
    removeLibrary,
    addConnection,
    removeConnection,
    sync,
  ];
  const error = statusQuery.error ?? mutations.find((entry) => entry.error)?.error;
  const errorMessage = error
    ? error instanceof ApiRequestError
      ? error.message
      : 'The Node could not complete that request.'
    : status?.lastSyncError;

  if (!status && statusQuery.isLoading) return <PageLoader label="Loading Node" />;

  const libraries = status?.libraries ?? [];
  const connections = status?.connections ?? [];
  const games = libraries.reduce((total, library) => total + library.games, 0);
  const ready = libraries.reduce((total, library) => total + library.chunkedGames, 0);
  const online = connections.filter((connection) => connection.agent === 'running').length;
  const busy = Boolean(
    status?.syncRunning || status?.scan.state === 'scanning' || status?.chunks.state === 'hashing',
  );

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="border-ink-800 bg-ink-950/90 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-4">
          <Swords className="text-blade-400 h-6 w-6" aria-hidden />
          <div>
            <h1 className="font-semibold tracking-tight">GameBlade Node</h1>
            <p className="text-ink-400 text-xs">Storage and peer delivery appliance</p>
          </div>
          <button className="gb-btn-ghost ml-auto" type="button" onClick={handleSignOut}>
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out {user ? `(${user.username})` : ''}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-5 py-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            icon={Network}
            label="Coordinators"
            value={`${online} / ${connections.length} online`}
            tone={online === connections.length && online > 0 ? 'success' : 'warning'}
          />
          <Metric icon={HardDrive} label="Libraries" value={`${libraries.length} mounted`} />
          <Metric icon={Database} label="Catalog" value={`${games} games`} />
          <Metric
            icon={Server}
            label="Ready to serve"
            value={`${ready} / ${games}`}
            tone={games > 0 && ready === games ? 'success' : 'neutral'}
          />
        </div>

        <FormError message={errorMessage} />
        <Notice message={notice} />

        <section className="gb-card p-6">
          <SectionHeading
            title="Libraries"
            description="Every path is inside the Node container. Mount host folders read-only, then add each path here."
          >
            <button
              className="gb-btn-ghost"
              type="button"
              disabled={busy || sync.isPending || libraries.length === 0}
              onClick={() => sync.mutate(undefined)}
            >
              <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden />
              Scan all
            </button>
          </SectionHeading>

          <form
            className="mt-5 grid gap-3 sm:grid-cols-[1fr_1.5fr_auto] sm:items-end"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              setNotice(null);
              addLibrary.mutate();
            }}
          >
            <Field label="Library name" htmlFor="library-name">
              <input
                id="library-name"
                className="gb-input"
                value={libraryName}
                onChange={(event) => setLibraryName(event.target.value)}
                placeholder="Main archive"
                required
              />
            </Field>
            <Field label="Container path" htmlFor="library-path">
              <input
                id="library-path"
                className="gb-input font-mono"
                value={libraryPath}
                onChange={(event) => setLibraryPath(event.target.value)}
                placeholder="/library/main"
                required
              />
            </Field>
            <button className="gb-btn-primary" type="submit" disabled={addLibrary.isPending}>
              <Plus className="h-4 w-4" aria-hidden />
              Add
            </button>
          </form>

          <div className="mt-5 space-y-3">
            {libraries.map((library) => (
              <div className="bg-ink-800 rounded-lg p-4" key={library.id}>
                <div className="flex flex-wrap items-start gap-3">
                  <HardDrive className="text-blade-400 mt-0.5 h-5 w-5" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{library.name}</span>
                      <Badge tone={library.enabled ? 'success' : 'neutral'}>
                        {library.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </div>
                    <p className="text-ink-400 mt-1 font-mono text-xs break-all">{library.path}</p>
                    <p className="text-ink-400 mt-2 text-xs">
                      {library.chunkedGames} of {library.games} games ready ·{' '}
                      {library.lastScanAt
                        ? `scanned ${formatDateTime(library.lastScanAt)}`
                        : 'never scanned'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="gb-btn-ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => sync.mutate(library.id)}
                    >
                      Scan
                    </button>
                    <button
                      className="gb-btn-ghost"
                      type="button"
                      onClick={() =>
                        updateLibrary.mutate({ id: library.id, enabled: !library.enabled })
                      }
                    >
                      {library.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className="gb-btn-danger"
                      type="button"
                      onClick={() => removeLibrary.mutate(library.id)}
                      aria-label={`Remove ${library.name}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {libraries.length === 0 ? (
              <p className="text-ink-400 py-6 text-center text-sm">No libraries configured yet.</p>
            ) : null}
          </div>
        </section>

        <section className="gb-card p-6">
          <SectionHeading
            title="Coordinator connections"
            description="Connect any library to any Coordinator. Each pairing has isolated enrollment credentials and a separate serving identity."
          />
          <form
            className="mt-5 grid gap-3 lg:grid-cols-2"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              setNotice(null);
              addConnection.mutate();
            }}
          >
            <Field label="Connection name" htmlFor="connection-name">
              <input
                id="connection-name"
                className="gb-input"
                value={connectionLabel}
                onChange={(event) => setConnectionLabel(event.target.value)}
                placeholder="Public GameBlade"
                required
              />
            </Field>
            <Field label="Library" htmlFor="connection-library">
              <select
                id="connection-library"
                className="gb-input"
                value={libraryId}
                onChange={(event) => setLibraryId(event.target.value)}
                required
              >
                <option value="">Choose a library</option>
                {libraries.map((library) => (
                  <option key={library.id} value={library.id}>
                    {library.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Coordinator URL"
              htmlFor="coordinator-url"
              hint="The public URL clients use."
            >
              <input
                id="coordinator-url"
                className="gb-input"
                type="url"
                value={coordinatorUrl}
                onChange={(event) => setCoordinatorUrl(event.target.value)}
                placeholder="https://games.example.com"
                required
              />
            </Field>
            <Field
              label="Enrollment token"
              htmlFor="enrolment-token"
              hint="Generate an Origin enrollment in that Coordinator's Admin → Nodes page."
            >
              <input
                id="enrolment-token"
                className="gb-input font-mono"
                type="password"
                value={enrolmentToken}
                onChange={(event) => setEnrolmentToken(event.target.value)}
                required
              />
            </Field>
            <button
              className="gb-btn-primary lg:col-span-2 lg:justify-self-start"
              type="submit"
              disabled={addConnection.isPending || libraries.length === 0}
            >
              <Link2 className="h-4 w-4" aria-hidden />
              Add connection
            </button>
          </form>

          <div className="mt-5 space-y-3">
            {connections.map((connection) => {
              const library = libraries.find((entry) => entry.id === connection.libraryId);
              const tone =
                connection.agent === 'running'
                  ? 'success'
                  : connection.agent === 'error'
                    ? 'danger'
                    : 'warning';
              return (
                <div className="bg-ink-800 rounded-lg p-4" key={connection.id}>
                  <div className="flex flex-wrap items-start gap-3">
                    <Network className="text-blade-400 mt-0.5 h-5 w-5" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{connection.label}</span>
                        <Badge tone={tone}>{connection.agent}</Badge>
                        <Badge tone={connection.enrolled ? 'success' : 'warning'}>
                          {connection.enrolled ? 'enrolled' : 'waiting for enrollment'}
                        </Badge>
                      </div>
                      <p className="text-ink-300 mt-1 text-sm">
                        {library?.name ?? 'Removed library'} → {connection.coordinatorUrl}
                      </p>
                      {connection.agentError ? (
                        <p className="mt-2 text-xs" style={{ color: 'var(--status-danger-fg)' }}>
                          {connection.agentError}
                        </p>
                      ) : null}
                      <p className="text-ink-500 mt-1 font-mono text-[11px]">
                        {connection.nodeId ?? 'Node ID pending'}
                      </p>
                    </div>
                    <button
                      className="gb-btn-danger"
                      type="button"
                      onClick={() => removeConnection.mutate(connection.id)}
                      aria-label={`Remove ${connection.label}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              );
            })}
            {connections.length === 0 ? (
              <p className="text-ink-400 py-6 text-center text-sm">
                No Coordinator connections yet.
              </p>
            ) : null}
          </div>
        </section>

        <p className="text-ink-500 text-center text-xs">
          Last completed sync: {status?.lastSyncAt ? formatDateTime(status.lastSyncAt) : 'never'}
        </p>
      </main>
    </div>
  );
}

function SectionHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-ink-300 mt-1 max-w-3xl text-sm">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: typeof Network;
  label: string;
  value: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div className="gb-card flex items-center gap-4 p-4">
      <div className="bg-ink-800 rounded-lg p-2">
        <Icon className="text-blade-400 h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="text-ink-400 text-xs">{label}</p>
        <Badge tone={tone}>{value}</Badge>
      </div>
    </div>
  );
}
