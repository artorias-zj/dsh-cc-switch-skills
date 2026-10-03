/**
 * dsh-cc-switch-skills — Host 侧 skill 提供方插件。
 *
 * 启动 DSH 时扫描 `C:\Users\<当前用户>\.cc-switch\skills`（即 `<homedir>\.cc-switch\skills`，
 * 可用配置或环境变量覆盖），把其中的 skill 注册进 `ctx.skills` 注册表：
 *
 *   - 目录包 `<name>/SKILL.md`（如 `docx/`、`drawio-skill/`）；
 *   - 平铺文件 `<name>.md`。
 *
 * 语义与官方本地提供方 `@deepseek-ai/dsh-skill-filesystem` 对齐：
 *   - YAML frontmatter 解析 `name`、`description`、`whenToUse`、`metadata`、
 *     `disable-model-invocation`、`user-invocable`；
 *   - `content` 是去掉 frontmatter 后的正文（每次加载时重读文件）；
 *   - `resourceBase` 指向 skill 所在目录，模型可据此解析 `scripts/`、`references/` 等资源；
 *   - 监视目录变化并失效缓存，新增/改名/删除无需重启 DSH。
 *
 * 与官方提供方的差异（为了“加载所有 skill”这个目标更宽容）：
 *   - frontmatter 缺少 `name` 时回退到目录名/文件名；名称不合法时同样回退并告警；
 *   - frontmatter 缺少 `description` 时回退到正文首行摘要。
 * 其余校验（非法 YAML、非法调用布尔值、非法 kebab-case 名称无法回退）仍跳过并告警。
 *
 * @module dsh-cc-switch-skills
 */
import { watch } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { parse } from "yaml";

const name = "dsh-cc-switch-skills";
const inject = ["skills"];

/** 注册进 `ctx.skills` 的提供方名称（同一层内须唯一，`runtime` 为保留名）。 */
const DEFAULT_PROVIDER_NAME = "cc-switch";
/** 目录条目的来源标签，出现在摘要与日志中。 */
const SOURCE = "cc-switch";
/** 与官方 `custom` skill 根同级：项目级 skill（100/200）优先，本目录（300）次之，用户级（400/500）再次。 */
const DEFAULT_RANK = 300;
/** 默认扫描目录：`<homedir>\.cc-switch\skills`。 */
const DEFAULT_DIR = join(homedir(), ".cc-switch", "skills");
/** 环境变量覆盖默认目录。 */
const ENV_DIR = "DSH_CC_SWITCH_SKILLS_DIR";
/** 目录不存在时的探测间隔（毫秒）。 */
const PROBE_INTERVAL_MS = 15000;
/** 变更事件合并窗口（毫秒）。 */
const DEBOUNCE_MS = 250;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 与官方一致的 kebab-case skill 名称判定。 */
function isSkillName(value) {
	return typeof value === "string" && SKILL_NAME.test(value);
}

function apply(ctx, config = {}) {
	const logger = ctx.logger;
	const dir = resolveSkillsDir(config);
	const providerName = typeof config.providerName === "string" && config.providerName.trim() !== ""
		? config.providerName.trim()
		: DEFAULT_PROVIDER_NAME;
	const rank = Number.isFinite(config.rank) ? config.rank : DEFAULT_RANK;
	const watchEnabled = config.watch !== false;

	ctx.skills.registerProvider((control) => {
		const watcher = watchEnabled ? createRootWatcher(dir, control.invalidate, logger, control.signal) : undefined;
		return createProvider(ctx, { dir, providerName, rank, logger, observe: watcher?.observe });
	});
	logger?.info(`dsh-cc-switch-skills: 已注册 skill 提供方 "${providerName}"，扫描目录 ${dir}`);
}

/**
 * 解析 skill 根目录：`config.dir` > `$DSH_CC_SWITCH_SKILLS_DIR` > `<homedir>\.cc-switch\skills`。
 * 配置值支持 `~/` 前缀；相对路径按当前工作目录解析。
 */
function resolveSkillsDir(config) {
	const raw = typeof config.dir === "string" && config.dir.trim() !== "" ? config.dir.trim() : process.env[ENV_DIR] ?? DEFAULT_DIR;
	const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1).replace(/^[\\/]+/, "")) : raw;
	return resolve(expanded);
}

/** 一个只读 skill 提供方：`list()` 发现目录条目，`get()` 每次重读正文。 */
function createProvider(ctx, options) {
	const { dir, providerName, rank, logger, observe } = options;
	return {
		name: providerName,
		/**
		 * 发现根目录下的一层 skill 条目。
		 * @returns 候选项数组；根目录不存在视为有效的空目录。
		 */
		async list() {
			try {
				observe?.();
			} catch (error) {
				logger?.warn(`dsh-cc-switch-skills: 监视启动失败，目录变化需重启后可见: ${errorMessage(error)}`);
			}
			return await discoverRoot(dir, providerName, rank, logger);
		},
		/**
		 * 按候选项的 locator 重读并解析 skill 正文。
		 * @returns 完整定义，或文件已消失时返回 `undefined`。
		 */
		async get(candidate, lookupOptions = {}) {
			const locator = candidate?.locator;
			if (locator === undefined || typeof locator.path !== "string") return undefined;
			const parsed = await parseSkillFile(locator, logger, lookupOptions.signal);
			if (parsed === undefined) return undefined;
			return {
				name: parsed.name,
				description: parsed.description,
				...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
				invocation: parsed.invocation,
				source: SOURCE,
				provider: providerName,
				resourceBase: {
					kind: "directory",
					path: locator.directory
				},
				path: parsed.path,
				...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {},
				content: parsed.content
			};
		}
	};
}

/** 扫描根目录的一层条目，产出注册表候选项。 */
async function discoverRoot(dir, providerName, rank, logger) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isAbsentError(error)) return [];
		logger?.warn(`dsh-cc-switch-skills: 扫描 ${dir} 失败: ${errorMessage(error)}`);
		return [];
	}
	const skills = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".")) continue;
		const locator = entry.isDirectory()
			? { path: join(dir, entry.name, "SKILL.md"), directory: join(dir, entry.name) }
			: entry.isFile() && entry.name.toLowerCase().endsWith(".md")
				? { path: join(dir, entry.name), directory: dir }
				: undefined;
		if (locator === undefined) continue;
		const parsed = await parseSkillFile(locator, logger);
		if (parsed === undefined) continue;
		skills.push({
			name: parsed.name,
			description: parsed.description,
			...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
			invocation: parsed.invocation,
			provider: providerName,
			source: SOURCE,
			rank,
			locator,
			resourceBase: {
				kind: "directory",
				path: locator.directory
			},
			path: parsed.path,
			...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}
		});
	}
	return skills;
}

/**
 * 读取并解析一个 skill 文件。返回 undefined 表示文件缺失或无效（已告警）。
 * 结果含 kebab-case 名称、描述、调用策略、资源元数据、解析后的指令文件路径与正文。
 */
async function parseSkillFile(locator, logger, signal) {
	const raw = await readSkillText(locator.path, signal);
	if (raw === undefined) return undefined;
	let parsed;
	try {
		parsed = parseFrontmatter(raw.content);
	} catch (error) {
		logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：YAML frontmatter 无效：${errorMessage(error)}`);
		return undefined;
	}
	if (parsed === undefined) {
		logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：缺少 YAML frontmatter`);
		return undefined;
	}
	const fallbackName = skillFallbackName(locator);
	const parsedName = stringField(parsed.data, "name");
	let skillName;
	if (parsedName !== undefined && isSkillName(parsedName)) {
		skillName = parsedName;
	} else {
		skillName = fallbackName;
		if (skillName === undefined) {
			logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：frontmatter name 无效${parsedName === undefined ? "（缺失）" : `（"${parsedName}"）`}，且无法回退到目录名/文件名`);
			return undefined;
		}
		if (parsedName !== undefined) logger?.warn(`dsh-cc-switch-skills: ${locator.path} 的 frontmatter name "${parsedName}" 不是合法 kebab-case，改用 "${skillName}"`);
		else logger?.warn(`dsh-cc-switch-skills: ${locator.path} 缺少 frontmatter name，改用 "${skillName}"`);
	}
	let description = stringField(parsed.data, "description");
	if (description === undefined) {
		description = firstBodyLine(parsed.body);
		if (description === undefined) {
			logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：frontmatter description 无效（缺失），且正文为空无法回退`);
			return undefined;
		}
		logger?.warn(`dsh-cc-switch-skills: ${locator.path} 缺少 frontmatter description，改用正文首行摘要`);
	}
	let invocation;
	try {
		invocation = parseInvocationPolicy(parsed.data);
	} catch (error) {
		logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：调用策略 frontmatter 无效：${errorMessage(error)}`);
		return undefined;
	}
	return {
		name: skillName,
		description,
		...optionalString(parsed.data, "whenToUse"),
		invocation,
		...optionalMetadata(parsed.data),
		path: raw.path,
		content: parsed.body.trim()
	};
}

/** 目录包以目录名回退，平铺文件以去扩展名的文件名回退。 */
function skillFallbackName(locator) {
	const base = basename(locator.path, extname(locator.path));
	const candidate = base === "SKILL" ? basename(locator.directory) : base;
	return isSkillName(candidate) ? candidate : undefined;
}

/** 正文首个非空行的摘要，截断到 160 字符。 */
function firstBodyLine(body) {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
	}
	return undefined;
}

/** 读取 skill 文本并解析出真实路径；缺失或非文本返回 undefined。 */
async function readSkillText(path, signal) {
	try {
		const resolvedPath = await realpath(path);
		const content = await readFile(resolvedPath, { encoding: "utf8", signal });
		return { path: resolvedPath, content };
	} catch (error) {
		if (signal?.aborted === true) throw error;
		if (isAbsentError(error) || error?.code === "EISDIR") return undefined;
		throw error;
	}
}

/** 解析 `---` 包裹的 YAML frontmatter，返回数据与正文。 */
function parseFrontmatter(raw) {
	const firstLineEnd = raw.indexOf("\n");
	if (firstLineEnd < 0) return undefined;
	if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return undefined;
	const start = firstLineEnd + 1;
	const closing = findClosingFrontmatter(raw, start);
	if (closing === undefined) return undefined;
	const parsed = parse(raw.slice(start, closing.start));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	return { data: parsed, body: raw.slice(closing.bodyStart) };
}

function findClosingFrontmatter(raw, start) {
	let lineStart = start;
	while (lineStart <= raw.length) {
		const nextNewline = raw.indexOf("\n", lineStart);
		const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
			return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
		}
		if (nextNewline < 0) return undefined;
		lineStart = nextNewline + 1;
	}
}

/** 与官方一致的调用策略解析：`disable-model-invocation` 与 `user-invocable` 严格布尔值。 */
function parseInvocationPolicy(data) {
	rejectLegacyInvocationKey(data, "disableModelInvocation", "disable-model-invocation");
	rejectLegacyInvocationKey(data, "modelInvocable", "disable-model-invocation");
	rejectLegacyInvocationKey(data, "userInvocable", "user-invocable");
	const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
	const userInvocable = frontmatterBoolean(data, "user-invocable");
	return {
		modelInvocable: disableModelInvocation !== true,
		userInvocable: userInvocable !== false
	};
}

function rejectLegacyInvocationKey(data, legacy, canonical) {
	if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter 字段 "${legacy}" 不受支持，请改用 "${canonical}"`);
}

function frontmatterBoolean(data, key) {
	if (!Object.hasOwn(data, key)) return undefined;
	const value = data[key];
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1") return true;
	if (value === 0 || value === "0") return false;
	if (typeof value === "string") {
		switch (value.toLowerCase()) {
			case "true":
			case "yes":
			case "on": return true;
			case "false":
			case "no":
			case "off": return false;
		}
	}
	throw new TypeError(`frontmatter 字段 "${key}" 必须是布尔值`);
}

function stringField(data, key) {
	const value = data[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalString(data, key) {
	const value = stringField(data, key);
	return value !== undefined ? { [key]: value } : {};
}

function optionalMetadata(data) {
	const value = data.metadata;
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return { metadata: value };
	return {};
}

function isAbsentError(error) {
	return typeof error === "object" && error !== null && "code" in error
		&& (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function errorMessage(error) {
	try {
		return String(error);
	} catch {
		return "[unrenderable thrown value]";
	}
}

/**
 * 监视 skill 根目录：递归 watcher 监听一层 skill 的增删改，微任务批次合并成一次失效。
 * 根目录尚不存在时退化为定时探测，出现后再挂载 watcher。所有句柄随 signal 中止而释放。
 */
function createRootWatcher(dir, invalidate, logger, signal) {
	let closed = false;
	let fsWatcher;
	let probeTimer;
	let debounceTimer;

	function dispose() {
		closed = true;
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		if (probeTimer !== undefined) clearInterval(probeTimer);
		try {
			fsWatcher?.close();
		} catch {
			/* 已关闭的 watcher 忽略。 */
		}
		fsWatcher = undefined;
	}

	function scheduleInvalidation() {
		if (closed) return;
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			if (!closed) invalidate();
		}, DEBOUNCE_MS);
	}

	function detach() {
		try {
			fsWatcher?.close();
		} catch {
			/* 已关闭的 watcher 忽略。 */
		}
		fsWatcher = undefined;
	}

	function attach() {
		if (closed || fsWatcher !== undefined) return;
		try {
			fsWatcher = watch(dir, { recursive: true }, scheduleInvalidation);
			fsWatcher.on("error", () => {
				detach();
				startProbe();
			});
			if (probeTimer !== undefined) {
				clearInterval(probeTimer);
				probeTimer = undefined;
			}
		} catch {
			// 平台不支持递归监视或目录暂不可读：退化为逐层探测。
			try {
				fsWatcher = watch(dir, scheduleInvalidation);
				fsWatcher.on("error", () => {
					detach();
					startProbe();
				});
			} catch {
				startProbe();
			}
		}
	}

	function startProbe() {
		if (closed || probeTimer !== undefined) return;
		probeTimer = setInterval(async () => {
			if (closed) return;
			try {
				await stat(dir);
				attach();
				scheduleInvalidation();
			} catch {
				/* 目录仍不存在，继续探测。 */
			}
		}, PROBE_INTERVAL_MS);
	}

	function observe() {
		attach();
	}

	signal?.addEventListener("abort", dispose, { once: true });
	observe();
	return { observe, dispose };
}

export { apply, createProvider, createRootWatcher, inject, name, parseFrontmatter, parseInvocationPolicy, parseSkillFile };
