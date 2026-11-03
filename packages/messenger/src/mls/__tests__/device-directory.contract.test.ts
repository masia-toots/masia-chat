import { defineDirectoryContract } from './contract-directory.js';
import { TestWorld } from './support/world.js';

/** The in-memory fake directory (`TestWorld`) is held to the same contract a real directory is. */
defineDirectoryContract({
  name: 'in-memory directory',
  create: () => {
    const world = new TestWorld();
    return {
      directory: world.directory,
      list: (userId, device) => world.list(userId, device),
      unlist: (userId, deviceId) => world.unlist(userId, deviceId),
    };
  },
});
