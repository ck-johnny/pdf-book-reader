import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  Library,
  Maximize2,
  Menu,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type StoredBook = {
  id: string;
  name: string;
  displayName?: string;
  sourcePath?: string;
  size: number;
  type: string;
  addedAt: number;
  updatedAt: number;
  currentPage: number;
  totalPages: number;
  width: number;
  data: ArrayBuffer;
};

type BookSummary = Omit<StoredBook, "data">;

const DB_NAME = "pdf-book-reader";
const STORE_NAME = "books";
const DB_VERSION = 1;
const DEFAULT_WIDTH = 820;
const LONG_PRESS_MS = 650;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = callback(store);
    let result: T | undefined;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
    }

    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function getAllBooks(): Promise<BookSummary[]> {
  const books = await withStore<StoredBook[]>("readonly", (store) => store.getAll());
  return (books ?? [])
    .map(({ data: _data, ...summary }) => summary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getBook(id: string): Promise<StoredBook | undefined> {
  return withStore<StoredBook>("readonly", (store) => store.get(id));
}

async function saveBook(book: StoredBook): Promise<void> {
  await withStore("readwrite", (store) => {
    store.put(book);
  });
}

async function updateBook(id: string, patch: Partial<StoredBook>): Promise<void> {
  const book = await getBook(id);
  if (!book) return;
  await saveBook({ ...book, ...patch, updatedAt: Date.now() });
}

async function deleteBook(id: string): Promise<void> {
  await withStore("readwrite", (store) => {
    store.delete(id);
  });
}

function bookId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function bookTitle(book: BookSummary | StoredBook): string {
  return book.displayName?.trim() || book.name;
}

function bookPath(book: BookSummary | StoredBook): string {
  return book.sourcePath?.trim() || book.name;
}

function formatFileSize(bytes: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(bytes / 1024 / 1024) + " MB";
}

function progressText(book: BookSummary | StoredBook): string {
  if (!book.totalPages) return "No pages read yet";
  const percent = Math.round((book.currentPage / book.totalPages) * 100);
  return `Page ${book.currentPage} of ${book.totalPages} (${percent}%)`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function App() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [detailsBook, setDetailsBook] = useState<BookSummary | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<BookSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  const refreshBooks = useCallback(async () => {
    setBooks(await getAllBooks());
  }, []);

  useEffect(() => {
    void refreshBooks();
  }, [refreshBooks]);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      setIsImporting(true);
      try {
        for (const file of Array.from(files)) {
          if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
            continue;
          }

          const id = bookId(file);
          const existing = await getBook(id);
          const sourcePath = "webkitRelativePath" in file && file.webkitRelativePath ? file.webkitRelativePath : file.name;
          const data = await file.arrayBuffer();
          const loadingTask = pdfjsLib.getDocument({ data: data.slice(0) });
          const pdf = await loadingTask.promise;
          await saveBook({
            id,
            name: file.name,
            displayName: existing?.displayName ?? file.name,
            sourcePath: existing?.sourcePath ?? sourcePath,
            size: file.size,
            type: file.type || "application/pdf",
            addedAt: existing?.addedAt ?? Date.now(),
            updatedAt: Date.now(),
            currentPage: existing?.currentPage ?? 1,
            totalPages: pdf.numPages,
            width: existing?.width ?? DEFAULT_WIDTH,
            data,
          });
          setActiveBookId(id);
        }
      } finally {
        setIsImporting(false);
        await refreshBooks();
      }
    },
    [refreshBooks],
  );

  const filteredBooks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return books;
    return books.filter((book) => {
      return (
        bookTitle(book).toLowerCase().includes(normalizedQuery) ||
        bookPath(book).toLowerCase().includes(normalizedQuery) ||
        book.name.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [books, query]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const startLongPress = useCallback(
    (callback: () => void) => {
      clearLongPress();
      longPressTriggeredRef.current = false;
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        callback();
      }, LONG_PRESS_MS);
    },
    [clearLongPress],
  );

  const openDetails = useCallback((book: BookSummary) => {
    setDetailsBook(book);
    setRenameValue(bookTitle(book));
  }, []);

  const closeDetails = useCallback(() => {
    setDetailsBook(null);
    setRenameValue("");
  }, []);

  const handleRename = useCallback(async () => {
    if (!detailsBook) return;
    const nextName = renameValue.trim() || detailsBook.name;
    await updateBook(detailsBook.id, { displayName: nextName });
    await refreshBooks();
    closeDetails();
  }, [closeDetails, detailsBook, refreshBooks, renameValue]);

  const handleDelete = useCallback(async () => {
    if (!deleteCandidate) return;
    await deleteBook(deleteCandidate.id);
    setDeleteCandidate(null);
    if (detailsBook?.id === deleteCandidate.id) {
      closeDetails();
    }
    await refreshBooks();
  }, [closeDetails, deleteCandidate, detailsBook, refreshBooks]);

  if (activeBookId) {
    return (
      <Reader
        bookId={activeBookId}
        onBack={() => {
          setActiveBookId(null);
          void refreshBooks();
        }}
      />
    );
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div className="brand">
          <Library aria-hidden="true" size={28} />
          <div>
            <h1>PDF Book Reader</h1>
            <p>{books.length} saved {books.length === 1 ? "book" : "books"}</p>
          </div>
        </div>
        <label className="importButton">
          <Upload aria-hidden="true" size={18} />
          <span>{isImporting ? "Adding..." : "Open PDF"}</span>
          <input
            accept="application/pdf,.pdf"
            multiple
            type="file"
            onChange={(event) => void handleFiles(event.target.files)}
          />
        </label>
      </header>

      <section className="libraryTools" aria-label="Library tools">
        <div className="searchField">
          <Search aria-hidden="true" size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search books"
            type="search"
          />
        </div>
      </section>

      {filteredBooks.length > 0 ? (
        <section className="bookGrid" aria-label="Reading books">
          {filteredBooks.map((book) => (
            <article className="bookCard" key={book.id}>
              <button
                className="bookOpenArea"
                type="button"
                title="Long press for details"
                onPointerDown={() => startLongPress(() => openDetails(book))}
                onPointerUp={clearLongPress}
                onPointerLeave={clearLongPress}
                onPointerCancel={clearLongPress}
                onClick={() => {
                  if (longPressTriggeredRef.current) {
                    longPressTriggeredRef.current = false;
                    return;
                  }
                  setActiveBookId(book.id);
                }}
              >
                <span className="bookName">{bookTitle(book)}</span>
                <span className="bookPath">{bookPath(book)}</span>
                <span className="bookProgress">{progressText(book)}</span>
                <span className="bookMeta">Last read {formatDate(book.updatedAt)}</span>
              </button>
            </article>
          ))}
        </section>
      ) : (
        <section className="emptyState">
          <FilePlus2 aria-hidden="true" size={48} />
          <h2>No books yet</h2>
          <p>Open a PDF once, and it will appear here with its page, progress, and width setting saved locally.</p>
        </section>
      )}

      {detailsBook ? (
        <div className="modalBackdrop" role="presentation" onClick={closeDetails}>
          <section className="modalPanel" role="dialog" aria-modal="true" aria-label="Book details" onClick={(event) => event.stopPropagation()}>
            <div className="modalHeader">
              <h2>Book Details</h2>
              <button className="iconButton" type="button" onClick={closeDetails} aria-label="Close details" title="Close">
                <X aria-hidden="true" size={20} />
              </button>
            </div>
            <label className="renameField">
              <span>Name</span>
              <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
            </label>
            <dl className="detailsList">
              <div>
                <dt>Path</dt>
                <dd>{bookPath(detailsBook)}</dd>
              </div>
              <div>
                <dt>Original file</dt>
                <dd>{detailsBook.name}</dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd>{progressText(detailsBook)}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatFileSize(detailsBook.size)}</dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>{formatDate(detailsBook.addedAt)}</dd>
              </div>
            </dl>
            <div className="modalActions">
              <button className="secondaryButton" type="button" onClick={() => setDeleteCandidate(detailsBook)}>
                <Trash2 aria-hidden="true" size={18} />
                <span>Delete</span>
              </button>
              <button className="primaryButton" type="button" onClick={() => void handleRename()}>
                Save Name
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteCandidate ? (
        <div className="modalBackdrop" role="presentation" onClick={() => setDeleteCandidate(null)}>
          <section className="confirmPanel" role="alertdialog" aria-modal="true" aria-label="Confirm delete" onClick={(event) => event.stopPropagation()}>
            <h2>Remove Book?</h2>
            <p>{bookTitle(deleteCandidate)}</p>
            <div className="modalActions">
              <button className="secondaryButton" type="button" onClick={() => setDeleteCandidate(null)}>
                Cancel
              </button>
              <button className="dangerButton" type="button" onClick={() => void handleDelete()}>
                Delete
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function Reader({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const [book, setBook] = useState<StoredBook | null>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [fitWidth, setFitWidth] = useState(true);
  const [stageWidth, setStageWidth] = useState(DEFAULT_WIDTH);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState("Loading PDF...");
  const [controlsOpen, setControlsOpen] = useState(false);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const storedBook = await getBook(bookId);
      if (!storedBook || cancelled) return;

      setBook(storedBook);
      setPage(storedBook.currentPage || 1);
      setWidth(storedBook.width || DEFAULT_WIDTH);

      const loadedPdf = await pdfjsLib.getDocument({ data: storedBook.data.slice(0) }).promise;
      if (cancelled) return;
      setPdf(loadedPdf);
      setStatus("");
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bookId]);

  useEffect(() => {
    const stage = readerRef.current;
    if (!stage) return;

    const syncStageWidth = () => {
      setStageWidth(stage.clientWidth);
    };
    syncStageWidth();

    const observer = new ResizeObserver(syncStageWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [pdf]);

  useEffect(() => {
    if (!book || !pdf) return;

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      void updateBook(book.id, {
        currentPage: page,
        totalPages: pdf.numPages,
        width,
      });
    }, 250);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [book, page, pdf, width]);

  const scrollToPage = useCallback(
    (nextPage: number) => {
      const totalPages = pdf?.numPages ?? book?.totalPages ?? 1;
      const boundedPage = Math.min(totalPages, Math.max(1, nextPage));
      const node = pageRefs.current[boundedPage - 1];
      if (node) {
        node.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      setPage(boundedPage);
    },
    [book, pdf],
  );

  const handleStageScroll = useCallback(() => {
    const stage = readerRef.current;
    if (!stage) return;

    const stageRect = stage.getBoundingClientRect();
    const readingLine = stageRect.top + Math.min(180, stageRect.height * 0.35);
    let nextPage = page;
    let smallestDistance = Number.POSITIVE_INFINITY;

    pageRefs.current.forEach((node, index) => {
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const distance = rect.top <= readingLine && rect.bottom >= readingLine ? 0 : Math.abs(rect.top - readingLine);
      if (distance < smallestDistance) {
        smallestDistance = distance;
        nextPage = index + 1;
      }
    });

    if (nextPage !== page) {
      setPage(nextPage);
    }
  }, [page]);

  const clearRenderStatus = useCallback(() => setStatus(""), []);

  useEffect(() => {
    if (!pdf || !book) return;
    const timer = window.setTimeout(() => {
      scrollToPage(book.currentPage || 1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [book, pdf, scrollToPage]);

  if (!book) {
    return (
      <main className="readerLoading">
        <p>{status}</p>
      </main>
    );
  }

  const totalPages = pdf?.numPages ?? book.totalPages;
  const percent = totalPages ? Math.round((page / totalPages) * 100) : 0;
  const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1);

  return (
    <main className="readerShell">
      <section className="readerStage" ref={readerRef} onScroll={handleStageScroll} aria-label="PDF pages">
        {status ? <p className="renderStatus">{status}</p> : null}
        <div className="pageStack">
          {pdf
            ? pageNumbers.map((pageNumber) => (
                <div
                  className="pdfPage"
                  key={pageNumber}
                  ref={(node) => {
                    pageRefs.current[pageNumber - 1] = node;
                  }}
                >
                  <PageCanvas
                    fitWidth={fitWidth}
                    pageNumber={pageNumber}
                    pdf={pdf}
                    stageWidth={stageWidth}
                    width={width}
                    onRendered={clearRenderStatus}
                  />
                </div>
              ))
            : null}
        </div>
      </section>

      <div className="floatingControls">
        {controlsOpen ? (
          <div className="floatingPanel" aria-label="Reader controls">
            <div className="floatingHeader">
              <div className="readerTitle">
                <h1>{bookTitle(book)}</h1>
                <p>
                  Page {page} of {totalPages} ({percent}%)
                </p>
              </div>
              <button
                className="iconButton"
                type="button"
                onClick={() => setControlsOpen(false)}
                aria-label="Collapse controls"
                title="Collapse controls"
              >
                <X aria-hidden="true" size={20} />
              </button>
            </div>

            <div className="floatingNav">
              <button
                className="iconButton"
                type="button"
                onClick={() => scrollToPage(page - 1)}
                disabled={page <= 1}
                aria-label="Previous page"
                title="Previous page"
              >
                <ChevronLeft aria-hidden="true" size={22} />
              </button>
              <label className="pageInput">
                <span>Page</span>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={page}
                  onChange={(event) => {
                    const nextPage = Number(event.target.value);
                    if (Number.isFinite(nextPage)) {
                      scrollToPage(nextPage);
                    }
                  }}
                />
              </label>
              <button
                className="iconButton"
                type="button"
                onClick={() => scrollToPage(page + 1)}
                disabled={page >= totalPages}
                aria-label="Next page"
                title="Next page"
              >
                <ChevronRight aria-hidden="true" size={22} />
              </button>
            </div>

            <label className="widthControl">
              <Maximize2 aria-hidden="true" size={18} />
              <span>Width</span>
              <input
                type="range"
                min={360}
                max={1400}
                step={20}
                value={width}
                onChange={(event) => {
                  setWidth(Number(event.target.value));
                }}
              />
              <strong>{width}px</strong>
            </label>

            <div className="floatingFooter">
              <label className="toggleControl">
                <input type="checkbox" checked={fitWidth} onChange={(event) => setFitWidth(event.target.checked)} />
                <span>Fit screen</span>
              </label>
              <button className="libraryButton" type="button" onClick={onBack}>
                <ArrowLeft aria-hidden="true" size={18} />
                <span>Library</span>
              </button>
            </div>
          </div>
        ) : null}

        <button
          className="floatingButton"
          type="button"
          onClick={() => setControlsOpen((isOpen) => !isOpen)}
          aria-expanded={controlsOpen}
          aria-label="Expand reader controls"
          title="Reader controls"
        >
          <Menu aria-hidden="true" size={24} />
          <span>
            {page}/{totalPages}
          </span>
        </button>
      </div>
    </main>
  );
}

function PageCanvas({
  fitWidth,
  onRendered,
  pageNumber,
  pdf,
  stageWidth,
  width,
}: {
  fitWidth: boolean;
  onRendered: () => void;
  pageNumber: number;
  pdf: pdfjsLib.PDFDocumentProxy;
  stageWidth: number;
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    async function renderPage() {
      const pdfPage = await pdf.getPage(pageNumber);
      if (cancelled) return;

      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const availableWidth = Math.max(320, stageWidth - 28);
      const targetWidth = fitWidth ? Math.min(availableWidth, width) : width;
      const scale = targetWidth / baseViewport.width;
      const viewport = pdfPage.getViewport({ scale });
      const pixelRatio = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);
      await pdfPage.render({ canvasContext: context, viewport }).promise;
      if (!cancelled) {
        onRendered();
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
    };
  }, [fitWidth, onRendered, pageNumber, pdf, stageWidth, width]);

  return <canvas ref={canvasRef} />;
}

createRoot(document.getElementById("root")!).render(<App />);
