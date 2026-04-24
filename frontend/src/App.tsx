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

type HostLatencyTestResponse = {
  hostId: string;
  volumeId: string;
  pageId: string;
  pageIndex: number;
  elapsedMs: number;
  bytes: number;
  contentType: string;
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

async function testHostLatency(hostId: string, volumeId: string) {
  return fetchJson<HostLatencyTestResponse>("/api/host-latency-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId, volumeId }),
  });
}

function currentPath() {
  return window.location.pathname;
}

export default function App() {
  const path = createMemo(currentPath);
  const isReaderRoute = createMemo(() => path().startsWith("/read/"));

  return (
    <main class={`app-shell${isReaderRoute() ? " app-shell--reader" : ""}`}>
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
  const [testingHostId, setTestingHostId] = createSignal<string | null>(null);
  const [hostLatencyMs, setHostLatencyMs] = createSignal<Record<string, number>>({});
  const [hostLatencyError, setHostLatencyError] = createSignal<Record<string, string>>({});

  async function selectVolume(hostId: string, volumeId: string) {
    const response = await fetchJson<{ token: string; url: string }>("/api/volume-view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId, volumeId }),
    });

    window.location.href = response.url;
  }

  async function runHostLatencyTest(hostId: string, volumeId: string) {
    setTestingHostId(hostId);
    setHostLatencyError((current) => {
      const next = { ...current };
      delete next[hostId];
      return next;
    });

    try {
      const response = await testHostLatency(hostId, volumeId);
      setHostLatencyMs((current) => ({
        ...current,
        [hostId]: response.elapsedMs,
      }));
    } catch (error) {
      setHostLatencyError((current) => ({
        ...current,
        [hostId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setTestingHostId((current) => (current === hostId ? null : current));
    }
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
                        <div class="host-card-header">
                          <h2>{host.username}</h2>
                          <Show when={host.volumes[0]}>
                            {(firstVolume) => (
                              <div class="host-latency-panel">
                                <button
                                  disabled={testingHostId() === host.hostId}
                                  onClick={() => void runHostLatencyTest(host.hostId, firstVolume().id)}
                                >
                                  {testingHostId() === host.hostId ? "Testing..." : "Test Connection"}
                                </button>
                                <Show when={hostLatencyMs()[host.hostId] !== undefined}>
                                  <p class="muted host-latency-value">{hostLatencyMs()[host.hostId]} ms</p>
                                </Show>
                                <Show when={hostLatencyError()[host.hostId]}>
                                  {(message) => <p class="muted host-latency-error">{message()}</p>}
                                </Show>
                              </div>
                            )}
                          </Show>
                        </div>
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
  const [hasRestoredProgress, setHasRestoredProgress] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [isFullscreen, setIsFullscreen] = createSignal(Boolean(document.fullscreenElement));
  const objectUrls = new Map<number, string>();
  const inflightFetches = new Map<number, AbortController>();
  const progressStorageKey = createMemo(() => `chimera:reader-progress:${props.token}`);
  const progressPercent = createMemo(() => {
    const view = data();
    if (!view || view.volume.pageCount === 0) {
      return 0;
    }

    return Math.round((pageIndex() / view.volume.pageCount) * 100);
  });

  function clampPage(page: number, pageCount: number) {
    return Math.min(Math.max(page, 1), pageCount || 1);
  }

  function changePage(nextPage: number) {
    const view = data();
    if (!view) {
      return;
    }

    setPageIndex(clampPage(nextPage, view.volume.pageCount));
  }

  function stepPage(delta: number) {
    changePage(pageIndex() + delta);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await document.documentElement.requestFullscreen();
  }

  createEffect(() => {
    const current = data();
    if (current && pageIndex() > current.volume.pageCount) {
      setPageIndex(current.volume.pageCount || 1);
    }
  });

  createEffect(() => {
    const view = data();
    if (!view || hasRestoredProgress()) {
      return;
    }

    const storedPage = Number.parseInt(window.localStorage.getItem(progressStorageKey()) ?? "", 10);
    if (Number.isFinite(storedPage)) {
      setPageIndex(clampPage(storedPage, view.volume.pageCount));
    }

    setHasRestoredProgress(true);
  });

  createEffect(() => {
    const view = data();
    if (!view || !hasRestoredProgress()) {
      return;
    }

    window.localStorage.setItem(progressStorageKey(), String(pageIndex()));
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = data();
      if (!current) {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tagName = target.tagName.toLowerCase();
        if (target.isContentEditable || ["input", "textarea", "select", "button"].includes(tagName)) {
          return;
        }
      }

      if (event.key === "ArrowRight" || event.key === "d" || event.key === "D" || event.key === " ") {
        event.preventDefault();
        changePage(pageIndex() + 1);
      }

      if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") {
        event.preventDefault();
        changePage(pageIndex() - 1);
      }

      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        void toggleFullscreen();
      }

      if (event.key === "h" || event.key === "H") {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  createEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    onCleanup(() => document.removeEventListener("fullscreenchange", onFullscreenChange));
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
    <section class={`page reader-page${sidebarCollapsed() ? " reader-page--collapsed" : ""}`}>
      <Show when={!data.loading} fallback={<p>Loading reader...</p>}>
        <Show when={data()} keyed>
          {(view) => (
            <>
              <div class="reader-layout">
                <aside class={`reader-sidebar${sidebarCollapsed() ? " reader-sidebar--collapsed" : ""}`}>
                  <div class="reader-sidebar-header">
                    <Show
                      when={!sidebarCollapsed()}
                      fallback={
                        <button class="reader-sidebar-toggle reader-sidebar-toggle--collapsed" onClick={() => setSidebarCollapsed(false)}>
                          Open panel
                        </button>
                      }
                    >
                      <div class="reader-sidebar-brand">
                        <div>
                          <p class="reader-sidebar-eyebrow">Reader</p>
                          <p class="reader-sidebar-title">Chimera</p>
                        </div>
                        <button class="reader-sidebar-toggle" onClick={() => setSidebarCollapsed(true)}>
                          Collapse
                        </button>
                      </div>
                    </Show>
                  </div>
                  <Show when={!sidebarCollapsed()}>
                    <div class="reader-sidebar-content">
                      <div class="reader-sidebar-section">
                        <a class="reader-sidebar-link" href={`/volume-view/${view.token}`}>Back to volume</a>
                      </div>
                      <div class="reader-sidebar-section">
                        <p class="reader-series">{view.series.title}</p>
                        <h1 class="reader-volume-title">{view.volume.title}</h1>
                        <p class="reader-host-meta">Hosted by {view.host.username}</p>
                      </div>
                      <div class="reader-sidebar-section">
                        <div class="reader-progress-panel">
                          <label class="reader-page-jump">
                            <span>Page</span>
                            <input
                              type="number"
                              min="1"
                              max={view.volume.pageCount}
                              value={pageIndex()}
                              onInput={(event) => {
                                const nextPage = Number.parseInt(event.currentTarget.value, 10);
                                if (Number.isFinite(nextPage)) {
                                  changePage(nextPage);
                                }
                              }}
                            />
                          </label>
                          <p class="reader-progress-fraction">{pageIndex()} / {view.volume.pageCount}</p>
                          <div class="reader-progress-track" aria-hidden="true">
                            <div class="reader-progress-fill" style={{ width: `${progressPercent()}%` }} />
                          </div>
                          <p class="reader-progress-caption">{progressPercent()}% read</p>
                        </div>
                      </div>
                      <div class="reader-sidebar-section">
                        <div class="reader-controls">
                          <button disabled={pageIndex() <= 1} onClick={() => stepPage(-1)}>Previous</button>
                          <button disabled={pageIndex() >= view.volume.pageCount} onClick={() => stepPage(1)}>Next</button>
                        </div>
                      </div>
                      <div class="reader-sidebar-section">
                        <div class="reader-actions reader-actions--stacked">
                          <button onClick={() => void toggleFullscreen()}>
                            {isFullscreen() ? "Exit fullscreen" : "Fullscreen"}
                          </button>
                        </div>
                        <p class="muted reader-shortcuts">Shortcuts: A/Left previous, D/Right/Space next, F fullscreen, H toggle panel.</p>
                      </div>
                    </div>
                  </Show>
                </aside>
                <div class="reader-main">
              <Show
                when={!imageError()}
                fallback={
                  <div class="reader-status-card">
                    <p>Failed to load page image: {imageError()}</p>
                    <button onClick={() => void ensurePageImageLoaded(pageIndex())}>Retry page</button>
                  </div>
                }
              >
                <Show
                  when={pageImageUrls()[pageIndex()]}
                  fallback={<div class="reader-status-card"><p>Loading page image...</p></div>}
                >
                  {(imageUrl) => (
                    <div class="reader-stage">
                      <button
                        class="reader-hit-zone reader-hit-zone--left"
                        aria-label="Previous page"
                        disabled={pageIndex() <= 1}
                        onClick={() => stepPage(-1)}
                      />
                      <img class="reader-image" src={imageUrl()} alt={`${view.volume.title} page ${pageIndex()}`} />
                      <button
                        class="reader-hit-zone reader-hit-zone--right"
                        aria-label="Next page"
                        disabled={pageIndex() >= view.volume.pageCount}
                        onClick={() => stepPage(1)}
                      />
                    </div>
                  )}
                </Show>
              </Show>
                </div>
              </div>
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
