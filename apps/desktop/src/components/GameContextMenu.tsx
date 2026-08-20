import type { ClientButton, GameSummary } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Heart,
  HeartOff,
  Info,
  Link2Off,
  Play,
  Trash2,
  X,
} from 'lucide-react';
import { useAddToLibrary, useRemoveFromLibrary } from '../hooks/useLibrary.js';
import { buttonIcon } from '../lib/buttonIcons.js';
import { errorMessage, ipc, type DownloadState, type InstalledGame } from '../lib/ipc.js';
import type { MenuItem } from './ContextMenu.js';

/** Operator-defined links, cached for the session — they change rarely. */
export function useClientButtons(placement?: ClientButton['placement']) {
  return useQuery({
    queryKey: ['client-buttons', placement ?? 'all'],
    queryFn: () =>
      ipc.get<ClientButton[]>(
        `/client-buttons${placement ? `?placement=${encodeURIComponent(placement)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
  });
}

export interface GameMenuActions {
  onOpen: (game: GameSummary) => void;
  onError: (message: string) => void;
  /** Opens the group picker. Omitted where there is nowhere to render it. */
  onManageGroups?: (game: GameSummary) => void;
}

/**
 * Everything the right-click menu on a game can do.
 *
 * Built as one hook rather than per-tab menus so Home, Library and Store all
 * offer the same actions — a menu that changes depending on which grid the
 * same game is shown in is a menu nobody can learn.
 */
export function useGameMenuItems({ onOpen, onError, onManageGroups }: GameMenuActions) {
  const queryClient = useQueryClient();
  const buttonsQuery = useClientButtons('game-menu');
  const addToLibrary = useAddToLibrary();
  const removeFromLibrary = useRemoveFromLibrary();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['games'] });
    void queryClient.invalidateQueries({ queryKey: ['installed'] });
    void queryClient.invalidateQueries({ queryKey: ['home'] });
  };

  const run = <T,>(work: Promise<T>) => {
    work.then(refresh).catch((caught: unknown) => onError(errorMessage(caught)));
  };

  const favouriteMutation = useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      ipc.post(`/games/${id}/favorite`, { favorite }),
    onSuccess: refresh,
    onError: (caught) => onError(errorMessage(caught)),
  });

  return (
    game: GameSummary,
    context: { installed?: InstalledGame; download?: DownloadState; isRunning?: boolean },
  ): MenuItem[] => {
    const { installed, download, isRunning } = context;
    const downloading =
      download?.status === 'downloading' ||
      download?.status === 'queued' ||
      download?.status === 'verifying';

    const items: MenuItem[] = [];

    if (installed) {
      items.push({
        label: isRunning ? 'Running' : 'Play',
        icon: <Play size={14} />,
        disabled: isRunning,
        disabledReason: 'This game is already running',
        onSelect: () => run(ipc.launch(game.id)),
      });
    } else if (downloading) {
      items.push({
        label: 'Cancel download',
        icon: <X size={14} />,
        onSelect: () => run(ipc.cancelDownload(game.id)),
      });
    } else {
      items.push({
        label: 'Install',
        icon: <Download size={14} />,
        disabled: game.isMissing,
        disabledReason: 'This game is no longer on the server',
        onSelect: () => run(ipc.startDownload(game.id)),
      });
    }

    items.push({
      label: 'View details',
      icon: <Info size={14} />,
      onSelect: () => onOpen(game),
    });

    items.push({ kind: 'separator' });

    items.push({
      label: game.isFavorite ? 'Remove from favourites' : 'Add to favourites',
      icon: game.isFavorite ? <HeartOff size={14} /> : <Heart size={14} />,
      onSelect: () => favouriteMutation.mutate({ id: game.id, favorite: !game.isFavorite }),
    });

    items.push({
      label: game.inLibrary ? 'Remove from library' : 'Add to library',
      icon: game.inLibrary ? <X size={14} /> : <Check size={14} />,
      // Optimistic, like the card's own button: the menu closes on select, so
      // waiting on the round trip would leave nothing on screen acknowledging
      // the click.
      onSelect: () =>
        (game.inLibrary ? removeFromLibrary : addToLibrary).mutate(game.id, {
          onError: (caught) => onError(errorMessage(caught)),
        }),
    });

    if (onManageGroups) {
      items.push({
        label: 'Add to group…',
        icon: <FolderPlus size={14} />,
        onSelect: () => onManageGroups(game),
      });
    }

    if (installed) {
      items.push({ kind: 'separator' });
      items.push({
        label: 'Open install folder',
        icon: <FolderOpen size={14} />,
        onSelect: () => run(ipc.openInstallFolder(game.id)),
      });
      items.push({
        // Unlinking and uninstalling are one keystroke apart in this menu, so
        // the labels have to say plainly which one keeps the files.
        label: 'Remove from this PC (keep files)',
        icon: <Link2Off size={14} />,
        disabled: isRunning,
        disabledReason: 'Quit the game first',
        onSelect: () => run(ipc.unlinkInstalled(game.id)),
      });
      items.push({
        label: 'Uninstall (delete files)',
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: isRunning,
        disabledReason: 'Quit the game first',
        onSelect: () => {
          if (
            !confirm(
              `Delete every file of "${game.title}" from ${installed.installPath}?\n\nCloud saves are kept.`,
            )
          ) {
            return;
          }
          run(ipc.uninstall(game.id));
        },
      });
    }

    const custom = buttonsQuery.data ?? [];
    if (custom.length > 0) {
      items.push({ kind: 'separator' });
      for (const button of custom) {
        items.push({
          label: button.label,
          icon: buttonIcon(button.icon, 14) ?? <ExternalLink size={14} />,
          onSelect: () => run(ipc.openExternal(button.url)),
        });
      }
    }

    return items;
  };
}
