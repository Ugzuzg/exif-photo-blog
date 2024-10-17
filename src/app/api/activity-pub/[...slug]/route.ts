import { getPhotos } from '@/photo/db/query';
import {
  Accept,
  Article,
  Create,
  createFederation,
  exportJwk,
  Follow,
  generateCryptoKeyPair,
  importJwk,
  MemoryKvStore,
  Person,
  Undo,
} from '@fedify/fedify';
import { NextRequest, NextResponse } from 'next/server';

const kv = new MemoryKvStore();

const federation = createFederation<null>({
  kv,
});

federation
  .setActorDispatcher('/users/{identifier}', async (ctx, identifier) => {
    if (identifier !== 'me') return null;
    return new Person({
      id: ctx.getActorUri(identifier),
      name: 'Me',
      summary: 'This is me!',
      preferredUsername: identifier,
      url: new URL('/', ctx.url),
      inbox: ctx.getInboxUri(identifier),
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
    await kv.set(['followers', follow.id.href], follow.actorId.href);
  })
  .on(Undo, async (ctx, undo) => {
    const object = await undo.getObject();
    if (!(object instanceof Follow)) return;
    if (undo.actorId == null || object.objectId == null) return;
    const parsed = ctx.parseUri(object.objectId);
    if (parsed?.type !== 'actor' || parsed?.identifier !== 'me') return;
    console.log(undo);
    console.log(parsed);
    console.log(object);
    // await kv.delete(['followers', parsed.identifier]);
  });

federation.setOutboxDispatcher(
  '/users/{identifier}/outbox',
  async (ctx, identifier) => {
    // Work with the database to find the activities that the actor has sent
    // (the following `getPostsByUserId` is a hypothetical function):
    const photos = await getPhotos();
    // Turn the posts into `Create` activities:
    const items = photos.map(
      (photo) =>
        new Create({
          id: new URL(`/posts/${photo.id}#activity`, ctx.url),
          actor: ctx.getActorUri(identifier),
          object: new Article({
            id: new URL(`/p/${photo.id}`, ctx.url),
            summary: photo.title,
            image: new URL(photo.url),
          }),
        }),
    );
    return { items };
  },
);

export async function GET(req: NextRequest) {
  console.log(req.url);
  return await federation.fetch(req, { contextData: null });
}

export async function POST(req: NextRequest) {
  console.log(req.url);
  return await federation.fetch(req, { contextData: null });
}
