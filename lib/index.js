/**
 * dsh-cc-switch-skills — Host 侧 skill 提供方插件。
 *
 * 启动 DSH 时扫描 `C:\Users\<当前用户>\.cc-switch\skills`（`<homedir>\.cc-switch\skills`，
 * 可用 `config.dir` 或 `$DSH_CC_SWITCH_SKILLS_DIR` 覆盖），把其中的 skill 注册进 `ctx.skills`：
 * 目录包 `<name>/SKILL.md` 与平铺文件 `<name>.md`（只识别一层）。
 *
 * 语义与官方本地提供方 `@deepseek-ai/dsh-skill-filesystem` 对齐：
 *   - YAML frontmatter 解析 `name`、`description`、`whenToUse`、`metadata`、
 *     `disable-model-invocation`、`user-invocable`；
 *   - `content` 是去掉 frontmatter 的正文，每次加载重读文件；
 *   - `resourceBase` 指向 skill 所在目录，供模型解析 `scripts/`、`references/` 等资源；
 *   - 监视根目录变化并失效缓存，新增/改名/删除无需重启。
 *
 * 差异（为“加载所有 skill”更宽容）：frontmatter 缺失或非法的 `name` 回退到目录名/文件名，
 * 缺失的 `description` 回退到正文首行摘要；其余非法输入仍跳过并告警。
 *
 * @module dsh-cc-switch-skills
 */
import { watch } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";

const name = "dsh-cc-switch-skills";
const inject = ["skills"];

/** 注册进 `ctx.skills` 的提供方名称（`runtime` 为保留名）。 */
const DEFAULT_PROVIDER_NAME = "cc-switch";
/** 候选项来源标签。 */
const SOURCE = "cc-switch";
/** 与官方 `custom` 根同级：项目级（100/200）优先，本目录次之，用户级（400/500）再次。 */
const DEFAULT_RANK = 300;
/** 默认扫描目录。 */
const DEFAULT_DIR = join(homedir(), ".cc-switch", "skills");
/** 覆盖默认目录的环境变量。 */
const ENV_DIR = "DSH_CC_SWITCH_SKILLS_DIR";
/** 目录缺失或 watcher 失效时的重试间隔（毫秒）。 */
const PROBE_INTERVAL_MS = 15000;
/** 变更事件合并窗口（毫秒）。 */
const DEBOUNCE_MS = 250;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function apply(ctx, config = {}) {
	const logger = ctx.logger;
	const dir = resolveSkillsDir(config);
	const providerName = configString(config.providerName) ?? DEFAULT_PROVIDER_NAME;
	const rank = Number.isFinite(config.rank) ? config.rank : DEFAULT_RANK;

	ctx.skills.registerProvider((control) => {
		const observe = config.watch === false ? undefined : createRootWatcher(dir, control.invalidate, control.signal);
		return {
			name: providerName,
			/** 发现根目录的一层 skill 条目；根目录缺失视为有效的空目录。 */
			async list() {
				observe?.();
				return await discoverRoot(dir, providerName, rank, logger);
			},
			/** 按候选项 locator 重读正文；文件已消失时返回 undefined。 */
			async get(candidate, lookup = {}) {
				const locator = candidate?.locator;
				if (locator === undefined || typeof locator.path !== "string") return undefined;
				const parsed = await parseSkillFile(locator, logger, lookup.signal);
				return parsed === undefined ? undefined : {
					...skillSummary(parsed, locator),
					source: SOURCE,
					provider: providerName,
					content: parsed.content
				};
			}
		};
	});
	logger?.info(`dsh-cc-switch-skills: 已注册 skill 提供方 "${providerName}"，扫描目录 ${dir}`);
}

/** 解析 skill 根目录：`config.dir` > `$DSH_CC_SWITCH_SKILLS_DIR` > `<homedir>\.cc-switch\skills`；支持 `~/` 前缀。 */
function resolveSkillsDir(config) {
	const raw = configString(config.dir) ?? process.env[ENV_DIR] ?? DEFAULT_DIR;
	const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1).replace(/^[\\/]+/, "")) : raw;
	return resolve(expanded);
}

function configString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 扫描根目录的一层条目，产出注册表候选项。 */
async function discoverRoot(dir, providerName, rank, logger) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (!isAbsentError(error)) logger?.warn(`dsh-cc-switch-skills: 扫描 ${dir} 失败: ${String(error)}`);
		return [];
	}
	const skills = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".")) continue;
		const fullPath = join(dir, entry.name);
		const locator = entry.isDirectory()
			? { path: join(fullPath, "SKILL.md"), directory: fullPath, fallbackName: entry.name }
			: entry.isFile() && entry.name.endsWith(".md")
				? { path: fullPath, directory: dir, fallbackName: basename(entry.name, ".md") }
				: undefined;
		if (locator === undefined) continue;
		let parsed;
		try {
			parsed = await parseSkillFile(locator, logger);
		} catch (error) {
			logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}: ${String(error)}`);
			continue;
		}
		if (parsed === undefined) continue;
		skills.push({ ...skillSummary(parsed, locator), provider: providerName, source: SOURCE, rank, locator });
	}
	return skills;
}

/** 候选项与定义共享的摘要字段。 */
function skillSummary(parsed, locator) {
	return {
		name: parsed.name,
		description: parsed.description,
		...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
		invocation: parsed.invocation,
		resourceBase: { kind: "directory", path: locator.directory },
		path: parsed.path,
		...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}
	};
}

/**
 * 读取并解析一个 skill 文件；缺失或无效时返回 undefined（已告警）。
 * `locator.fallbackName` 是发现时算好的名称回退值（目录名或去扩展名的文件名）。
 */
async function parseSkillFile(locator, logger, signal) {
	const raw = await readSkillText(locator.path, signal);
	if (raw === undefined) return undefined;
	let parsed;
	try {
		parsed = parseFrontmatter(raw.content);
	} catch (error) {
		logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：YAML frontmatter 无效：${String(error)}`);
		return undefined;
	}
	if (parsed === undefined) {
		logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：缺少 YAML frontmatter`);
		return undefined;
	}
	const declared = stringField(parsed.data, "name");
	const fallback = isSkillName(locator.fallbackName) ? locator.fallbackName : undefined;
	const skillName = declared !== undefined && isSkillName(declared) ? declared : fallback;
	if (skillName === undefined) {
		logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：name ${declared === undefined ? "缺失" : `"${declared}" 非法`}，且无法回退到目录名/文件名`);
		return undefined;
	}
	if (skillName !== declared) {
		logger?.warn(`dsh-cc-switch-skills: ${locator.path} 的 name ${declared === undefined ? "缺失" : `"${declared}" 非法`}，改用 "${skillName}"`);
	}
	let description = stringField(parsed.data, "description");
	if (description === undefined) {
		description = firstBodyLine(parsed.body);
		if (description === undefined) {
			logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：description 缺失，且正文为空无法回退`);
			return undefined;
		}
		logger?.warn(`dsh-cc-switch-skills: ${locator.path} 缺少 description，改用正文首行摘要`);
	}
	let invocation;
	try {
		invocation = parseInvocationPolicy(parsed.data);
	} catch (error) {
		logger?.warn(`dsh-cc-switch-skills: 跳过 ${locator.path}：调用策略无效：${String(error)}`);
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

/** 正文首个非空行的摘要，截断到 160 字符。 */
function firstBodyLine(body) {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
	}
	return undefined;
}

/** 读取 skill 文本并解析真实路径；缺失或非文本返回 undefined。 */
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
	return {
		modelInvocable: frontmatterBoolean(data, "disable-model-invocation") !== true,
		userInvocable: frontmatterBoolean(data, "user-invocable") !== false
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

function isSkillName(value) {
	return typeof value === "string" && SKILL_NAME.test(value);
}

function isAbsentError(error) {
	return typeof error === "object" && error !== null && "code" in error
		&& (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * 监视 skill 根目录：递归 watcher 监听增删改，事件合并成一次失效；
 * 目录缺失或 watcher 失效时按 `PROBE_INTERVAL_MS` 重试。返回挂载函数（`list()` 可重试），
 * 全部句柄随 signal 中止而释放。
 */
function createRootWatcher(dir, invalidate, signal) {
	let fsWatcher;
	let probeTimer;
	let debounceTimer;
	let disposed = false;

	function scheduleInvalidation() {
		if (disposed) return;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			if (!disposed) invalidate();
		}, DEBOUNCE_MS);
	}

	function closeWatcher() {
		try {
			fsWatcher?.close();
		} catch {
			/* 已关闭的 watcher 忽略。 */
		}
		fsWatcher = undefined;
	}

	function attach() {
		if (disposed || fsWatcher !== undefined) return;
		try {
			fsWatcher = watch(dir, { recursive: true }, scheduleInvalidation);
		} catch {
			startProbe();
			return;
		}
		fsWatcher.on("error", () => {
			closeWatcher();
			startProbe();
		});
		clearInterval(probeTimer);
		probeTimer = undefined;
		scheduleInvalidation();
	}

	function startProbe() {
		if (disposed || probeTimer !== undefined) return;
		probeTimer = setInterval(attach, PROBE_INTERVAL_MS);
	}

	signal?.addEventListener("abort", () => {
		disposed = true;
		clearTimeout(debounceTimer);
		clearInterval(probeTimer);
		closeWatcher();
	}, { once: true });

	attach();
	return attach;
}

export { apply, inject, name };
