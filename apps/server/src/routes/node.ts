import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createLibrarySchema, updateLibrarySchema } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { libraries } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

const connectionSchema = z.object({
  label: z.string().trim().min(1).max(64),
  coordinatorUrl: z.string().trim().min(1).max(2_048),
  libraryId: z.string().trim().min(1).max(64),
  enrolmentToken: z.string().trim().min(8).max(200),
});

const syncSchema = z.object({ libraryId: z.string().trim().min(1).max(64).optional() });

/** The deliberately small management surface exposed by the Node image. */
export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  const { db, nodeRuntime } = app.gameblade;

  app.get('/node/status', async (request) => {
    requireAdmin(request);
    return nodeRuntime.status();
  });

  app.post('/node/connections', async (request, reply) => {
    requireAdmin(request);
    const result = await nodeRuntime.addConnection(connectionSchema.parse(request.body));
    return reply.code(201).send(result);
  });

  app.delete('/node/connections/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    await nodeRuntime.removeConnection(id);
    return { ok: true };
  });

  app.post('/node/libraries', async (request, reply) => {
    requireAdmin(request);
    const input = createLibrarySchema.parse(request.body);
    const resolved = path.resolve(input.path);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) {
      throw ApiError.badRequest(
        `"${resolved}" is not a readable directory inside the container. Check its volume mount.`,
      );
    }
    if (db.select().from(libraries).where(eq(libraries.path, resolved)).get()) {
      throw ApiError.conflict('That path is already a library');
    }
    const library = {
      id: newId('lib'),
      name: input.name,
      path: resolved,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
      lastScanAt: null,
      lastScanStatus: null,
    };
    db.insert(libraries).values(library).run();
    return reply.code(201).send(library);
  });

  app.patch('/node/libraries/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = updateLibrarySchema.parse(request.body);
    const existing = db.select().from(libraries).where(eq(libraries.id, id)).get();
    if (!existing) throw ApiError.notFound('Library not found');

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.path !== undefined) {
      const resolved = path.resolve(input.path);
      const info = await stat(resolved).catch(() => null);
      if (!info?.isDirectory()) {
        throw ApiError.badRequest(`"${resolved}" is not a readable directory inside the container`);
      }
      patch.path = resolved;
    }
    if (Object.keys(patch).length > 0) {
      db.update(libraries).set(patch).where(eq(libraries.id, id)).run();
      await nodeRuntime.refreshLibrary(id);
    }
    return nodeRuntime.status();
  });

  app.delete('/node/libraries/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const status = await nodeRuntime.status();
    if (status.connections.some((connection) => connection.libraryId === id)) {
      throw ApiError.conflict('Remove this library’s Coordinator connections first');
    }
    db.delete(libraries).where(eq(libraries.id, id)).run();
    return { ok: true };
  });

  app.post('/node/sync', async (request, reply) => {
    requireAdmin(request);
    const input = syncSchema.parse(request.body ?? {});
    const status = await nodeRuntime.status();
    if (status.connections.length === 0) {
      throw ApiError.badRequest('Add at least one Coordinator connection before syncing');
    }
    void nodeRuntime.sync(input.libraryId);
    return reply.code(202).send({ ok: true });
  });
}
