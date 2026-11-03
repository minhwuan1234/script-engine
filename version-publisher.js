// Provider callbacks are synchronous. Serialize storage writes without blocking
// upstream stream consumption, and publish each version only after it is durable.
export function createVersionPublisher({ store, submissionId, ownerToken, sendEvent, onSent = () => {} }) {
  let pending = Promise.resolve();
  let failed = false;
  return {
    publish(letter, version) {
      pending = pending.then(async () => {
        if (failed) return;
        if (store && submissionId) await store.saveVersion(submissionId, letter, version);
        const access = store && submissionId ? { submissionId, downloadOwnerToken: ownerToken } : {};
        sendEvent(`version_${letter.toLowerCase()}`, { ...version, ...access });
        onSent(letter);
      }).catch(() => { failed = true; });
    },
    async drain() {
      await pending;
      if (failed) throw new Error('Could not save the generated version. Please retry.');
    },
  };
}
