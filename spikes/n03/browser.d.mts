export function openBrowser(directory: string, token: string, modulePath: string, executablePath: string): Promise<{
  start(url: string, id: string): Promise<void>;
  reload(): Promise<void>;
  offline(value: boolean): Promise<void>;
  finish(artifacts: readonly { path: string; sha256: string }[]): Promise<unknown>;
  close(): Promise<void>;
}>;
