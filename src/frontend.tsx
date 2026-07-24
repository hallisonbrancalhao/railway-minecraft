import "./tailwind.css";
import { FitAddon, init, Terminal } from "ghostty-web";
import {
	Check,
	Copy,
	FileText,
	Folder,
	LogOut,
	RefreshCw,
	Terminal as TerminalIcon,
	Trash2,
	Upload,
	Users,
} from "lucide-react";
import {
	type DragEvent as ReactDragEvent,
	StrictMode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type FileEntry = {
	name: string;
	path: string;
	type: "file" | "dir";
	size: number;
	mtime: string;
};

type UploadItem = {
	file: File;
	relativePath: string;
};

type RequestInitWithDuplex = RequestInit & {
	duplex?: "half";
};

type WebkitFileSystemEntry = {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
};

type WebkitFileSystemFileEntry = WebkitFileSystemEntry & {
	file: (
		successCallback: (file: File) => void,
		errorCallback?: (error: DOMException) => void,
	) => void;
};

type WebkitFileSystemDirectoryReader = {
	readEntries: (
		successCallback: (entries: WebkitFileSystemEntry[]) => void,
		errorCallback?: (error: DOMException) => void,
	) => void;
};

type WebkitFileSystemDirectoryEntry = WebkitFileSystemEntry & {
	createReader: () => WebkitFileSystemDirectoryReader;
};

const formatSize = (bytes: number) => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const formatTimestamp = (value: string) =>
	new Intl.DateTimeFormat("en", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));

const root = document.getElementById("root");

if (!root) {
	throw new Error("Root element not found.");
}

function LoginPage({
	authError,
	onSignIn,
}: {
	authError: string | null;
	onSignIn: () => void;
}) {
	return (
		<div className="flex min-h-screen flex-col dash-bg text-foreground">
			<div className="mx-auto flex min-h-screen w-full max-w-lg items-center px-6 py-12">
				<div className="w-full space-y-5 dash-appear">
					<div className="space-y-3 text-center">
						<div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-background/60 shadow-sm">
							<TerminalIcon className="h-5 w-5 text-primary" />
						</div>

						<div className="space-y-1">
							<div className="dash-kicker">Minecraft Control</div>
							<h1 className="text-2xl font-semibold tracking-tight text-foreground">
								Server Dashboard
							</h1>
							<p className="text-sm text-muted-foreground">
								Console, files, and status — all in one place.
							</p>
						</div>

						<div className="flex flex-wrap justify-center gap-2">
							<span className="dash-chip">
								<TerminalIcon className="h-4 w-4 opacity-75" />
								Console
							</span>
							<span className="dash-chip">
								<Folder className="h-4 w-4 opacity-75" />
								Files
							</span>
							<span className="dash-chip">
								<Users className="h-4 w-4 opacity-75" />
								Players
							</span>
						</div>
					</div>

					<div className="relative">
						<Card className="relative w-full overflow-hidden border-border/80 bg-card/95">
							<div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,hsla(0,0%,100%,0.06),transparent_22%)]" />
							<div className="pointer-events-none absolute inset-0 bg-[linear-gradient(hsla(0,0%,100%,0.03)_1px,transparent_1px)] [background-size:28px_28px] opacity-50" />

							<CardHeader className="relative">
								<CardTitle>Sign in</CardTitle>
								<CardDescription>
									Open the dashboard to manage your server.
								</CardDescription>
							</CardHeader>

							<CardContent className="relative space-y-4">
								{authError ? (
									<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
										{authError}
									</div>
								) : null}

								<div className="space-y-2">
									<div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
										What you can do
									</div>
									<ul className="space-y-2 text-sm text-foreground/90">
										<li className="flex items-center gap-2">
											<TerminalIcon className="h-4 w-4 opacity-75" />
											Send console commands and watch logs
										</li>
										<li className="flex items-center gap-2">
											<Folder className="h-4 w-4 opacity-75" />
											Browse, preview, upload, and delete files
										</li>
										<li className="flex items-center gap-2">
											<Users className="h-4 w-4 opacity-75" />
											Check status and players
										</li>
									</ul>
								</div>

								<p className="text-xs text-muted-foreground">
									You’ll be redirected to sign in, then brought back here.
								</p>
							</CardContent>

							<CardFooter className="relative flex-col items-stretch gap-3">
								<Button className="w-full" onClick={onSignIn}>
									Sign in
								</Button>
							</CardFooter>
						</Card>
					</div>
				</div>
			</div>
			<footer className="pb-5 text-center text-xs text-muted-foreground">
				made with ❤️ by{" "}
				<a
					href="https://github.com/ThallesP"
					target="_blank"
					rel="noreferrer"
					className="underline-offset-4 hover:underline"
				>
					thallesp
				</a>
			</footer>
		</div>
	);
}

function App() {
	const [authLoading, setAuthLoading] = useState(true);
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	const [authError, setAuthError] = useState<string | null>(null);
	const [authUserName, setAuthUserName] = useState("Player");
	const [authUserPicture, setAuthUserPicture] = useState<string | null>(null);
	const [currentPath, setCurrentPath] = useState("/");
	const [entries, setEntries] = useState<FileEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<FileEntry | null>(null);
	const [preview, setPreview] = useState<string>("");
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadProgress, setUploadProgress] = useState(0);
	const [uploadName, setUploadName] = useState<string | null>(null);
	const [isDropTargetActive, setIsDropTargetActive] = useState(false);
	const [activeTab, setActiveTab] = useState<"console" | "files">("console");

	const [query, setQuery] = useState("");
	const [playerQuery, setPlayerQuery] = useState("");
	const [copied, setCopied] = useState(false);

	const [terminalReady, setTerminalReady] = useState(false);
	const [consoleError, setConsoleError] = useState<string | null>(null);
	const [logStatus, setLogStatus] = useState<
		"connecting" | "connected" | "error"
	>("connecting");
	const [serverStatus, setServerStatus] = useState<{
		host: string;
		port: number;
		publicAddress: string | null;
		motd: string | null;
		version: string | null;
		latency: number | null;
		players: {
			online: number;
			max: number;
			sample: string[];
		};
	} | null>(null);
	const [serverStatusMeta, setServerStatusMeta] = useState<{
		cached?: boolean;
		stale?: boolean;
		error?: string;
		fetchedAt?: number;
	} | null>(null);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const folderInputRef = useRef<HTMLInputElement>(null);
	const terminalRef = useRef<HTMLDivElement>(null);
	const terminalInstanceRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const inputBufferRef = useRef("");
	const logStreamRef = useRef<WebSocket | null>(null);
	const prompt = "server> ";

	const markUnauthenticated = useCallback((message?: string) => {
		setIsAuthenticated(false);
		setAuthLoading(false);
		if (message) setAuthError(message);
	}, []);

	const apiFetch = useCallback(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const nextInit =
				init && init.body instanceof ReadableStream
					? ({ ...init, duplex: "half" } as RequestInitWithDuplex)
					: init;
			const res = await fetch(input, nextInit);
			if (res.status === 401) {
				markUnauthenticated("Session expired. Please sign in again.");
				throw new Error("Unauthorized.");
			}
			return res;
		},
		[markUnauthenticated],
	);

	const writePrompt = (term: Terminal) => {
		term.write(prompt);
	};

	const writeLogLine = (line: string) => {
		const term = terminalInstanceRef.current;
		if (!term) return;
		term.write("\r\x1b[2K");
		term.write(line.length ? `${line}\r\n` : "\r\n");
		term.write(`${prompt}${inputBufferRef.current}`);
	};

	const breadcrumbs = useMemo(() => {
		const parts = currentPath.split("/").filter(Boolean);
		const items = [{ name: "root", path: "/" }];
		let acc = "";
		for (const part of parts) {
			acc += `/${part}`;
			items.push({ name: part, path: acc });
		}
		return items;
	}, [currentPath]);

	const filteredEntries = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter((entry) => entry.name.toLowerCase().includes(q));
	}, [entries, query]);

	useEffect(() => {
		let cancelled = false;

		const checkAuth = async () => {
			setAuthLoading(true);
			try {
				const currentUrl = new URL(window.location.href);
				const errorFromRedirect = currentUrl.searchParams.get("auth_error");
				if (errorFromRedirect) {
					setAuthError(errorFromRedirect);
					currentUrl.searchParams.delete("auth_error");
					window.history.replaceState({}, "", currentUrl.toString());
				}

				const res = await fetch("/api/auth/me");
				if (!res.ok) {
					if (cancelled) return;
					setIsAuthenticated(false);
					setAuthUserName("Player");
					setAuthUserPicture(null);
					return;
				}
				const payload = (await res.json()) as
					| {
							ok: true;
							user?: { name?: string | null; picture?: string | null };
					  }
					| { ok?: false; error?: string };
				if (cancelled) return;
				setIsAuthenticated(true);
				const nextName =
					"user" in payload &&
					payload.user &&
					typeof payload.user.name === "string" &&
					payload.user.name.trim().length > 0
						? payload.user.name
						: "Player";
				const nextPicture =
					"user" in payload &&
					payload.user &&
					typeof payload.user.picture === "string" &&
					payload.user.picture.trim().length > 0
						? payload.user.picture
						: null;
				setAuthUserName(nextName);
				setAuthUserPicture(nextPicture);
				setAuthError(null);
			} catch (error) {
				if (cancelled) return;
				setIsAuthenticated(false);
				setAuthUserName("Player");
				setAuthUserPicture(null);
				setAuthError(
					error instanceof Error ? error.message : "Auth check failed.",
				);
			} finally {
				if (!cancelled) setAuthLoading(false);
			}
		};

		void checkAuth();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!isAuthenticated) return;
		void fetchEntries("/");
	}, [isAuthenticated]);

	useEffect(() => {
		if (!isAuthenticated) return;
		let cancelled = false;
		const setupTerminal = async () => {
			if (!terminalRef.current || terminalInstanceRef.current) return;
			setConsoleError(null);
			try {
				await init();
				if (cancelled || !terminalRef.current) return;
				const term = new Terminal({
					fontSize: 13,
					fontFamily:
						'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
					cursorBlink: true,
					theme: {
						background: "#0b0c10",
						foreground: "#e9e9ee",
						cursor: "#d7ff5a",
						cursorAccent: "#0b0c10",
						selectionBackground: "#1b1f2b",
						selectionForeground: "#f4f5f7",
					},
				});
				terminalInstanceRef.current = term;
				const fitAddon = new FitAddon();
				term.loadAddon(fitAddon);
				fitAddonRef.current = fitAddon;
				term.open(terminalRef.current);
				requestAnimationFrame(() => fitAddon.fit());
				writePrompt(term);
				term.onData((data) => {
					const activeTerm = terminalInstanceRef.current;
					if (!activeTerm) return;
					for (const chunk of data) {
						if (chunk === "\r" || chunk === "\n") {
							const commandText = inputBufferRef.current;
							inputBufferRef.current = "";
							activeTerm.write("\r\n");
							void sendCommand(commandText, { rePrompt: false });
							writePrompt(activeTerm);
							continue;
						}
						if (chunk === "\u007f" || chunk === "\b") {
							if (inputBufferRef.current.length > 0) {
								inputBufferRef.current = inputBufferRef.current.slice(0, -1);
								activeTerm.write("\b \b");
							}
							continue;
						}
						inputBufferRef.current += chunk;
						activeTerm.write(chunk);
					}
				});
				setTerminalReady(true);
			} catch (err) {
				setConsoleError(
					err instanceof Error ? err.message : "Failed to load terminal.",
				);
				setTerminalReady(false);
			}
		};

		void setupTerminal();
		return () => {
			cancelled = true;
		};
	}, [isAuthenticated]);

	useEffect(() => {
		if (!isAuthenticated) return;
		if (!terminalReady || !terminalInstanceRef.current) return;
		let cancelled = false;
		let retry = 0;
		let retryTimer: number | null = null;

		const connect = () => {
			if (cancelled) return;
			if (!terminalInstanceRef.current) return;
			setLogStatus("connecting");

			const wsUrl = new URL("/api/console/ws", window.location.href);
			wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

			const ws = new WebSocket(wsUrl.toString());
			logStreamRef.current = ws;

			ws.onopen = () => {
				retry = 0;
				setLogStatus("connected");
			};

			ws.onmessage = (event) => {
				const line = typeof event.data === "string" ? event.data : "";
				writeLogLine(line);
			};

			ws.onerror = () => {
				setLogStatus("error");
			};

			ws.onclose = () => {
				setLogStatus("error");
				if (cancelled) return;
				retry += 1;
				const backoff = Math.min(8000, 450 * 2 ** Math.min(5, retry));
				const jitter = Math.round(Math.random() * 200);
				retryTimer = window.setTimeout(connect, backoff + jitter);
			};
		};

		connect();
		return () => {
			cancelled = true;
			if (retryTimer) window.clearTimeout(retryTimer);
			retryTimer = null;
			logStreamRef.current?.close();
			logStreamRef.current = null;
		};
	}, [isAuthenticated, terminalReady]);

	useEffect(() => {
		if (!isAuthenticated) return;
		let cancelled = false;
		let timer: number | null = null;

		const fetchStatus = async () => {
			try {
				const res = await apiFetch("/api/server/status");
				const payload = (await res.json()) as
					| {
							ok: true;
							data: {
								host: string;
								port: number;
								publicAddress: string | null;
								motd: string | null;
								version: string | null;
								latency: number | null;
								players: { online: number; max: number; sample: string[] };
							};
							cached?: boolean;
							stale?: boolean;
							error?: string;
							fetchedAt?: number;
					  }
					| { ok: false; error?: string };

				if (!res.ok || !payload.ok) {
					throw new Error(
						"error" in payload && payload.error
							? payload.error
							: "Status ping failed.",
					);
				}

				if (cancelled) return;
				setServerStatus(payload.data);
				setServerStatusMeta({
					cached: payload.cached,
					stale: payload.stale,
					error: payload.error,
					fetchedAt: payload.fetchedAt,
				});
			} catch (error) {
				if (cancelled) return;
				setServerStatusMeta({
					error: error instanceof Error ? error.message : "Status ping failed.",
					fetchedAt: Date.now(),
				});
			}
		};

		void fetchStatus();
		timer = window.setInterval(fetchStatus, 12_000);

		return () => {
			cancelled = true;
			if (timer) window.clearInterval(timer);
		};
	}, [apiFetch, isAuthenticated]);

	useEffect(() => {
		if (activeTab !== "console") return;
		if (!terminalInstanceRef.current || !fitAddonRef.current) return;
		requestAnimationFrame(() => fitAddonRef.current?.fit());
	}, [activeTab, terminalReady]);

	useEffect(() => {
		const el = terminalRef.current;
		if (!el || !fitAddonRef.current) return;
		const ro = new ResizeObserver(() => {
			requestAnimationFrame(() => fitAddonRef.current?.fit());
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [terminalReady]);

	const fetchEntries = async (path: string) => {
		setIsLoading(true);
		setError(null);
		setSelected(null);
		setPreview("");
		setPreviewError(null);
		setQuery("");
		try {
			const res = await apiFetch(`/api/files?path=${encodeURIComponent(path)}`);
			const data = (await res.json()) as {
				entries?: FileEntry[];
				error?: string;
			};
			if (!res.ok) {
				throw new Error(data.error ?? "Failed to load directory.");
			}
			setEntries(data.entries ?? []);
			setCurrentPath(path);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load directory.",
			);
		} finally {
			setIsLoading(false);
		}
	};

	const fetchPreview = async (entry: FileEntry) => {
		setPreview("");
		setPreviewError(null);
		setPreviewLoading(true);
		try {
			const res = await apiFetch(
				`/api/files/content?path=${encodeURIComponent(entry.path)}`,
			);
			const data = (await res.json()) as { content?: string; error?: string };
			if (!res.ok) {
				throw new Error(data.error ?? "Failed to load file.");
			}
			setPreview(data.content ?? "");
		} catch (err) {
			setPreviewError(
				err instanceof Error ? err.message : "Failed to load file.",
			);
		} finally {
			setPreviewLoading(false);
		}
	};

	const handleEntryClick = async (entry: FileEntry) => {
		if (entry.type === "dir") {
			await fetchEntries(entry.path);
			return;
		}
		setSelected(entry);
		await fetchPreview(entry);
	};

	const uploadFile = async (
		file: File,
		options: {
			relativePath?: string;
			onProgress?: (uploadedBytes: number, totalBytes: number) => void;
		} = {},
	) => {
		const uploadName = file.name || "upload.bin";
		const uploadPath = `/api/files/upload?path=${encodeURIComponent(currentPath)}`;
		const totalBytes = Math.max(file.size, 1);
		// Use a plain File body for maximum browser compatibility.
		const res = await apiFetch(uploadPath, {
			method: "POST",
			headers: {
				"Content-Type": file.type || "application/octet-stream",
				"X-File-Name": uploadName,
				...(options.relativePath
					? { "X-Relative-Path": options.relativePath }
					: {}),
			},
			body: file,
		});
		options.onProgress?.(totalBytes, totalBytes);
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		if (!res.ok) {
			throw new Error(data.error ?? "Upload failed.");
		}
	};

	const normalizeUploadRelativePath = (
		value: string | null | undefined,
		fallbackName: string,
	) => {
		const normalized = (value ?? "")
			.replaceAll("\\", "/")
			.replace(/^\/+/, "")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== ".")
			.join("/");
		return normalized || fallbackName || "upload.bin";
	};

	const handleUploadSingleFile = async (file: File | null) => {
		if (!file) return;
		setUploading(true);
		setUploadProgress(0);
		setUploadName(file.name || "upload.bin");
		setError(null);
		try {
			await uploadFile(file, {
				onProgress: (uploadedBytes, totalBytes) => {
					const percent = Math.min(
						100,
						Math.round((uploadedBytes / totalBytes) * 100),
					);
					setUploadProgress(percent);
				},
			});
			await fetchEntries(currentPath);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Upload failed.");
		} finally {
			setUploading(false);
			setUploadName(null);
			setUploadProgress(0);
			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
		}
	};

	const uploadFolderItems = async (
		items: UploadItem[],
		options?: { onFinish?: () => void },
	) => {
		if (!items.length) return;
		setUploading(true);
		setUploadProgress(0);
		setUploadName(`folder (${items.length} files)`);
		setError(null);
		try {
			const totalBytes = Math.max(
				items.reduce((sum, item) => sum + Math.max(item.file.size, 1), 0),
				1,
			);
			let completedBytes = 0;

			for (const item of items) {
				const relativePath = normalizeUploadRelativePath(
					item.relativePath,
					item.file.name,
				);
				setUploadName(relativePath);
				await uploadFile(item.file, {
					relativePath,
					onProgress: (uploadedBytes, currentFileTotal) => {
						const percent = Math.min(
							100,
							Math.round(
								((completedBytes + Math.min(uploadedBytes, currentFileTotal)) /
									totalBytes) *
									100,
							),
						);
						setUploadProgress(percent);
					},
				});
				completedBytes += Math.max(item.file.size, 1);
				const percent = Math.min(
					100,
					Math.round((completedBytes / totalBytes) * 100),
				);
				setUploadProgress(percent);
			}

			await fetchEntries(currentPath);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Folder upload failed.");
		} finally {
			setUploading(false);
			setUploadName(null);
			setUploadProgress(0);
			options?.onFinish?.();
		}
	};

	const handleUploadFolder = async (fileList: FileList | null) => {
		const items = Array.from(fileList ?? []).map((file) => ({
			file,
			relativePath: normalizeUploadRelativePath(
				file.webkitRelativePath,
				file.name,
			),
		}));
		await uploadFolderItems(items, {
			onFinish: () => {
				if (folderInputRef.current) {
					folderInputRef.current.value = "";
				}
			},
		});
	};

	const readDroppedDirectoryEntries = async (
		entry: WebkitFileSystemDirectoryEntry,
	): Promise<WebkitFileSystemEntry[]> => {
		const reader = entry.createReader();
		const entries: WebkitFileSystemEntry[] = [];
		for (;;) {
			const chunk = await new Promise<WebkitFileSystemEntry[]>(
				(resolve, reject) => {
					reader.readEntries(resolve, reject);
				},
			);
			if (!chunk.length) break;
			entries.push(...chunk);
		}
		return entries;
	};

	const readDroppedFileEntry = (entry: WebkitFileSystemFileEntry) =>
		new Promise<File>((resolve, reject) => {
			entry.file(resolve, reject);
		});

	const flattenDroppedEntry = async (
		entry: WebkitFileSystemEntry,
		parentPath = "",
	): Promise<UploadItem[]> => {
		const currentPath = normalizeUploadRelativePath(
			`${parentPath}/${entry.name}`,
			entry.name,
		);
		if (entry.isFile) {
			const file = await readDroppedFileEntry(
				entry as WebkitFileSystemFileEntry,
			);
			return [{ file, relativePath: currentPath }];
		}
		if (!entry.isDirectory) return [];
		const children = await readDroppedDirectoryEntries(
			entry as WebkitFileSystemDirectoryEntry,
		);
		const nested = await Promise.all(
			children.map((child) => flattenDroppedEntry(child, currentPath)),
		);
		return nested.flat();
	};

	const readDroppedItems = async (dataTransfer: DataTransfer) => {
		const droppedEntries = Array.from(dataTransfer.items ?? [])
			.map((item) => {
				const entryGetter = (
					item as DataTransferItem & {
						webkitGetAsEntry?: () => WebkitFileSystemEntry | null;
					}
				).webkitGetAsEntry;
				return entryGetter ? entryGetter.call(item) : null;
			})
			.filter((entry): entry is WebkitFileSystemEntry => Boolean(entry));

		if (droppedEntries.length) {
			const nested = await Promise.all(
				droppedEntries.map((entry) => flattenDroppedEntry(entry)),
			);
			return nested.flat();
		}

		return Array.from(dataTransfer.files ?? []).map((file) => ({
			file,
			relativePath: normalizeUploadRelativePath(
				file.webkitRelativePath,
				file.name,
			),
		}));
	};

	const handleFileBrowserDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
		event.preventDefault();
		if (uploading) return;
		event.dataTransfer.dropEffect = "copy";
		setIsDropTargetActive(true);
	};

	const handleFileBrowserDragLeave = (
		event: ReactDragEvent<HTMLDivElement>,
	) => {
		if (event.currentTarget.contains(event.relatedTarget as Node | null))
			return;
		setIsDropTargetActive(false);
	};

	const handleFileBrowserDrop = async (
		event: ReactDragEvent<HTMLDivElement>,
	) => {
		event.preventDefault();
		setIsDropTargetActive(false);
		if (uploading) return;
		const items = await readDroppedItems(event.dataTransfer);
		if (!items.length) {
			setError("No files found in dropped selection.");
			return;
		}
		await uploadFolderItems(items);
	};

	const clearDropTarget = () => {
		setIsDropTargetActive(false);
	};

	const openFolderPicker = () => {
		const input = folderInputRef.current;
		if (!input) return;
		input.setAttribute("webkitdirectory", "true");
		input.setAttribute("directory", "true");
		input.click();
	};

	const handleDelete = async () => {
		if (!deleteTarget) return;
		setError(null);
		try {
			const res = await apiFetch(
				`/api/files?path=${encodeURIComponent(deleteTarget.path)}`,
				{ method: "DELETE" },
			);
			const data = (await res.json()) as { error?: string };
			if (!res.ok) {
				throw new Error(data.error ?? "Delete failed.");
			}
			if (selected?.path === deleteTarget.path) {
				setSelected(null);
				setPreview("");
			}
			await fetchEntries(currentPath);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Delete failed.");
		} finally {
			setDeleteTarget(null);
		}
	};

	const sendCommand = async (
		rawCommand: string,
		options: { rePrompt?: boolean } = {},
	) => {
		const term = terminalInstanceRef.current;
		const commandText = rawCommand.trim();
		if (!term) return;
		const shouldPrompt = options.rePrompt ?? true;
		if (!commandText) {
			if (shouldPrompt) writePrompt(term);
			return;
		}
		try {
			const res = await apiFetch("/api/console", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: commandText }),
			});
			const data = (await res.json()) as { error?: string };
			if (!res.ok) {
				throw new Error(data.error ?? "Console command failed.");
			}
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Console request failed.";
			if (shouldPrompt) {
				term.write(`${message}\r\n`);
			} else {
				writeLogLine(message);
				return;
			}
		}
		if (shouldPrompt) writePrompt(term);
	};

	const dotClass =
		logStatus === "connected"
			? "dash-dot"
			: logStatus === "error"
				? "dash-dot dash-dot--error"
				: "dash-dot dash-dot--connecting";

	const handleCopySelected = async () => {
		if (!selected) return;
		const full = `/data${selected.path}`;
		try {
			await navigator.clipboard.writeText(full);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1100);
		} catch {
			// ignore
		}
	};

	const runMacro = (command: string) => {
		const term = terminalInstanceRef.current;
		if (!term) return;
		inputBufferRef.current = "";
		term.write(`\r\n› ${command}\r\n`);
		void sendCommand(command, { rePrompt: false });
		writePrompt(term);
	};

	const runPlayers = () => runMacro("list");

	const playerList = useMemo(() => {
		if (serverStatus) return serverStatus.players.sample ?? [];
		return [];
	}, [serverStatus]);

	const filteredPlayers = useMemo(() => {
		const q = playerQuery.trim().toLowerCase();
		if (!q) return playerList;
		return playerList.filter((name) => name.toLowerCase().includes(q));
	}, [playerList, playerQuery]);

	const playerCountLabel = useMemo(() => {
		if (serverStatus) {
			return `${serverStatus.players.online}/${serverStatus.players.max}`;
		}
		return "—";
	}, [serverStatus]);

	const handleSignIn = () => {
		window.location.href = "/api/auth/redirect";
	};

	const handleLogout = async () => {
		try {
			await fetch("/api/auth/logout", { method: "POST" });
		} catch {
			// ignore network errors; local sign-out state still applies
		}
		setIsAuthenticated(false);
		setAuthUserName("Player");
		setAuthUserPicture(null);
		setAuthError(null);
	};

	const userInitial = useMemo(
		() => authUserName.trim().charAt(0).toUpperCase() || "P",
		[authUserName],
	);

	if (authLoading) {
		return (
			<output
				className="flex min-h-screen items-center justify-center bg-background"
				aria-label="Loading"
			>
				<div className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-primary" />
			</output>
		);
	}

	if (!isAuthenticated) {
		return <LoginPage authError={authError} onSignIn={handleSignIn} />;
	}

	return (
		<div className="flex min-h-screen flex-col dash-bg text-foreground">
			<div className="dash-shell dash-appear">
				<header className="dash-topbar">
					<div>
						<div className="dash-kicker">Minecraft Control</div>
						<h1 className="dash-title">Server Operations</h1>
						<p className="dash-sub">
							Manage files under{" "}
							<span className="text-foreground/90">/data</span> and send console
							commands.
						</p>
					</div>
					<div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-background/35 px-3 py-2">
						{authUserPicture ? (
							<img
								src={authUserPicture}
								alt={`${authUserName} avatar`}
								className="h-9 w-9 rounded-full border border-border/70 object-cover"
							/>
						) : (
							<div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
								{userInitial}
							</div>
						)}
						<div className="min-w-0">
							<div className="truncate text-sm font-medium text-foreground">
								{authUserName}
							</div>
							<div className="text-xs text-muted-foreground">Logged in</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							className="h-8 rounded-full bg-background/40 px-3"
							onClick={handleLogout}
						>
							<LogOut className="h-4 w-4 opacity-80" />
							Logout
						</Button>
					</div>
				</header>

				<nav className="dash-nav" aria-label="Dashboard sections">
					<button
						type="button"
						className="dash-navbtn"
						aria-current={activeTab === "console" ? "page" : undefined}
						onClick={() => setActiveTab("console")}
					>
						<TerminalIcon className="h-4 w-4 opacity-75" />
						Console
					</button>
					<button
						type="button"
						className="dash-navbtn"
						aria-current={activeTab === "files" ? "page" : undefined}
						onClick={() => setActiveTab("files")}
					>
						<Folder className="h-4 w-4 opacity-75" />
						Files
					</button>
				</nav>

				<section
					className={cn("mt-6 grid gap-4", activeTab !== "console" && "hidden")}
					aria-label="Console"
				>
					<div className="dash-surface">
						<div className="dash-panelhead">
							<div>
								<div className="dash-paneltitle">Console</div>
								<div className="text-xs text-muted-foreground">
									Logs stream into the terminal. Type a command and press Enter.
								</div>
							</div>

							<div className="flex flex-wrap items-center justify-end gap-2">
								<span className="dash-chip">
									<span className={dotClass} />
									{serverStatus ? "online" : "unknown"}
								</span>
							</div>
						</div>

						<div className="dash-bodypad">
							{consoleError ? (
								<div className="dash-mutedbox text-destructive">
									{consoleError}
								</div>
							) : null}
							<div className="mt-3 h-[420px] w-full rounded-2xl border border-border/80 bg-[#0b0c10] p-3">
								<div className="h-full w-full overflow-hidden rounded-xl bg-[#0b0c10]">
									<div
										ref={terminalRef}
										className="ghostty-console ghostty-console--inset h-full w-full"
									/>
								</div>
							</div>
						</div>
					</div>

					<div className="grid gap-4 lg:grid-cols-12">
						<section
							className="dash-surface lg:col-span-12"
							aria-label="Server overview and online players"
						>
							<div className="dash-panelhead">
								<div className="dash-paneltitle">Server overview</div>
								<div className="flex flex-wrap items-center gap-2">
									<span className="dash-chip">{playerCountLabel}</span>
									<Button
										variant="outline"
										size="sm"
										className="h-9 rounded-full bg-background/40 px-4"
										onClick={runPlayers}
										disabled={!terminalReady}
									>
										<RefreshCw className="h-4 w-4 opacity-80" />
										Refresh
									</Button>
								</div>
							</div>

							{/* Stats */}
							<div className="dash-bodypad space-y-4">
								<div className="overflow-x-auto pb-1">
									<div className="flex min-w-[700px] flex-nowrap gap-3">
										<div className="min-w-[160px] flex-1 rounded-2xl border border-border/70 bg-background/30 px-4 py-3">
											<div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
												Status
											</div>
											<div className="mt-1 text-sm text-foreground/95">
												{serverStatus ? "online" : "unknown"}
											</div>
										</div>

										<div className="min-w-[160px] flex-1 rounded-2xl border border-border/70 bg-background/30 px-4 py-3">
											<div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
												Address
											</div>
											<div className="mt-1 truncate text-sm text-foreground/95">
												{serverStatus?.publicAddress ?? "—"}
											</div>
										</div>

										<div className="min-w-[160px] flex-1 rounded-2xl border border-border/70 bg-background/30 px-4 py-3">
											<div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
												Version
											</div>
											<div className="mt-1 text-sm text-foreground/95">
												{serverStatus?.version ?? "—"}
											</div>
										</div>

										<div className="min-w-[160px] flex-1 rounded-2xl border border-border/70 bg-background/30 px-4 py-3">
											<div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
												Players
											</div>
											<div className="mt-1 text-sm text-foreground/95">
												{playerCountLabel}
											</div>
										</div>
									</div>
								</div>

								{serverStatusMeta?.error ? (
									<div className="dash-mutedbox text-destructive">
										{serverStatusMeta.error}
									</div>
								) : null}

								{serverStatus?.motd ? (
									<div className="dash-mutedbox">{serverStatus.motd}</div>
								) : null}
							</div>

							{/* Full-width divider — outside padding so it spans edge to edge */}
							<div className="h-px w-full bg-border" />

							{/* Online players */}
							<div className="dash-bodypad space-y-4">
								<div className="flex items-center gap-2">
									<div className="dash-paneltitle">Online players</div>
								</div>

								<input
									value={playerQuery}
									onChange={(event) => setPlayerQuery(event.target.value)}
									placeholder="Search players…"
									className="h-10 w-full rounded-2xl border border-border/70 bg-background/35 px-4 text-sm text-foreground/90 outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
								/>

								{playerList.length ? (
									filteredPlayers.length ? (
										<div className="max-h-72 space-y-2 overflow-y-auto pr-1">
											{filteredPlayers.map((name) => (
												<div
													key={name}
													className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/30 px-3 py-2"
												>
													<div className="min-w-0 truncate text-sm text-foreground/95">
														{name}
													</div>
													<Button
														variant="outline"
														size="sm"
														className="h-9 shrink-0 rounded-full bg-background px-4"
														onClick={() => runMacro(`op ${name}`)}
														disabled={!terminalReady}
													>
														OP
													</Button>
												</div>
											))}
										</div>
									) : (
										<div className="dash-mutedbox">No matching players.</div>
									)
								) : (
									<div className="dash-mutedbox">No players detected.</div>
								)}

								{playerList.length ? (
									<div className="text-[11px] text-muted-foreground">
										Tip: OP runs via the console pipe (shows in the terminal
										output).
									</div>
								) : null}
							</div>
						</section>
					</div>
				</section>
				<section
					className={cn("dash-split", activeTab !== "files" && "hidden")}
					aria-label="Files"
				>
					<div className="dash-surface">
						<div className="dash-panelhead">
							<div>
								<div className="dash-paneltitle">File Browser</div>
								<div className="text-xs text-muted-foreground">
									{filteredEntries.length} item
									{filteredEntries.length === 1 ? "" : "s"}
									{query.trim() ? " (filtered)" : ""} · root is{" "}
									<span className="text-foreground/90">/data</span>
								</div>
							</div>

							<div className="flex flex-wrap items-center gap-2">
								<input
									ref={fileInputRef}
									type="file"
									className="hidden"
									onChange={(event) =>
										handleUploadSingleFile(event.target.files?.[0] ?? null)
									}
								/>
								<input
									ref={folderInputRef}
									type="file"
									multiple
									className="hidden"
									onChange={(event) => handleUploadFolder(event.target.files)}
								/>

								<Button
									variant="outline"
									size="sm"
									className="h-9 rounded-full bg-background/40 px-4"
									onClick={() => fileInputRef.current?.click()}
									disabled={uploading}
								>
									<Upload className="h-4 w-4 opacity-80" />
									Upload file
								</Button>

								<Button
									variant="outline"
									size="sm"
									className="h-9 rounded-full bg-background/40 px-4"
									onClick={openFolderPicker}
									disabled={uploading}
								>
									<Folder className="h-4 w-4 opacity-80" />
									Upload folder
								</Button>

								<Button
									variant="outline"
									size="sm"
									className="h-9 rounded-full bg-background/40 px-4"
									onClick={() => fetchEntries(currentPath)}
									disabled={isLoading}
								>
									<RefreshCw
										className={cn(
											"h-4 w-4 opacity-80",
											isLoading && "animate-spin",
										)}
									/>
									Refresh
								</Button>
							</div>
						</div>

						{/* biome-ignore lint/a11y/noStaticElementInteractions: This panel intentionally handles drag-and-drop file uploads. */}
						<div
							className={cn(
								"dash-bodypad space-y-4",
								isDropTargetActive &&
									"rounded-2xl border border-dashed border-primary/50 bg-primary/5",
							)}
							onDragOver={handleFileBrowserDragOver}
							onDragLeave={handleFileBrowserDragLeave}
							onDrop={(event) => {
								void handleFileBrowserDrop(event);
							}}
							onDragEnd={clearDropTarget}
							onDragExit={clearDropTarget}
						>
							<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								{breadcrumbs.map((crumb, index) => (
									<span key={crumb.path} className="flex items-center gap-2">
										<button
											type="button"
											className="rounded-lg px-2 py-1 transition hover:bg-background/40 hover:text-foreground/90"
											onClick={() => fetchEntries(crumb.path)}
										>
											{crumb.name}
										</button>
										{index < breadcrumbs.length - 1 ? <span>/</span> : null}
									</span>
								))}
							</div>

							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search files…"
								className="h-11 w-full rounded-2xl border border-border/70 bg-background/35 px-4 text-sm text-foreground/90 outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
							/>
							<div className="text-[11px] text-muted-foreground">
								Tip: drag and drop files or folders here to upload.
							</div>

							{error ? (
								<div className="dash-mutedbox text-destructive">{error}</div>
							) : null}

							{uploading ? (
								<div className="space-y-2">
									<div className="flex items-center justify-between text-[11px] text-muted-foreground">
										<span>
											{uploadProgress >= 100
												? `Finalizing ${uploadName ?? "file"}...`
												: `Uploading ${uploadName ?? "file"}...`}
										</span>
										<span>{uploadProgress}%</span>
									</div>
									<div className="h-2 w-full overflow-hidden rounded-full bg-background/35">
										<div
											className="h-full bg-primary transition-[width]"
											style={{ width: `${uploadProgress}%` }}
										/>
									</div>
								</div>
							) : null}

							<ScrollArea type="always" className="h-[560px] pr-3">
								<div className="flex flex-col gap-1.5">
									{filteredEntries.length === 0 && !isLoading ? (
										<div className="dash-mutedbox">
											{entries.length === 0
												? "No files found in this folder."
												: "No matches."}
										</div>
									) : null}

									{filteredEntries.map((entry) => (
										<div
											key={entry.path}
											className="dash-row"
											data-selected={selected?.path === entry.path}
										>
											<button
												type="button"
												className="flex min-w-0 flex-1 items-center gap-3 text-left"
												onClick={() => handleEntryClick(entry)}
											>
												{entry.type === "dir" ? (
													<Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
												) : (
													<FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
												)}
												<div className="min-w-0">
													<div className="truncate text-sm text-foreground/95">
														{entry.name}
													</div>
													<div className="text-[11px] text-muted-foreground">
														{entry.type === "dir"
															? "Folder"
															: formatSize(entry.size)}
														{" · "}
														{formatTimestamp(entry.mtime)}
													</div>
												</div>
											</button>

											<div className="flex items-center gap-2">
												<span className="dash-chip">{entry.type}</span>
												<Button
													variant="ghost"
													size="icon"
													className="h-8 w-8 rounded-full hover:bg-background/40"
													onClick={() => setDeleteTarget(entry)}
													aria-label={`Delete ${entry.name}`}
												>
													<Trash2 className="h-4 w-4 text-destructive" />
												</Button>
											</div>
										</div>
									))}
								</div>
							</ScrollArea>
						</div>
					</div>

					<aside className="dash-surface" aria-label="Preview">
						<div className="dash-panelhead">
							<div className="dash-paneltitle">Preview</div>
							{selected ? (
								<div className="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										className="h-9 rounded-full bg-background/40 px-4"
										onClick={handleCopySelected}
										disabled={copied}
									>
										{copied ? (
											<Check className="h-4 w-4 opacity-80" />
										) : (
											<Copy className="h-4 w-4 opacity-80" />
										)}
										{copied ? "Copied" : "Copy path"}
									</Button>
								</div>
							) : null}
						</div>

						<div className="dash-bodypad space-y-3">
							{selected ? (
								<>
									<div className="space-y-1">
										<div className="truncate text-sm text-foreground/95">
											{selected.name}
										</div>
										<div className="text-[11px] text-muted-foreground">
											<span className="text-foreground/80">/data</span>
											{selected.path}
										</div>
									</div>

									{selected.type === "dir" ? (
										<div className="dash-mutedbox">
											This is a folder. Open it to browse its contents.
										</div>
									) : previewLoading ? (
										<div className="dash-mutedbox">Loading preview…</div>
									) : previewError ? (
										<div className="dash-mutedbox text-destructive">
											{previewError}
										</div>
									) : (
										<ScrollArea className="h-[420px] rounded-2xl border border-border/70 bg-background/30">
											<pre className="whitespace-pre-wrap p-4 text-[12px] leading-relaxed text-foreground/90">
												{preview || "No preview available."}
											</pre>
										</ScrollArea>
									)}
								</>
							) : (
								<div className="dash-mutedbox">
									Select a file to preview its contents.
								</div>
							)}
						</div>
					</aside>
				</section>

				<AlertDialog
					open={Boolean(deleteTarget)}
					onOpenChange={() => setDeleteTarget(null)}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete item?</AlertDialogTitle>
							<AlertDialogDescription>
								{deleteTarget
									? `This will permanently remove ${deleteTarget.name}.`
									: "This action cannot be undone."}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={handleDelete}>
								Delete
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
			<footer className="pb-5 text-center text-xs text-muted-foreground">
				made with ❤️ by{" "}
				<a
					href="https://github.com/ThallesP"
					target="_blank"
					rel="noreferrer"
					className="underline-offset-4 hover:underline"
				>
					thallesp
				</a>
			</footer>
		</div>
	);
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
