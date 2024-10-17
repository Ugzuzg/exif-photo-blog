import {
  createFederation,
  Follow,
  MemoryKvStore,
  Person,
} from "@fedify/fedify";
import { NextRequest, NextResponse } from "next/server";

const federation = createFederation<null>({
  kv: new MemoryKvStore(),
});

federation.setActorDispatcher(
  "/users/{identifier}",
  async (ctx, identifier) => {
    if (identifier !== "me") return null; // Other than "me" is not found.
    return new Person({
      id: ctx.getActorUri(identifier),
      name: "Me", // Display name
      summary: "This is me!", // Bio
      preferredUsername: identifier, // Bare handle
      url: new URL("/", ctx.url),
      inbox: ctx.getInboxUri(identifier),
    });
  },
);

federation
  .setInboxListeners("/users/{identifier}/inbox", "/inbox")
  .on(Follow, async (ctx, follow) => {
    if (
      follow.id == null ||
      follow.actorId == null ||
      follow.objectId == null
    ) {
      return;
    }
    const parsed = ctx.parseUri(follow.objectId);
    if (parsed?.type !== "actor" || parsed.identifier !== "me") return;
    const follower = await follow.getActor(ctx);
    console.debug(follower);
  });

export async function GET(req: NextRequest) {
  console.log(req.url);
  return await federation.fetch(req, { contextData: null });
}
