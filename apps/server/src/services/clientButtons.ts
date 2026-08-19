import type { ClientButton, ClientButtonInput, ClientButtonPlacement } from '@gameblade/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { clientButtons } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';

/**
 * Operator-defined links the desktop client renders.
 *
 * The client is given only what it should draw — active rows, in order — while
 * the admin panel sees everything, so a button can be staged before it goes
 * live in the same way a featured slot can.
 */
export class ClientButtonService {
  constructor(private readonly db: Db) {}

  /** Everything, including inactive rows. For the admin panel. */
  listAll(): ClientButton[] {
    return this.db
      .select()
      .from(clientButtons)
      .orderBy(asc(clientButtons.placement), asc(clientButtons.sortOrder), asc(clientButtons.label))
      .all()
      .map(toButton);
  }

  /** What a signed-in client should draw, optionally for one placement. */
  listActive(placement?: ClientButtonPlacement): ClientButton[] {
    const where = placement
      ? and(eq(clientButtons.active, true), eq(clientButtons.placement, placement))
      : eq(clientButtons.active, true);

    return this.db
      .select()
      .from(clientButtons)
      .where(where)
      .orderBy(asc(clientButtons.placement), asc(clientButtons.sortOrder), asc(clientButtons.label))
      .all()
      .map(toButton);
  }

  create(input: ClientButtonInput): ClientButton {
    const record = {
      id: newId('btn'),
      label: input.label,
      url: input.url,
      icon: input.icon,
      placement: input.placement,
      description: input.description ?? null,
      sortOrder: input.sortOrder,
      active: input.active,
      createdAt: isoNow(),
    };
    this.db.insert(clientButtons).values(record).run();
    return toButton(record);
  }

  update(id: string, input: ClientButtonInput): ClientButton {
    const existing = this.db.select().from(clientButtons).where(eq(clientButtons.id, id)).get();
    if (!existing) throw ApiError.notFound('That button no longer exists');

    this.db
      .update(clientButtons)
      .set({
        label: input.label,
        url: input.url,
        icon: input.icon,
        placement: input.placement,
        description: input.description ?? null,
        sortOrder: input.sortOrder,
        active: input.active,
      })
      .where(eq(clientButtons.id, id))
      .run();

    return toButton({ ...existing, ...input, description: input.description ?? null });
  }

  remove(id: string): void {
    this.db.delete(clientButtons).where(eq(clientButtons.id, id)).run();
  }

  /** Applies a new display order, as the admin list's up/down arrows produce. */
  reorder(ids: string[]): void {
    this.db.transaction((tx) => {
      ids.forEach((id, index) => {
        tx.update(clientButtons).set({ sortOrder: index }).where(eq(clientButtons.id, id)).run();
      });
    });
  }
}

function toButton(row: {
  id: string;
  label: string;
  url: string;
  icon: string;
  placement: ClientButtonPlacement;
  description: string | null;
  sortOrder: number;
  active: boolean;
}): ClientButton {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    icon: row.icon,
    placement: row.placement,
    description: row.description,
    sortOrder: row.sortOrder,
    active: row.active,
  };
}
