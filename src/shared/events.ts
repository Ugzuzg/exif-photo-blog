import { EventEmitter } from 'node:events';

type EventMap = {
  PhotoCreated: [{ photoId: string }];
  PhotoUpdated: [{ photoId: string }];
  PhotoDeleted: [{ photoId: string }];
};

class MyEmitter extends EventEmitter<EventMap> {}

export const emitter = new MyEmitter();
