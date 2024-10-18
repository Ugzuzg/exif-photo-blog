import { getPhoto, getPhotos, getPhotosMeta } from '@/photo/db/query';
import { integrateFederation } from '@/shared/integrate-fedify';
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
  RequestContext,
  Undo,
  Update,
} from '@fedify/fedify';
import { PostgresKvStore, PostgresMessageQueue } from '@fedify/postgres';
import postgres from 'postgres';
import { Temporal } from '@js-temporal/polyfill';
import { Photo } from '@/photo';
import { emitter } from '@/shared/events';

const sql = postgres(process.env.POSTGRES_URL);

const kv = new PostgresKvStore(sql);

const federation = createFederation<null>({
  kv,
  queue: new PostgresMessageQueue(sql),
});

const requestHanlder = integrateFederation(federation, () => {});

export {
  requestHanlder as DELETE,
  requestHanlder as GET,
  requestHanlder as PATCH,
  requestHanlder as POST,
  requestHanlder as PUT,
};

federation
  .setActorDispatcher('/users/{identifier}', async (ctx, identifier) => {
    if (identifier !== 'me') return null;
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
    if (identifier != 'me') return []; // Other than "me" is not found.
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
    if (parsed?.type !== 'actor' || parsed.identifier !== 'me') return;
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

    await kv.set(['followers', follow.actorId.href], follow.actorId.href);
  })
  .on(Undo, async (ctx, undo) => {
    const follow = await undo.getObject();
    if (!(follow instanceof Follow) || follow.id == null) return;
    if (undo.actorId == null || follow.objectId == null) return;
    const parsed = ctx.parseUri(follow.objectId);
    if (parsed?.type !== 'actor' || parsed?.identifier !== 'me') return;
    await kv.delete(['followers', undo.actorId.href]);
  });

federation
  .setOutboxDispatcher(
    '/users/{identifier}/outbox',
    async (ctx, identifier) => {
      // Work with the database to find the activities that the actor has sent
      // (the following `getPostsByUserId` is a hypothetical function):
      const photos = await getPhotos();
      // Turn the posts into `Create` activities:
      const items = photos.map((photo) => createActivity(ctx, photo));
      return { items, nextCursor: null };
    },
  )
  .setCounter(async (ctx, identifier) => {
    // The following `countPostsByUserId` is a hypothetical function:
    return (await getPhotosMeta()).count;
  });

const createNote = (ctx: Context<null>, photo: Photo) => {
  return new Note({
    id: ctx.getObjectUri(Note, { noteId: photo.id }),
    url: ctx.getObjectUri(Note, { noteId: photo.id }),
    summary: null,
    content: photo.title ?? 'Untitled',
    attribution: ctx.getActorUri('me'),
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri('me'),
    published: Temporal.Instant.fromEpochMilliseconds(
      photo.createdAt.getTime(),
    ),

    attachments: [
      new Image({
        mediaType: 'image/jpeg',
        url: new URL(photo.url),
        name: 'asb',
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
        ].filter(Boolean),
      }),
    ],
  });
};

const createActivity = (ctx: Context<null>, photo: Photo) => {
  return new Create({
    id: ctx.getObjectUri(Create, { noteId: photo.id }),
    actor: ctx.getActorUri('me'),
    published: Temporal.Instant.fromEpochMilliseconds(
      photo.createdAt.getTime(),
    ),
    to: new URL('https://www.w3.org/ns/activitystreams#Public'),
    object: createNote(ctx, photo),
  });
};

federation.setObjectDispatcher(
  Create,
  '/notes/{noteId}/activity',
  async (ctx, { noteId }) => {
    const photo = await getPhoto(noteId);
    if (photo == null) return null;
    return createActivity(ctx, photo);
  },
);

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
    const followers: { key: string[]; value: string }[] =
      await sql`SELECT * FROM fedify_kv where 'followers'=ANY(key)`;
    const items: Recipient[] = followers.map((follower) => ({
      id: new URL(JSON.parse(follower.value)),
      inboxId: null,
    }));
    return { items };
  },
);

const baseUrl = new URL(`https://${process.env.NEXT_PUBLIC_SITE_DOMAIN}`);

emitter.on('PhotoCreated', async ({ photoId }) => {
  const ctx = federation.createContext(baseUrl, null);
  const photo = await getPhoto(photoId);
  if (photo == null) return;

  ctx.sendActivity(
    { identifier: 'me' },
    'followers',
    createActivity(ctx, photo),
  );
});

emitter.on('PhotoUpdated', async ({ photoId }) => {
  const ctx = federation.createContext(baseUrl, null);
  const photo = await getPhoto(photoId);
  if (photo == null) return;

  ctx.sendActivity(
    { identifier: 'me' },
    'followers',
    new Update({
      actor: ctx.getActorUri('me'),
      object: createNote(ctx, photo),
    }),
  );
});

emitter.on('PhotoDeleted', async ({ photoId }) => {
  const ctx = federation.createContext(baseUrl, null);

  ctx.sendActivity(
    { identifier: 'me' },
    'followers',
    new Delete({
      id: ctx.getObjectUri(Note, { noteId: photoId }),
      actor: ctx.getActorUri('me'),
      published: Temporal.Instant.fromEpochMilliseconds(Date.now()),
      to: PUBLIC_COLLECTION,
    }),
  );
});
