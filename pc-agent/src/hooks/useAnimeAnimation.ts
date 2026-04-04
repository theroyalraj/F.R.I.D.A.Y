import { useEffect, useRef, DependencyList } from 'react';

// Type for anime.js library (dynamic import)
type AnimeLib = typeof import('anime').default;

export interface AnimeConfig {
  [key: string]: any;
}

/**
 * Custom hook to integrate anime.js animations with React components.
 * Handles setup, cleanup, and scope management automatically.
 */
export function useAnimeAnimation(
  ref: React.RefObject<HTMLElement>,
  animationConfigOrFn: AnimeConfig | ((anime: AnimeLib) => AnimeConfig),
  deps: DependencyList = []
): void {
  const animeRef = useRef<any>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!ref.current) return;

    // Dynamically import anime.js
    const loadAnime = async () => {
      try {
        // First try to use global anime if available (e.g., from CDN)
        if (typeof window !== 'undefined' && (window as any).anime) {
          const anime = (window as any).anime;

          if (typeof animationConfigOrFn === 'function') {
            const config = animationConfigOrFn(anime);
            animeRef.current = anime({ ...config, autoplay: true });
          } else {
            animeRef.current = anime({ ...animationConfigOrFn, autoplay: true });
          }
          loadedRef.current = true;
          return;
        }

        // Fallback: try to import from npm
        try {
          const animeModule = await import('anime');
          const anime = animeModule.default;

          if (typeof animationConfigOrFn === 'function') {
            const config = animationConfigOrFn(anime);
            animeRef.current = anime({ ...config, autoplay: true });
          } else {
            animeRef.current = anime({ ...animationConfigOrFn, autoplay: true });
          }
          loadedRef.current = true;
        } catch {
          console.warn('anime.js not available via npm, expected to be loaded from CDN');
        }
      } catch (err) {
        console.error('Failed to load anime.js:', err);
      }
    };

    loadAnime();

    // Cleanup
    return () => {
      if (animeRef.current) {
        animeRef.current.pause?.();
        animeRef.current = null;
      }
    };
  }, [ref, animationConfigOrFn, ...deps]);
}

/**
 * Hook for complex anime.js timelines with scope API.
 */
export function useAnimeTimeline(
  ref: React.RefObject<HTMLElement>,
  setupTimeline: (anime: AnimeLib) => void,
  deps: DependencyList = []
): void {
  const timelineRef = useRef<any>(null);
  const scopeRef = useRef<any>(null);

  useEffect(() => {
    if (!ref.current) return;

    const setupAnimation = async () => {
      try {
        // Try global anime first
        const anime = typeof window !== 'undefined' && (window as any).anime ? (window as any).anime : null;

        if (!anime) {
          console.warn('anime.js not available');
          return;
        }

        // Create scope for this component
        scopeRef.current = anime.createScope((targets: any) => {
          timelineRef.current = anime.timeline({
            autoplay: true,
          });

          // Call the setup function with anime and timeline context
          setupTimeline(anime);
        }, { root: ref.current });

        // Return scope for cleanup
        return scopeRef.current;
      } catch (err) {
        console.error('Failed to setup anime timeline:', err);
      }
    };

    const scope = setupAnimation();

    return () => {
      if (timelineRef.current) {
        timelineRef.current.pause?.();
        timelineRef.current = null;
      }
      if (scope?.revert) {
        scope.revert();
      }
      scopeRef.current = null;
    };
  }, [ref, setupTimeline, ...deps]);
}
