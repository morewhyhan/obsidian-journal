declare module "proper-lockfile" {
  export function lockSync(
    file: string,
    options: {
      lockfilePath: string;
      stale: number;
      update: number;
      realpath: boolean;
      onCompromised: (error: Error) => void;
    },
  ): () => void;
}
