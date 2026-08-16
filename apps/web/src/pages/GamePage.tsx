import type { GameDetail, GameFileEntry, MetadataCandidate } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Download,
  FileArchive,
  Heart,
  Image as ImageIcon,
  RefreshCw,
  Search,
  Star,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, ErrorState, PageLoader, Spinner } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { api } from '../lib/api.js';
import { API_BASE } from '../lib/base.js';
import { formatBytes, formatDate } from '../lib/format.js';

export function GamePage() {
  const { id = '' } = useParams();
  const { isAdmin } = useSession();
  const queryClient = useQueryClient();
  const [showFiles, setShowFiles] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);

  const gameQuery = useQuery({
    queryKey: ['game', id],
    queryFn: () => api.get<GameDetail>(`/games/${id}`),
    enabled: Boolean(id),
  });

  const filesQuery = useQuery({
    queryKey: ['game', id, 'files'],
    queryFn: () => api.get<GameFileEntry[]>(`/games/${id}/files`),
    enabled: showFiles && Boolean(id),
  });

  const favoriteMutation = useMutation({
    mutationFn: (favorite: boolean) => api.post(`/games/${id}/favorite`, { favorite }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['game', id] }),
  });

  const artworkMutation = useMutation({
    mutationFn: () => api.post(`/games/${id}/refresh-artwork`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['game', id] }),
  });

  if (gameQuery.isLoading) return <PageLoader label="Loading game" />;
  if (gameQuery.isError || !gameQuery.data) {
    return (
      <ErrorState
        title="Game not found"
        message={(gameQuery.error as Error | undefined)?.message}
        action={
          <Link to="/" className="gb-btn-ghost">
            Back to library
          </Link>
        }
      />
    );
  }

  const game = gameQuery.data;
  const downloadUrl = `${API_BASE}/download/${game.id}`;

  return (
    <div className="space-y-6">
      {/* Hero banner, faded into the page so text stays readable over any art. */}
      <div className="relative -mx-4 -mt-6 sm:-mx-6">
        {game.art.hero ? (
          <div className="hero-fade absolute inset-0 h-[340px] overflow-hidden">
            <img src={game.art.hero} alt="" className="h-full w-full object-cover opacity-40" />
          </div>
        ) : null}

        <div className="relative px-4 pt-6 sm:px-6">
          <Link
            to="/"
            className="text-ink-300 hover:text-ink-100 mb-4 inline-flex items-center gap-2 text-sm"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Library
          </Link>

          <div className="flex flex-col gap-6 md:flex-row">
            <div className="w-40 shrink-0 sm:w-48">
              {game.art.cover ? (
                <img
                  src={game.art.cover}
                  alt=""
                  className="ring-ink-700 w-full rounded-xl shadow-2xl shadow-black/60 ring-1"
                />
              ) : (
                <div className="bg-ink-800 ring-ink-700 flex aspect-[2/3] w-full items-center justify-center rounded-xl ring-1">
                  <ImageIcon className="text-ink-500 h-10 w-10" aria-hidden />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              {game.art.logo ? (
                <img
                  src={game.art.logo}
                  alt={game.title}
                  className="mb-3 max-h-24 max-w-full object-contain"
                />
              ) : (
                <h1 className="mb-3 text-3xl font-bold tracking-tight">{game.title}</h1>
              )}

              <div className="text-ink-300 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                {game.releaseDate ? <span>{formatDate(game.releaseDate)}</span> : null}
                {game.rating !== null ? (
                  <span className="inline-flex items-center gap-1">
                    <Star className="h-4 w-4 fill-amber-400 text-amber-400" aria-hidden />
                    {game.rating}
                  </span>
                ) : null}
                <span>{formatBytes(game.sizeBytes)}</span>
                <span>
                  {game.fileCount} {game.fileCount === 1 ? 'file' : 'files'}
                </span>
                <Badge tone={game.kind === 'archive' ? 'info' : 'neutral'}>{game.kind}</Badge>
                {game.matchStatus === 'unmatched' ? (
                  <Badge tone="warning">No metadata</Badge>
                ) : null}
                {game.isMissing ? <Badge tone="danger">Files missing</Badge> : null}
              </div>

              {game.genres.length > 0 ? (
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {game.genres.map((g) => (
                    <Badge key={g}>{g}</Badge>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={downloadUrl}
                  className="gb-btn-primary"
                  // Let the server's Content-Disposition drive the filename.
                  download
                >
                  <Download className="h-4 w-4" aria-hidden />
                  {game.kind === 'archive' ? 'Download' : 'Download as ZIP'}
                </a>

                <button
                  type="button"
                  className={game.isFavorite ? 'gb-btn-primary' : 'gb-btn-ghost'}
                  onClick={() => favoriteMutation.mutate(!game.isFavorite)}
                  disabled={favoriteMutation.isPending}
                  aria-pressed={game.isFavorite}
                >
                  <Heart
                    className={game.isFavorite ? 'h-4 w-4 fill-current' : 'h-4 w-4'}
                    aria-hidden
                  />
                  {game.isFavorite ? 'Favourited' : 'Favourite'}
                </button>

                {game.kind === 'folder' ? (
                  <button
                    type="button"
                    className="gb-btn-ghost"
                    onClick={() => setShowFiles((v) => !v)}
                    aria-expanded={showFiles}
                  >
                    <FileArchive className="h-4 w-4" aria-hidden />
                    {showFiles ? 'Hide files' : 'Browse files'}
                  </button>
                ) : null}

                {isAdmin ? (
                  <>
                    <button
                      type="button"
                      className="gb-btn-ghost"
                      onClick={() => setMatchOpen((v) => !v)}
                    >
                      <Search className="h-4 w-4" aria-hidden />
                      Match metadata
                    </button>
                    <button
                      type="button"
                      className="gb-btn-ghost"
                      onClick={() => artworkMutation.mutate()}
                      disabled={artworkMutation.isPending}
                    >
                      {artworkMutation.isPending ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <RefreshCw className="h-4 w-4" aria-hidden />
                      )}
                      Refresh artwork
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {game.summary ? (
        <section className="max-w-3xl">
          <h2 className="mb-2 text-sm font-semibold tracking-wide uppercase">Summary</h2>
          <p className="text-ink-200 text-sm leading-relaxed">{game.summary}</p>
        </section>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailBlock label="Developers" values={game.developers} />
        <DetailBlock label="Publishers" values={game.publishers} />
        <DetailBlock label="Platforms" values={game.platforms} />
        <DetailBlock label="Library" values={[game.libraryName]} />
      </section>

      {game.screenshots.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold tracking-wide uppercase">Screenshots</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {game.screenshots.map((url) => (
              <img
                key={url}
                src={url}
                alt=""
                loading="lazy"
                className="ring-ink-700 aspect-video w-full rounded-lg object-cover ring-1"
              />
            ))}
          </div>
        </section>
      ) : null}

      {showFiles ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold tracking-wide uppercase">Files</h2>
          {filesQuery.isLoading ? (
            <PageLoader label="Loading files" />
          ) : (
            <div className="gb-card divide-ink-700/70 divide-y">
              {(filesQuery.data ?? []).map((file) => (
                <div key={file.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="text-ink-200 min-w-0 flex-1 truncate font-mono text-xs">
                    {file.path}
                  </span>
                  <span className="text-ink-400 shrink-0 text-xs">
                    {formatBytes(file.sizeBytes)}
                  </span>
                  <a
                    href={`${API_BASE}/download/${game.id}/files/${file.id}`}
                    className="text-blade-400 shrink-0 hover:underline"
                    download
                  >
                    Download
                  </a>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {isAdmin && matchOpen ? (
        <MatchPanel game={game} onDone={() => setMatchOpen(false)} />
      ) : null}
    </div>
  );
}

function DetailBlock({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="gb-card p-4">
      <h3 className="gb-label">{label}</h3>
      <p className="text-ink-200 text-sm">{values.join(', ')}</p>
    </div>
  );
}

/** Admin-only IGDB search so a mis-parsed folder name can be corrected by hand. */
function MatchPanel({ game, onDone }: { game: GameDetail; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [term, setTerm] = useState(game.title);
  const [submittedTerm, setSubmittedTerm] = useState(game.title);

  const candidatesQuery = useQuery({
    queryKey: ['game', game.id, 'candidates', submittedTerm],
    queryFn: () =>
      api.get<MetadataCandidate[]>(
        `/games/${game.id}/candidates?q=${encodeURIComponent(submittedTerm)}`,
      ),
    retry: false,
  });

  const applyMutation = useMutation({
    mutationFn: (igdbId: number | null) =>
      api.post(`/games/${game.id}/match`, { igdbId, refreshArtwork: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['game', game.id] });
      await queryClient.invalidateQueries({ queryKey: ['games'] });
      onDone();
    },
  });

  return (
    <section className="gb-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Match metadata (IGDB)</h2>
        <button type="button" className="text-ink-400 hover:text-ink-100 text-sm" onClick={onDone}>
          Close
        </button>
      </div>

      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmittedTerm(term);
        }}
      >
        <input
          className="gb-input"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="Search IGDB"
        />
        <button type="submit" className="gb-btn-ghost shrink-0">
          Search
        </button>
      </form>

      {candidatesQuery.isError ? (
        <p className="text-sm text-amber-300">{(candidatesQuery.error as Error).message}</p>
      ) : null}
      {candidatesQuery.isLoading ? <PageLoader label="Searching IGDB" /> : null}

      <div className="space-y-2">
        {(candidatesQuery.data ?? []).map((candidate) => (
          <div key={candidate.id} className="bg-ink-800 flex items-center gap-3 rounded-lg p-2">
            {candidate.coverUrl ? (
              // Provider thumbnails are only shown here, before anything is cached.
              <img src={candidate.coverUrl} alt="" className="h-16 w-11 rounded object-cover" />
            ) : (
              <div className="bg-ink-700 h-16 w-11 rounded" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{candidate.title}</p>
              <p className="text-ink-400 truncate text-xs">
                {candidate.releaseDate ? formatDate(candidate.releaseDate) : 'Unknown date'}
                {candidate.platforms.length > 0 ? ` · ${candidate.platforms.join(', ')}` : ''}
              </p>
            </div>
            <button
              type="button"
              className="gb-btn-primary shrink-0"
              onClick={() => applyMutation.mutate(candidate.id)}
              disabled={applyMutation.isPending}
            >
              Use this
            </button>
          </div>
        ))}
      </div>

      {game.igdbId !== null ? (
        <button
          type="button"
          className="gb-btn-danger mt-4"
          onClick={() => applyMutation.mutate(null)}
          disabled={applyMutation.isPending}
        >
          Clear current match
        </button>
      ) : null}
    </section>
  );
}
