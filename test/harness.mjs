/**
 * dsh-cc-switch-skills 自测脚本（不随插件包发布）。
 * 运行：node test/harness.mjs
 * 覆盖：真实 .cc-switch/skills 目录发现、get() 加载、frontmatter 回退/拒绝、平铺文件、监视失效。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../lib/index.js";

let failures = 0;
function check(label, condition, detail = "") {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures += 1;
		console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function stubContext() {
	const registered = [];
	const logs = { info: [], warn: [] };
	const ctx = {
		logger: {
			info: (m) => logs.info.push(String(m)),
			warn: (m) => logs.warn.push(String(m))
		},
		skills: {
			registerProvider(create) {
				const provider = create({ signal: new AbortController().signal, invalidate: () => {} });
				registered.push(provider);
				return () => {};
			}
		}
	};
	return { ctx, registered, logs };
}

console.log("== 插件元数据 ==");
check("name", name === "dsh-cc-switch-skills");
check("inject 含 skills", inject.includes("skills"));

console.log("== 真实 .cc-switch/skills 目录 ==");
{
	const { ctx, registered, logs } = stubContext();
	apply(ctx, {});
	check("注册了 1 个提供方", registered.length === 1);
	const provider = registered[0];
	check("提供方名 cc-switch", provider.name === "cc-switch");
	const candidates = await provider.list();
	console.log(`  发现 ${candidates.length} 个 skill: ${candidates.map((c) => c.name).join(", ")}`);
	check("发现数量 >= 9", candidates.length >= 9, `实际 ${candidates.length}`);
	const expected = ["brainstorming", "docx", "drawio-skill", "guizang-ppt-skill", "karpathy-guidelines", "pdf", "pptx", "storage-analyzer", "xlsx"];
	for (const want of expected) check(`包含 ${want}`, candidates.some((c) => c.name === want));
	for (const c of candidates) {
		check(`${c.name}: provider/source/rank`, c.provider === "cc-switch" && c.source === "cc-switch" && c.rank === 300);
		check(`${c.name}: invocation 为布尔对`, typeof c.invocation?.modelInvocable === "boolean" && typeof c.invocation?.userInvocable === "boolean");
		check(`${c.name}: resourceBase 指向目录`, c.resourceBase?.kind === "directory" && typeof c.resourceBase?.path === "string");
		check(`${c.name}: description 非空`, typeof c.description === "string" && c.description.length > 0);
		const def = await provider.get(c);
		check(`${c.name}: get() 返回正文`, typeof def?.content === "string" && def.content.length > 0);
		check(`${c.name}: 定义与候选同名`, def?.name === c.name);
		check(`${c.name}: 定义含 source/provider/path`, def?.source === "cc-switch" && def?.provider === "cc-switch" && typeof def?.path === "string");
		check(`${c.name}: 正文不含 frontmatter 分隔符`, !def.content.startsWith("---"));
	}
	const drawio = candidates.find((c) => c.name === "drawio-skill");
	check("drawio-skill 遵守 disable-model-invocation", drawio?.invocation?.modelInvocable === false && drawio?.invocation?.userInvocable === true, JSON.stringify(drawio?.invocation));
	check("storage-analyzer 折叠 description 解析成功", (candidates.find((c) => c.name === "storage-analyzer")?.description ?? "").includes("存储"), candidates.find((c) => c.name === "storage-analyzer")?.description?.slice(0, 40));
	check("drawio-skill metadata 透传", typeof candidates.find((c) => c.name === "drawio-skill")?.metadata === "object");
	for (const w of logs.warn) console.log(`  warn: ${w}`);
}

console.log("== 合成目录：回退与拒绝 ==");
{
	const root = await mkdtemp(join(tmpdir(), "cc-switch-skills-test-"));
	try {
		await mkdir(join(root, "no-name"));
		await writeFile(join(root, "no-name", "SKILL.md"), "---\ndescription: 目录名回退\n---\n正文 A\n", "utf8");
		await mkdir(join(root, "bad-name"));
		await writeFile(join(root, "bad-name", "SKILL.md"), "---\nname: Bad_Name\ndescription: 名称回退\n---\n正文 B\n", "utf8");
		await writeFile(join(root, "flat-skill.md"), "---\nname: flat-skill\ndescription: 平铺文件\n---\n正文 C\n", "utf8");
		await mkdir(join(root, "no-description"));
		await writeFile(join(root, "no-description", "SKILL.md"), "---\nname: no-description\n---\n正文首行摘要\n第二行\n", "utf8");
		await mkdir(join(root, "bad-yaml"));
		await writeFile(join(root, "bad-yaml", "SKILL.md"), "---\nname: [未闭合\n---\n正文\n", "utf8");
		await mkdir(join(root, "no-frontmatter"));
		await writeFile(join(root, "no-frontmatter", "SKILL.md"), "没有 frontmatter\n", "utf8");
		await mkdir(join(root, "bad-invocation"));
		await writeFile(join(root, "bad-invocation", "SKILL.md"), "---\nname: bad-invocation\ndescription: x\nuser-invocable: maybe\n---\n正文\n", "utf8");
		await mkdir(join(root, "user-only"));
		await writeFile(join(root, "user-only", "SKILL.md"), "---\nname: user-only\ndescription: x\nuser-invocable: false\n---\n正文\n", "utf8");
		await mkdir(join(root, ".hidden"));
		await writeFile(join(root, ".hidden", "SKILL.md"), "---\nname: hidden\ndescription: x\n---\n正文\n", "utf8");

		const { ctx, registered, logs } = stubContext();
		apply(ctx, { dir: root, watch: false });
		const provider = registered[0];
		const candidates = await provider.list();
		const names = candidates.map((c) => c.name).sort();
		console.log(`  合成目录发现: ${names.join(", ")}`);
		check("no-name 回退目录名", names.includes("no-name"));
		check("bad-name 回退目录名", names.includes("bad-name"));
		check("flat-skill 平铺文件", names.includes("flat-skill"));
		check("no-description 回退正文首行", names.includes("no-description"));
		const noDesc = candidates.find((c) => c.name === "no-description");
		check("no-description 描述=正文首行", noDesc?.description === "正文首行摘要", noDesc?.description);
		check("bad-yaml 被跳过", !names.includes("bad-yaml"));
		check("no-frontmatter 被跳过", !names.includes("no-frontmatter"));
		check("bad-invocation 被跳过", !names.includes("bad-invocation"));
		check("user-only 保留且 userInvocable=false", candidates.find((c) => c.name === "user-only")?.invocation?.userInvocable === false);
		check(".hidden 被跳过", !names.includes("hidden"));
		const flat = await provider.get(candidates.find((c) => c.name === "flat-skill"));
		check("平铺 get() 正文", flat?.content === "正文 C", flat?.content);
		check("平铺 resourceBase=根目录", flat?.resourceBase?.path === root, flat?.resourceBase?.path);
		const bundle = await provider.get(candidates.find((c) => c.name === "no-name"));
		check("目录包 resourceBase=目录包目录", bundle?.resourceBase?.path === join(root, "no-name"), bundle?.resourceBase?.path);
		check("告警有输出", logs.warn.length > 0);
		for (const w of logs.warn) console.log(`  warn: ${w}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

console.log("== 监视失效 ==");
{
	const root = await mkdtemp(join(tmpdir(), "cc-switch-skills-watch-"));
	try {
		const { ctx, registered } = stubContext();
		let invalidated = 0;
		ctx.skills.registerProvider = (create) => {
			const provider = create({ signal: new AbortController().signal, invalidate: () => { invalidated += 1; } });
			registered.push(provider);
			return () => {};
		};
		apply(ctx, { dir: root });
		await registered[0].list();
		await writeFile(join(root, "new-skill.md"), "---\nname: new-skill\ndescription: x\n---\n正文\n", "utf8");
		await new Promise((r) => setTimeout(r, 1200));
		check("新增文件触发失效", invalidated > 0, `invalidated=${invalidated}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
