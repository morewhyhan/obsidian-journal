declare module "proper-lockfile" {
  export function lockSync(
    file: string,
    options: {
      lockfilePath: string;
      stale: number;
      update: number;
      realpath: boolean;
      onCompromised: (error: Error) => void;
      /** Retry while another (possibly killed) process still holds the lock. */
      retries?:
        | number
        | { retries: number; factor?: number; minTimeout?: number; maxTimeout?: number };
    },
  ): () => void;
}
