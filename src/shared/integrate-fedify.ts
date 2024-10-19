import { Actor, Application, Federation } from '@fedify/fedify';
import { getXForwardedRequest } from 'x-forwarded-fetch';
import { randomUUID } from 'node:crypto';

import { getPhoto, getPhotos, getPhotosMeta } from '@/photo/db/query';
import {
  Accept,
  Context,
  Create,
  createFederation,
  Delete,
  exportJwk,
  Follow,
  generateCryptoKeyPair,
  Image,
  importJwk,
  Note,
  Person,
  PropertyValue,
  PUBLIC_COLLECTION,
  type Recipient,
  Undo,
  Update,
} from '@fedify/fedify';
import { PostgresKvStore } from '@fedify/postgres';
import postgres from 'postgres';
import { Temporal } from '@js-temporal/polyfill';
import { Photo } from '@/photo';
import { NextRequest, NextResponse } from 'next/server';

const sql = postgres(process.env.POSTGRES_URL as string);

const kv = new PostgresKvStore(sql);

export const federation = createFederation<null>({
  kv,
});

const activityPubHandle = 'me';

export function integrateFederation<TContextData>(
  federation: Federation<TContextData>,
  contextDataFactory: (
    request: Request,
  ) => TContextData | Promise<TContextData>,
) {
  return async (nextRequest: NextRequest) => {
    const forwardedRequest = await getXForwardedRequest(nextRequest);
    const contextData = await contextDataFactory(forwardedRequest);
    return await federation.fetch(forwardedRequest, {
      contextData,
      onNotFound: () => {
        return new Response('Not found', { status: 404 });
      },
      onNotAcceptable: async (request) => {
        if (nextRequest.nextUrl.pathname.startsWith('/notes/')) {
          return NextResponse.redirect(
            new URL(
              nextRequest.nextUrl.pathname.replace('/notes/', '/p/'),
              nextRequest.nextUrl.href,
            ),
          );
        }

        return new Response('Not acceptable', {
          status: 406,
          headers: {
            'Content-Type': 'text/plain',
            Vary: 'Accept',
          },
        });
      },
    });
  };
}

federation
  .setActorDispatcher('/users/{identifier}', async (ctx, identifier) => {
    if (identifier !== activityPubHandle) return null;
    return new Person({
      id: ctx.getActorUri(identifier),
      name: 'Me',
      summary: 'This is my photo!',
      preferredUsername: identifier,
      url: new URL('/', ctx.url),
      inbox: ctx.getInboxUri(identifier),
      outbox: ctx.getOutboxUri(identifier),
      followers: ctx.getFollowersUri(identifier),
      // The public keys of the actor; they are provided by the key pairs
      // dispatcher we define below:
      publicKeys: (await ctx.getActorKeyPairs(identifier)).map(
        (keyPair) => keyPair.cryptographicKey,
      ),
    });
  })
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    if (identifier != activityPubHandle) return [];
    const entry = await kv.get<{
      privateKey: JsonWebKey;
      publicKey: JsonWebKey;
    }>(['key']);
    if (entry == null) {
      // Generate a new key pair at the first time:
      const { privateKey, publicKey } =
        await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');
      // Store the generated key pair to the Deno KV database in JWK format:
      await kv.set(['key'], {
        privateKey: await exportJwk(privateKey),
        publicKey: await exportJwk(publicKey),
      });
      return [{ privateKey, publicKey }];
    }
    // Load the key pair from the Deno KV database:
    const privateKey = await importJwk(entry.privateKey, 'private');
    const publicKey = await importJwk(entry.publicKey, 'public');
    return [{ privateKey, publicKey }];
  });

federation
  .setInboxListeners('/users/{identifier}/inbox', '/inbox')
  .on(Follow, async (ctx, follow) => {
    if (
      follow.id == null ||
      follow.actorId == null ||
      follow.objectId == null
    ) {
      return;
    }
    const parsed = ctx.parseUri(follow.objectId);
    if (parsed?.type !== 'actor' || parsed.identifier !== activityPubHandle)
      return;
    const follower = await follow.getActor(ctx);
    if (follower == null) return;
    // Note that if a server receives a `Follow` activity, it should reply
    // with either an `Accept` or a `Reject` activity.  In this case, the
    // server automatically accepts the follow request:
    await ctx.sendActivity(
      { identifier: parsed.identifier },
      follower,
      new Accept({ actor: follow.objectId, object: follow }),
    );
    // Store the follower in the key-value store:

    await kv.set(['followers', follow.actorId.href], {
      id: follower.id?.toString(),
      inboxId: follower.inboxId?.toString(),
      endpoints: { sharedInbox: follower.endpoints?.sharedInbox?.toString() },
    });
  })
  .on(Undo, async (ctx, undo) => {
    const follow = await undo.getObject();
    if (!(follow instanceof Follow) || follow.id == null) return;
    if (undo.actorId == null || follow.objectId == null) return;
    const parsed = ctx.parseUri(follow.objectId);
    if (parsed?.type !== 'actor' || parsed?.identifier !== activityPubHandle)
      return;
    await kv.delete(['followers', undo.actorId.href]);
  });

federation
  .setOutboxDispatcher(
    '/users/{identifier}/outbox',
    async (ctx, identifier) => {
      if (identifier !== activityPubHandle) return null;
      const photos = await getPhotos();
      const items = photos.map((photo) => createActivity(ctx, photo));
      return { items, nextCursor: null };
    },
  )
  .setCounter(async (ctx, identifier) => {
    if (identifier !== activityPubHandle) return null;
    return (await getPhotosMeta()).count;
  });

const createNote = (ctx: Context<null>, photo: Photo) => {
  return new Note({
    id: ctx.getObjectUri(Note, { noteId: photo.id }),
    url: ctx.getObjectUri(Note, { noteId: photo.id }),
    summary: null,
    content: photo.title ?? 'Untitled',
    attribution: ctx.getActorUri(activityPubHandle),
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(activityPubHandle),
    published: Temporal.Instant.fromEpochMilliseconds(
      photo.createdAt.getTime(),
    ),
    updated: Temporal.Instant.fromEpochMilliseconds(photo.updatedAt.getTime()),

    attachments: [
      new Image({
        mediaType: 'image/jpeg',
        url: new URL(photo.url),
        attachments: [
          photo.iso &&
            new PropertyValue({
              name: 'ISO',
              value: String(photo.iso),
            }),
          photo.focalLength &&
            new PropertyValue({
              name: 'Focal Length',
              value: String(photo.focalLength),
            }),
        ].filter((v): v is PropertyValue => Boolean(v)),
      }),
    ],
  });
};

const createActivity = (ctx: Context<null>, photo: Photo) => {
  return new Create({
    id: new URL(
      `#${randomUUID()}`,
      ctx.getObjectUri(Note, { noteId: photo.id }),
    ),
    actor: ctx.getActorUri(activityPubHandle),
    published: Temporal.Instant.fromEpochMilliseconds(
      photo.createdAt.getTime(),
    ),
    to: PUBLIC_COLLECTION,
    object: createNote(ctx, photo),
  });
};

federation.setObjectDispatcher(
  Note,
  '/notes/{noteId}',
  async (ctx, { noteId }) => {
    const photo = await getPhoto(noteId);
    if (photo == null) return null;

    return createNote(ctx, photo);
  },
);

federation.setFollowersDispatcher(
  '/users/{identifier}/followers',
  async (ctx, identifier) => {
    if (identifier !== activityPubHandle) return null;

    const followers: { key: string[]; value: string }[] =
      await sql`SELECT * FROM fedify_kv where 'followers'=ANY(key)`;
    const items: Recipient[] = followers.map((followerRow) => {
      const follower: { id: string; inboxId: string; endpoints: any } =
        JSON.parse(followerRow.value);
      return {
        id: new URL(follower.id),
        inboxId: follower.inboxId ? new URL(follower.inboxId) : null,
        endpoints: follower.endpoints.sharedInbox
          ? { sharedInbox: new URL(follower.endpoints.sharedInbox) }
          : null,
      };
    });
    return { items };
  },
);

const baseUrl = new URL(`https://${process.env.NEXT_PUBLIC_SITE_DOMAIN}`);

export const photoCreated = async (photoId: string) => {
  const ctx = federation.createContext(baseUrl, null);
  const photo = await getPhoto(photoId);
  console.log('PhotoCreated', photoId, photo);
  if (photo == null || photo.hidden) return;

  await ctx.sendActivity(
    { identifier: activityPubHandle },
    'followers',
    createActivity(ctx, photo),
  );
};

export const photoUpdated = async (photoId: string) => {
  const ctx = federation.createContext(baseUrl, null);
  const photo = await getPhoto(photoId);
  console.log('PhotoUpdated', photoId, photo);
  if (photo == null || photo.hidden) return;

  await ctx.sendActivity(
    { identifier: activityPubHandle },
    'followers',
    new Update({
      id: new URL(
        `#${randomUUID()}`,
        ctx.getObjectUri(Note, { noteId: photoId }),
      ),
      actor: ctx.getActorUri(activityPubHandle),
      published: Temporal.Instant.fromEpochMilliseconds(Date.now()),
      to: PUBLIC_COLLECTION,
      object: createNote(ctx, photo),
    }),
  );
};

export const photoDeleted = async (photoId: string) => {
  console.log('PhotoDeleted', photoId);
  const ctx = federation.createContext(baseUrl, null);

  await ctx.sendActivity(
    { identifier: activityPubHandle },
    'followers',
    new Delete({
      id: new URL(
        `#${randomUUID()}`,
        ctx.getObjectUri(Note, { noteId: photoId }),
      ),
      actor: ctx.getActorUri(activityPubHandle),
      published: Temporal.Instant.fromEpochMilliseconds(Date.now()),
      to: PUBLIC_COLLECTION,
      object: ctx.getObjectUri(Note, { noteId: photoId }),
    }),
  );
};
