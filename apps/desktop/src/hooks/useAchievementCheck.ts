import { evaluateRules, sourcesFor, type AchievementRule } from '@gameblade/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ipc } from '../lib/ipc.js';

interface RulesResponse {
  achievements?: AchievementRule[];
}

/**
 * Works out what a play session earned, and tells the server.
 *
 * Achievements have always been definable here and nothing ever unlocked one;
 * this is what closes that. It runs when a game exits: the rules name files the
 * game itself wrote, the client reads them, and only the resulting keys are
 * sent. The files never leave the machine.
 *
 * Every part of it is allowed to come to nothing — no rules for this game, a
 * save that does not exist yet, a server that cannot be reached. None of that
 * is worth surfacing to someone who has just quit a game, so failures are
 * quiet and the next session tries again.
 */
export function useAchievementCheck() {
  const queryClient = useQueryClient();

  return useCallback(
    async (gameId: string) => {
      try {
        const rules = (await ipc.get<RulesResponse>(`/games/${gameId}/rules`)).achievements ?? [];
        if (rules.length === 0) return;

        // Each file is read once however many rules point at it.
        const contents = new Map<string, string | null>();
        for (const template of sourcesFor(rules)) {
          contents.set(template, await ipc.readRuleFile(gameId, template));
        }

        const unlocked = rules
          .flatMap((rule) => evaluateRules([rule], contents.get(rule.sourceTemplate) ?? null))
          .filter((outcome) => outcome.unlocked)
          .map((outcome) => outcome.achievementKey);

        if (unlocked.length === 0) return;

        await ipc.post(`/games/${gameId}/achievements/report`, { keys: unlocked });

        // The server decides what was actually new; refreshing is how the
        // profile and the game page find out.
        void queryClient.invalidateQueries({ queryKey: ['games'] });
        void queryClient.invalidateQueries({ queryKey: ['achievements'] });
      } catch {
        // Checking is a courtesy on top of a session that has already ended.
      }
    },
    [queryClient],
  );
}
