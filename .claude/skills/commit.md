# 提交推送技能

提交当前会话修改的代码并推送到远程仓库。

## 执行步骤

### 1. 检查变更范围
- 运行 `git status` 查看当前仓库的变更
- 如涉及跨仓库（如改了 `xxx-api` 同时有其他下游仓库引用），**主动提醒**用户是否需要一起提交
- 如有前端仓库关联变更，同样提醒

### 2. 查看提交历史
- 运行 `git log --oneline -5` 了解最近的提交风格

### 3. 生成提交信息
- 使用中文 conventional commit 格式
- 格式：`type(scope): 描述`
- type: feat/fix/refactor/perf/docs/chore/ci/test
- 描述应简洁准确，说明"做了什么"而非"改了哪些文件"
- 多行说明放在 body，用空行分隔

### 4. 提交并推送
- `git add` 仅添加相关变更文件（**不要**用 `git add .` 或 `git add -A`）
- 不要提交 `.env` / credentials / 大型二进制文件
- `git commit` 使用上一步生成的提交信息；末尾追加：

```
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

- `git push` 到当前分支（遵循分支策略：feature/* → develop → release → main）
- 如有关联前端/下游仓库变更，同样执行提交推送

### 5. 报告结果
- 展示提交的仓库、分支、commit hash
- 如有关联仓库未提交，给出提醒
