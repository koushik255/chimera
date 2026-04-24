import { useEffect, useRef, useState } from "react";

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

type ResourceState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
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

function useJsonResource<T>(key: string | null, loader: (key: string) => Promise<T>): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    if (key === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }

    let cancelled = false;
    setState((current) => ({
      data: current.data,
      error: null,
      loading: true,
    }));

    void loader(key)
      .then((data) => {
        if (cancelled) {
          return;
        }

        setState({
          data,
          error: null,
          loading: false,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setState({
          data: null,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [key, loader]);

  return state;
}

function HomePage() {
  const { data, error, loading } = useJsonResource("home", fetchSeriesList);

  return (
    <section className="page">
      <h1>chimera</h1>
      <p className="muted">Series indexed by the backend.</p>
      {loading ? <p>Loading series...</p> : null}
      {!loading && error ? <p>Failed to load series: {error}</p> : null}
      {!loading && !error && (data?.series.length ?? 0) === 0 ? <p>No series found.</p> : null}
      {!loading && !error && (data?.series.length ?? 0) > 0 ? (
        <ul className="stack-list">
          {data?.series.map((series) => (
            <li key={series.id}>
              <a href={`/series/${series.id}`}>{series.title}</a>
              <span className="muted"> - {series.volume_count} volumes</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SeriesPage(props: { seriesId: string }) {
  const { data, error, loading } = useJsonResource(props.seriesId, fetchSeries);
  const [testingHostId, setTestingHostId] = useState<string | null>(null);
  const [hostLatencyMs, setHostLatencyMs] = useState<Record<string, number>>({});
  const [hostLatencyError, setHostLatencyError] = useState<Record<string, string>>({});

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
    <section className="page">
      <p><a href="/">Back</a></p>
      {loading ? <p>Loading series...</p> : null}
      {!loading && error ? <p>Failed to load series: {error}</p> : null}
      {!loading && !error && data ? (
        <>
          <h1>{data.series.title}</h1>
          <p className="muted">Only online hosts are shown.</p>
          {data.hosts.length === 0 ? <p>No online hosts for this series.</p> : null}
          {data.hosts.length > 0 ? (
            <div className="host-sections">
              {data.hosts.map((host) => {
                const firstVolume = host.volumes[0];
                return (
                  <section className="host-card" key={host.hostId}>
                    <div className="host-card-header">
                      <h2>{host.username}</h2>
                      {firstVolume ? (
                        <div className="host-latency-panel">
                          <button
                            disabled={testingHostId === host.hostId}
                            onClick={() => void runHostLatencyTest(host.hostId, firstVolume.id)}
                          >
                            {testingHostId === host.hostId ? "Testing..." : "Test Connection"}
                          </button>
                          {hostLatencyMs[host.hostId] !== undefined ? (
                            <p className="muted host-latency-value">{hostLatencyMs[host.hostId]} ms</p>
                          ) : null}
                          {hostLatencyError[host.hostId] ? (
                            <p className="muted host-latency-error">{hostLatencyError[host.hostId]}</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <ul className="stack-list">
                      {host.volumes.map((volume) => (
                        <li key={volume.id}>
                          <button onClick={() => void selectVolume(host.hostId, volume.id)}>
                            {volume.title}
                          </button>
                          <span className="muted"> - {volume.pageCount} pages</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function VolumeViewPage(props: { token: string }) {
  const { data, error, loading } = useJsonResource(props.token, fetchVolumeView);

  return (
    <section className="page">
      {loading ? <p>Loading volume...</p> : null}
      {!loading && error ? <p>Failed to load volume: {error}</p> : null}
      {!loading && !error && data ? (
        <>
          <p>
            <a href="/">Home</a>
            <span className="muted"> / </span>
            <a href={`/series/${data.series.id}`}>{data.series.title}</a>
          </p>
          <h1>{data.volume.title}</h1>
          <p className="muted">Selected host: {data.host.username}</p>
          <p className="muted">Page count: {data.volume.pageCount}</p>
          <img className="preview-image" src={data.previewImageUrl} alt={`${data.volume.title} preview`} />
          <p>
            <a href={data.readerUrl}>Open reader</a>
          </p>
        </>
      ) : null}
    </section>
  );
}

function ReaderPage(props: { token: string }) {
  const { data, error, loading } = useJsonResource(props.token, fetchVolumeView);
  const [pageIndex, setPageIndex] = useState(1);
  const [pageImageUrls, setPageImageUrls] = useState<Record<number, string>>({});
  const [imageError, setImageError] = useState<string | null>(null);
  const [hasRestoredProgress, setHasRestoredProgress] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const objectUrlsRef = useRef(new Map<number, string>());
  const inflightFetchesRef = useRef(new Map<number, AbortController>());
  const progressStorageKey = `chimera:reader-progress:${props.token}`;
  const progressPercent =
    data && data.volume.pageCount > 0 ? Math.round((pageIndex / data.volume.pageCount) * 100) : 0;

  function clampPage(page: number, pageCount: number) {
    return Math.min(Math.max(page, 1), pageCount || 1);
  }

  function changePage(nextPage: number) {
    if (!data) {
      return;
    }

    setPageIndex(clampPage(nextPage, data.volume.pageCount));
  }

  function stepPage(delta: number) {
    changePage(pageIndex + delta);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await document.documentElement.requestFullscreen();
  }

  function storeObjectUrl(page: number, nextObjectUrl: string) {
    const previousObjectUrl = objectUrlsRef.current.get(page);
    if (previousObjectUrl && previousObjectUrl !== nextObjectUrl) {
      URL.revokeObjectURL(previousObjectUrl);
    }

    objectUrlsRef.current.set(page, nextObjectUrl);
    setPageImageUrls((current) => ({
      ...current,
      [page]: nextObjectUrl,
    }));
  }

  function removePageImage(page: number) {
    const objectUrl = objectUrlsRef.current.get(page);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrlsRef.current.delete(page);
    }

    inflightFetchesRef.current.get(page)?.abort();
    inflightFetchesRef.current.delete(page);

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
    if (!data || page < 1 || page > data.volume.pageCount) {
      return;
    }

    if (objectUrlsRef.current.has(page) || inflightFetchesRef.current.has(page)) {
      return;
    }

    const controller = new AbortController();
    inflightFetchesRef.current.set(page, controller);

    try {
      const prefetchQuery = prefetch ? "?prefetch=1" : "";
      const response = await fetch(`/api/volume-view/${props.token}/page/${page}/image${prefetchQuery}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const imageBlob = await response.blob();
      if (controller.signal.aborted) {
        return;
      }

      storeObjectUrl(page, URL.createObjectURL(imageBlob));

      if (page === pageIndex) {
        setImageError(null);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      if (page === pageIndex) {
        setImageError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      inflightFetchesRef.current.delete(page);
    }
  }

  useEffect(() => {
    setPageIndex(1);
    setPageImageUrls({});
    setImageError(null);
    setHasRestoredProgress(false);
    setSidebarCollapsed(false);

    for (const controller of inflightFetchesRef.current.values()) {
      controller.abort();
    }
    inflightFetchesRef.current.clear();

    for (const objectUrl of objectUrlsRef.current.values()) {
      URL.revokeObjectURL(objectUrl);
    }
    objectUrlsRef.current.clear();
  }, [props.token]);

  useEffect(() => {
    if (data && pageIndex > data.volume.pageCount) {
      setPageIndex(data.volume.pageCount || 1);
    }
  }, [data, pageIndex]);

  useEffect(() => {
    if (!data || hasRestoredProgress) {
      return;
    }

    const storedPage = Number.parseInt(window.localStorage.getItem(progressStorageKey) ?? "", 10);
    if (Number.isFinite(storedPage)) {
      setPageIndex(clampPage(storedPage, data.volume.pageCount));
    }

    setHasRestoredProgress(true);
  }, [data, hasRestoredProgress, progressStorageKey]);

  useEffect(() => {
    if (!data || !hasRestoredProgress) {
      return;
    }

    window.localStorage.setItem(progressStorageKey, String(pageIndex));
  }, [data, hasRestoredProgress, pageIndex, progressStorageKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!data) {
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
        setPageIndex((current) => clampPage(current + 1, data.volume.pageCount));
      }

      if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") {
        event.preventDefault();
        setPageIndex((current) => clampPage(current - 1, data.volume.pageCount));
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
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [data]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!data) {
      return;
    }

    const nextPage = pageIndex < data.volume.pageCount ? pageIndex + 1 : null;
    const keepPages = new Set<number>([pageIndex]);
    if (nextPage !== null) {
      keepPages.add(nextPage);
    }

    for (const page of [...objectUrlsRef.current.keys()]) {
      if (!keepPages.has(page)) {
        removePageImage(page);
      }
    }

    for (const [page, controller] of inflightFetchesRef.current.entries()) {
      if (!keepPages.has(page)) {
        controller.abort();
        inflightFetchesRef.current.delete(page);
      }
    }

    void ensurePageImageLoaded(pageIndex);

    if (pageImageUrls[pageIndex] && nextPage !== null) {
      void ensurePageImageLoaded(nextPage, true);
    }
  }, [data, pageIndex, pageImageUrls, props.token]);

  useEffect(() => {
    return () => {
      for (const controller of inflightFetchesRef.current.values()) {
        controller.abort();
      }

      for (const objectUrl of objectUrlsRef.current.values()) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, []);

  return (
    <section className={`page reader-page${sidebarCollapsed ? " reader-page--collapsed" : ""}`}>
      {loading ? <p>Loading reader...</p> : null}
      {!loading && error ? <p>Failed to load reader: {error}</p> : null}
      {!loading && !error && data ? (
        <div className="reader-layout">
          <aside className={`reader-sidebar${sidebarCollapsed ? " reader-sidebar--collapsed" : ""}`}>
            <div className="reader-sidebar-header">
              {!sidebarCollapsed ? (
                <div className="reader-sidebar-brand">
                  <div>
                    <p className="reader-sidebar-eyebrow">Reader</p>
                    <p className="reader-sidebar-title">Chimera</p>
                  </div>
                  <button className="reader-sidebar-toggle" onClick={() => setSidebarCollapsed(true)}>
                    Collapse
                  </button>
                </div>
              ) : (
                <button
                  className="reader-sidebar-toggle reader-sidebar-toggle--collapsed"
                  onClick={() => setSidebarCollapsed(false)}
                >
                  Open panel
                </button>
              )}
            </div>
            {!sidebarCollapsed ? (
              <div className="reader-sidebar-content">
                <div className="reader-sidebar-section">
                  <a className="reader-sidebar-link" href={`/volume-view/${data.token}`}>Back to volume</a>
                </div>
                <div className="reader-sidebar-section">
                  <p className="reader-series">{data.series.title}</p>
                  <h1 className="reader-volume-title">{data.volume.title}</h1>
                  <p className="reader-host-meta">Hosted by {data.host.username}</p>
                </div>
                <div className="reader-sidebar-section">
                  <div className="reader-progress-panel">
                    <label className="reader-page-jump">
                      <span>Page</span>
                      <input
                        type="number"
                        min="1"
                        max={data.volume.pageCount}
                        value={pageIndex}
                        onChange={(event) => {
                          const nextPage = Number.parseInt(event.currentTarget.value, 10);
                          if (Number.isFinite(nextPage)) {
                            changePage(nextPage);
                          }
                        }}
                      />
                    </label>
                    <p className="reader-progress-fraction">{pageIndex} / {data.volume.pageCount}</p>
                    <div className="reader-progress-track" aria-hidden="true">
                      <div className="reader-progress-fill" style={{ width: `${progressPercent}%` }} />
                    </div>
                    <p className="reader-progress-caption">{progressPercent}% read</p>
                  </div>
                </div>
                <div className="reader-sidebar-section">
                  <div className="reader-controls">
                    <button disabled={pageIndex <= 1} onClick={() => stepPage(-1)}>Previous</button>
                    <button disabled={pageIndex >= data.volume.pageCount} onClick={() => stepPage(1)}>Next</button>
                  </div>
                </div>
                <div className="reader-sidebar-section">
                  <div className="reader-actions reader-actions--stacked">
                    <button onClick={() => void toggleFullscreen()}>
                      {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    </button>
                  </div>
                  <p className="muted reader-shortcuts">
                    Shortcuts: A/Left previous, D/Right/Space next, F fullscreen, H toggle panel.
                  </p>
                </div>
              </div>
            ) : null}
          </aside>
          <div className="reader-main">
            {imageError ? (
              <div className="reader-status-card">
                <p>Failed to load page image: {imageError}</p>
                <button onClick={() => void ensurePageImageLoaded(pageIndex)}>Retry page</button>
              </div>
            ) : pageImageUrls[pageIndex] ? (
              <div className="reader-stage">
                <button
                  className="reader-hit-zone reader-hit-zone--left"
                  aria-label="Previous page"
                  disabled={pageIndex <= 1}
                  onClick={() => stepPage(-1)}
                />
                <img
                  className="reader-image"
                  src={pageImageUrls[pageIndex]}
                  alt={`${data.volume.title} page ${pageIndex}`}
                />
                <button
                  className="reader-hit-zone reader-hit-zone--right"
                  aria-label="Next page"
                  disabled={pageIndex >= data.volume.pageCount}
                  onClick={() => stepPage(1)}
                />
              </div>
            ) : (
              <div className="reader-status-card"><p>Loading page image...</p></div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function NotFoundPage() {
  return (
    <section className="page">
      <h1>Not found</h1>
      <p><a href="/">Go home</a></p>
    </section>
  );
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname);
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return (
    <main className={`app-shell${path.startsWith("/read/") ? " app-shell--reader" : ""}`}>
      {path === "/" ? <HomePage /> : null}
      {path.startsWith("/series/") ? (
        <SeriesPage seriesId={decodeURIComponent(path.replace("/series/", ""))} />
      ) : null}
      {path.startsWith("/read/") ? (
        <ReaderPage token={decodeURIComponent(path.replace("/read/", ""))} />
      ) : null}
      {path.startsWith("/volume-view/") ? (
        <VolumeViewPage token={decodeURIComponent(path.replace("/volume-view/", ""))} />
      ) : null}
      {path !== "/" &&
      !path.startsWith("/series/") &&
      !path.startsWith("/read/") &&
      !path.startsWith("/volume-view/") ? <NotFoundPage /> : null}
    </main>
  );
}
