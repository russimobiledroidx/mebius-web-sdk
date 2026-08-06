/**
 * INTERNAL — local type declaration for the bundled playback library.
 *
 * The library ships no types. Declaring it here (rather than reaching for
 * `any` or a non-literal specifier) buys two things: the call sites stay
 * type-checked, and the import specifier can stay a LITERAL — which is what
 * lets a bundler inline the library into the single-file drop-in build. With a
 * computed specifier the bundler leaves a bare `import("flv.js")` in the
 * output, and that throws in a browser with no module resolver, so the whole
 * mid-latency route silently degrades for exactly the integrators who use the
 * drop-in.
 */
declare module "flv.js" {
  interface FlvPlayer {
    attachMediaElement(el: HTMLVideoElement): void;
    load(): void;
    play(): Promise<void> | void;
    unload(): void;
    detachMediaElement(): void;
    destroy(): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
  }
  interface FlvModule {
    isSupported(): boolean;
    createPlayer(
      source: { type: string; url: string; isLive?: boolean; hasAudio?: boolean; hasVideo?: boolean },
      config?: {
        enableStashBuffer?: boolean;
        stashInitialSize?: number;
        lazyLoad?: boolean;
        autoCleanupSourceBuffer?: boolean;
        autoCleanupMaxBackwardDuration?: number;
        autoCleanupMinBackwardDuration?: number;
        reuseRedirectedURL?: boolean;
        fixAudioTimestampGap?: boolean;
      },
    ): FlvPlayer;
    Events: Record<string, string>;
  }
  const flvjs: FlvModule;
  export default flvjs;
}
