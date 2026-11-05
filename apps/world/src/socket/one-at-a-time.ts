/**
 * Wraps an async task so that calling it while a previous call is still
 * running does nothing. A failure goes to `onError` rather than becoming an
 * unhandled rejection, which would take the process down; the guard is
 * released either way, so one bad run does not stop the next.
 */
export function oneAtATime(
  task: () => Promise<void>,
  onError: (err: unknown) => void,
): () => void {
  let running = false;
  return () => {
    if (running) {
      return;
    }
    running = true;
    task()
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };
}
