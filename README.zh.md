# dsh-cc-switch-skills

[English](README.md) | 中文

DeepSeek Harness（DSH）插件：**启动 DSH 时自动加载 `C:\Users\<当前用户>\.cc-switch\skills` 目录里的所有 skill**，并监视该目录的增删改（无需重启）。

`~/.cc-switch/skills` 是 cc-switch（Claude Code 配置切换工具）保存 skill 的目录，每个 skill 是一个含 `SKILL.md` 的目录包。本插件把这些 skill 接入 DSH 的 `ctx.skills` 注册表，使其出现在会话的 skill 目录中，可通过 `skill` 工具按需加载。

## 功能

- **启动即加载**：插件行随 DSH 启动自动挂载，扫描一次目录并注册全部 skill。
- **两种 skill 形态**：目录包 `<name>/SKILL.md` 与平铺文件 `<name>.md`（只识别一层，不递归嵌套）。
- **YAML frontmatter 解析**（与 DSH 官方 `@deepseek-ai/dsh-skill-filesystem` 一致）：
  - `name`（kebab-case）、`description`（必填）；
  - 可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`；
  - `disable-model-invocation: true` → 模型不可自动调用；`user-invocable: false` → 不出现在面向用户的命令中。
- **正文按需加载**：目录只含元数据；每次调用 `skill` 都重读当前文件，编辑 `SKILL.md` 正文即时生效。
- **资源根**：`resourceBase` 指向 skill 所在目录，模型可按该目录解析 `scripts/`、`references/`、`assets/` 等资源。
- **热更新**：监视根目录（递归），新增 / 改名 / 删除 / 修改 frontmatter 在下一次目录刷新时生效；根目录暂不存在时会定时探测直至出现。
- **优先级**：注册 rank 为 300，与官方 `custom` skill 目录同级——项目级 skill（`<项目>/.dsh/skills`、`<项目>/.agents/skills`）重名时优先，用户级（`~/.dsh/skills`、`~/.agents/skills`）次之。

## 安装

先把本仓库克隆到本地并安装依赖：

```powershell
git clone https://github.com/artorias-zj/dsh-cc-switch-skills.git
cd dsh-cc-switch-skills
pnpm install   # 或 npm install，仅安装 yaml 依赖
```

再任选其一接入 DSH（下文以 `<路径>` 指代克隆目录的绝对路径）：

1. **DSH 内安装（推荐）**：在 DSH 对话中让 agent 执行 `plugin_manager` 的 `install_bundle`，目标为 `<路径>`；或在 Web 侧边栏「插件」页安装本地路径。
2. **手动安装**：把本包加入 profile 依赖并选中组合包——在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 中加入 `"dsh-cc-switch-skills": "link:<路径>"`，在 `dsh.profile.bundles` 列表末尾加入 `"dsh-cc-switch-skills"`，然后在 profile 目录执行 `pnpm install`。

> 注意：DSH 以 `link:` 方式引用本地目录，请保留克隆目录（含 `node_modules`）不要移动或删除。

安装完成后（在线 profile 立即生效，否则重启 DSH），skill 即出现在会话目录中。

## 配置

通过 `cordis.patch.yml` 中插入行的 `config` 字段配置（均为可选）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dir` | `<homedir>\.cc-switch\skills` | 扫描根目录；支持 `~/` 前缀；也可用环境变量 `DSH_CC_SWITCH_SKILLS_DIR` 覆盖 |
| `providerName` | `cc-switch` | 注册到 `ctx.skills` 的提供方名称（不得为保留名 `runtime`） |
| `rank` | `300` | 与其他提供方重名时的优先级，越小越优先 |
| `watch` | `true` | 是否监视目录变化并自动刷新 |

## 与官方提供方的差异

为了达成“加载**所有** skill”，frontmatter 不完整时比官方更宽容：

- 缺少 `name`（或名称不是合法 kebab-case）→ 回退到目录名 / 文件名并告警；
- 缺少 `description` → 回退到正文首个非空行摘要（截断 160 字符）并告警。

仍然跳过并告警的情况：YAML frontmatter 无效、缺少 frontmatter、调用策略布尔值非法（如 `user-invocable: maybe`）、名称回退后仍不合法。以上告警输出到 DSH 日志（`hub.log`）。

## 卸载

在 DSH 插件页移除，或用 `plugin_manager` 的 `remove_bundle`（目标 `dsh-cc-switch-skills`）。

## 许可

MIT
