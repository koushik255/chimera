import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";

type SeriesSummary = {
  id: string;
  title: string;
  volume_count: number;
};

type SeriesResponse = {
  series: { id: string; title: string };
  hosts: Array<{
    hostId: string;
    username: string;
    online: boolean;
    volumes: Array<{
      id: string;
      title: string;
      volumeNumber: number | null;
      pageCount: number;
    }>;
  }>;
};

type VolumeViewResponse = {
  token: string;
  host: {
    id: string;
    username: string;
    online: boolean;
  };
  series: {
    id: string;
    title: string;
  };
  volume: {
    id: string;
    title: string;
    volumeNumber: number | null;
    pageCount: number;
  };
  previewImageUrl: string;
  readerUrl: string;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function fetchSeriesList() {
  return fetchJson<{ series: SeriesSummary[] }>("/api/series");
}

async function fetchSeries(seriesId: string) {
  return fetchJson<SeriesResponse>(`/api/series/${seriesId}`);
}

async function fetchVolumeView(token: string) {
  return fetchJson<VolumeViewResponse>(`/api/volume-view/${token}`);
}

function currentPath() {
  return window.location.pathname;
}

export default function App() {
  const path = createMemo(currentPath);

  return (
    <main class="app-shell">
      <Switch>
        <Match when={path() === "/"}>
          <HomePage />
        </Match>
        <Match when={path().startsWith("/series/")}>
          <SeriesPage seriesId={decodeURIComponent(path().replace("/series/", ""))} />
        </Match>
        <Match when={path().startsWith("/read/")}>
          <ReaderPage token={decodeURIComponent(path().replace("/read/", ""))} />
        </Match>
        <Match when={path().startsWith("/volume-view/")}>
          <VolumeViewPage token={decodeURIComponent(path().replace("/volume-view/", ""))} />
        </Match>
        <Match when={true}>
          <NotFoundPage />
        </Match>
      </Switch>
    </main>
  );
}

function HomePage() {
  const [data] = createResource(fetchSeriesList);

  return (
    <section class="page">
      <h1>chimera</h1>
      <p class="muted">Series indexed by the backend.</p>
      <Show when={!data.loading} fallback={<p>Loading series...</p>}>
        <Show when={data()?.series.length} fallback={<p>No series found.</p>}>
          <ul class="stack-list">
            <For each={data()?.series ?? []}>
              {(series) => (
                <li>
                  <a href={`/series/${series.id}`}>{series.title}</a>
                  <span class="muted"> — {series.volume_count} volumes</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

function SeriesPage(props: { seriesId: string }) {
  const [data] = createResource(() => props.seriesId, fetchSeries);

  async function selectVolume(hostId: string, volumeId: string) {
    const response = await fetchJson<{ token: string; url: string }>("/api/volume-view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId, volumeId }),
    });

    window.location.href = response.url;
  }

  return (
    <section class="page">
      <p><a href="/">Back</a></p>
      <Show when={!data.loading} fallback={<p>Loading series...</p>}>
        <Show when={data()} keyed>
          {(seriesData) => (
            <>
              <h1>{seriesData.series.title}</h1>
              <p class="muted">Only online hosts are shown.</p>
              <Show when={seriesData.hosts.length} fallback={<p>No online hosts for this series.</p>}>
                <div class="host-sections">
                  <For each={seriesData.hosts}>
                    {(host) => (
                      <section class="host-card">
                        <h2>{host.username}</h2>
                        <ul class="stack-list">
                          <For each={host.volumes}>
                            {(volume) => (
                              <li>
                                <button onClick={() => void selectVolume(host.hostId, volume.id)}>
                                  {volume.title}
                                </button>
                                <span class="muted"> — {volume.pageCount} pages</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </section>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </section>
  );
}

function VolumeViewPage(props: { token: string }) {
  const [data] = createResource(() => props.token, fetchVolumeView);

  return (
    <section class="page">
      <Show when={!data.loading} fallback={<p>Loading volume...</p>}>
        <Show when={data()} keyed>
          {(view) => (
            <>
              <p>
                <a href="/">Home</a>
                <span class="muted"> / </span>
                <a href={`/series/${view.series.id}`}>{view.series.title}</a>
              </p>
              <h1>{view.volume.title}</h1>
              <p class="muted">Selected host: {view.host.username}</p>
              <p class="muted">Page count: {view.volume.pageCount}</p>
              <img class="preview-image" src={view.previewImageUrl} alt={`${view.volume.title} preview`} />
              <p>
                <a href={view.readerUrl}>Open reader</a>
              </p>
            </>
          )}
        </Show>
      </Show>
    </section>
  );
}

function ReaderPage(props: { token: string }) {
  const [data] = createResource(() => props.token, fetchVolumeView);
  const [pageIndex, setPageIndex] = createSignal(1);
  const [pageImageUrls, setPageImageUrls] = createSignal<Record<number, string>>({});
  const [imageError, setImageError] = createSignal<string | null>(null);
  const objectUrls = new Map<number, string>();
  const inflightFetches = new Map<number, AbortController>();

  createEffect(() => {
    const current = data();
    if (current && pageIndex() > current.volume.pageCount) {
      setPageIndex(current.volume.pageCount || 1);
    }
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = data();
      if (!current) {
        return;
      }

      if (event.key === "ArrowRight") {
        setPageIndex((page) => Math.min(page + 1, current.volume.pageCount));
      }

      if (event.key === "ArrowLeft") {
        setPageIndex((page) => Math.max(page - 1, 1));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  function pageImageEndpoint(page: number, prefetch = false) {
    const prefetchQuery = prefetch ? "?prefetch=1" : "";
    return `/api/volume-view/${props.token}/page/${page}/image${prefetchQuery}`;
  }

  function storeObjectUrl(page: number, nextObjectUrl: string) {
    const previousObjectUrl = objectUrls.get(page);
    if (previousObjectUrl && previousObjectUrl !== nextObjectUrl) {
      URL.revokeObjectURL(previousObjectUrl);
    }

    objectUrls.set(page, nextObjectUrl);
    setPageImageUrls((current) => ({
      ...current,
      [page]: nextObjectUrl,
    }));
  }

  function removePageImage(page: number) {
    const objectUrl = objectUrls.get(page);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrls.delete(page);
    }

    inflightFetches.get(page)?.abort();
    inflightFetches.delete(page);

    setPageImageUrls((current) => {
      if (!(page in current)) {
        return current;
      }

      const next = { ...current };
      delete next[page];
      return next;
    });
  }

  async function ensurePageImageLoaded(page: number, prefetch = false) {
    const view = data();
    if (!view || page < 1 || page > view.volume.pageCount) {
      return;
    }

    if (objectUrls.has(page) || inflightFetches.has(page)) {
      return;
    }

    const controller = new AbortController();
    inflightFetches.set(page, controller);

    try {
      const response = await fetch(pageImageEndpoint(page, prefetch), { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const imageBlob = await response.blob();
      if (controller.signal.aborted) {
        return;
      }

      storeObjectUrl(page, URL.createObjectURL(imageBlob));

      if (page === pageIndex()) {
        setImageError(null);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      if (page === pageIndex()) {
        setImageError(String(error));
      }
    } finally {
      inflightFetches.delete(page);
    }
  }

  createEffect(() => {
    const view = data();
    const currentPage = pageIndex();
    if (!view) {
      return;
    }

    const nextPage = currentPage < view.volume.pageCount ? currentPage + 1 : null;
    const keepPages = new Set<number>([currentPage]);
    if (nextPage !== null) {
      keepPages.add(nextPage);
    }

    for (const page of [...objectUrls.keys()]) {
      if (!keepPages.has(page)) {
        removePageImage(page);
      }
    }

    for (const [page, controller] of inflightFetches.entries()) {
      if (!keepPages.has(page)) {
        controller.abort();
        inflightFetches.delete(page);
      }
    }

    void ensurePageImageLoaded(currentPage);

    const currentPageReady = Boolean(pageImageUrls()[currentPage]);
    if (currentPageReady && nextPage !== null) {
      void ensurePageImageLoaded(nextPage, true);
    }
  });

  onCleanup(() => {
    for (const controller of inflightFetches.values()) {
      controller.abort();
    }

    for (const objectUrl of objectUrls.values()) {
      URL.revokeObjectURL(objectUrl);
    }
  });

  return (
    <section class="page">
      <Show when={!data.loading} fallback={<p>Loading reader...</p>}>
        <Show when={data()} keyed>
          {(view) => (
            <>
              <p>
                <a href={`/volume-view/${view.token}`}>Back to volume</a>
              </p>
              <h1>{view.volume.title}</h1>
              <p class="muted">Host: {view.host.username}</p>
              <p class="muted">Page {pageIndex()} / {view.volume.pageCount}</p>
              <div class="reader-controls">
                <button onClick={() => setPageIndex((page) => Math.max(page - 1, 1))}>Previous</button>
                <button onClick={() => setPageIndex((page) => Math.min(page + 1, view.volume.pageCount))}>Next</button>
              </div>
              <Show when={!imageError()} fallback={<p>Failed to load page image: {imageError()}</p>}>
                <Show when={pageImageUrls()[pageIndex()]} fallback={<p>Loading page image...</p>}>
                  {(imageUrl) => (
                    <img class="preview-image" src={imageUrl()} alt={`${view.volume.title} page ${pageIndex()}`} />
                  )}
                </Show>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </section>
  );
}

function NotFoundPage() {
  return (
    <section class="page">
      <h1>Not found</h1>
      <p><a href="/">Go home</a></p>
    </section>
  );
}
