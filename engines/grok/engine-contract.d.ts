/**
 * AgentHippo Custom Engine V2 Contract
 *
 * Copy this file next to your engine.mjs for TypeScript type support.
 * Zero dependencies - no AgentHippo packages required.
 */

export interface AgentPermissions {
	fileAccess: 'read-only' | 'workspace-write' | 'full';
}

export interface CustomEngineTurn {
	message: string;
	modelId: string;
	workspaceRoot: string;
	additionalDirectories: string[];
	permissions: AgentPermissions;
	env: Record<string, string>;
	routing: {
		useLiteLLM: boolean;
		apiKey?: string;
		baseUrl?: string;
		openaiBaseUrl?: string;
	};

	session: {
		key: string;
		chatSessionId: string;
		contextSessionId: string;
		isEphemeral: boolean;
		engineHomeDir: string;
		engineSessionDir: string;
		nativeSessionId?: string;
		contextFilePath?: string;
		terminalLogPath?: string;
		attachmentsDir?: string;
	};

	agent: {
		id: string;
		version?: string;
		rulesFilePath?: string;
		skillsDir?: string;
		rulesDir?: string;
	};

	emitter: Emitter;
	runtime: Runtime;
	signal?: AbortSignal;
}

export interface CustomEngineTurnResult {
	nativeSessionId?: string;
}

export interface Emitter {
	text(delta: string): Promise<void>;
	thinking(delta: string): Promise<void>;
	toolStart(toolName: string, input?: string, toolCallId?: string): Promise<void>;
	toolEnd(toolName: string, toolCallId: string, result?: string, isError?: boolean): Promise<void>;
	progress(message: string): Promise<void>;
	question(payload: QuestionPayload): Promise<QuestionAnswer>;
	error(message: string): Promise<void>;
	done(): Promise<void>;
}

export interface QuestionPayload {
	questionId: string;
	prompt: string;
	options?: Array<{ label: string; description?: string; recommended?: boolean }>;
	multiSelect?: boolean;
	allowFreeText?: boolean;
}

export interface QuestionAnswer {
	selected: string[];
	freeText: string | null;
	declined?: boolean;
	timedOut?: boolean;
	cancelled?: boolean;
}

export interface Runtime {
	logger: {
		info(msg: string): void;
		warn(msg: string): void;
		error(msg: string): void;
		debug(msg: string): void;
	};
}

export interface AgentEngine {
	run(turn: CustomEngineTurn): Promise<void | CustomEngineTurnResult>;
	onMaintenance?(logger: Runtime['logger']): void;
	dispose?(): void;
}
